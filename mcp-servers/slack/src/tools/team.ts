/**
 * Team tools: create, register, send, status, broadcast, read, wait, thread, close, report.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SlackMessage, TeamMember } from "../types.js";
import { SLACK_DEFAULT_CHANNEL, PERSONA_NAME_TO_ROLE, AGENT_PERSONAS } from "../types.js";
import { db, stmts, saveAgentContext, getTeamTasks, updateTaskStatus, inboxGetUnread, inboxIngest, setChannelCursor, pushMentionQueue, getAgentStoredChannelId, getPendingPermissions } from "../db.js";
import {
  teams, getTeam, resolveChannel, resolveTeamId,
  getRoleIcon, agentIdentity, formatTeamStatus,
  saveTeamsToState, saveTeamById, teamNameSafe, ensureTeamsLoaded,
} from "../state.js";
import { slack, resolveBotUserId, sendSmart, sleep } from "../slack-client.js";
import { formatMessages, getTeamWorkflowInstructions } from "../formatting.js";

/**
 * Resolve @mention targets to member IDs.
 * Accepts: member ID ("implementer-A"), role ("planner"), or persona name ("@Sage", "Sage").
 * Returns: { resolvedMemberIds: string[], displayNames: string[] }
 */
function resolvePersonaMentions(
  mentions: string[],
  teamMembers: Map<string, TeamMember>,
): { resolvedIds: string[]; displayTags: string[] } {
  const resolvedIds: string[] = [];
  const displayTags: string[] = [];

  for (const raw of mentions) {
    const name = raw.replace(/^@/, "").trim();
    const nameLower = name.toLowerCase();

    // 1. Exact member ID match (e.g., "implementer-A")
    if (teamMembers.has(name)) {
      const persona = AGENT_PERSONAS[teamMembers.get(name)!.role];
      displayTags.push(`*@${persona?.displayName || name}*`);
      resolvedIds.push(name);
      continue;
    }

    // 2. Persona display name → role → find member with that role
    const role = PERSONA_NAME_TO_ROLE[nameLower];
    if (role) {
      const found = [...teamMembers.entries()].find(([, m]) => m.role === role);
      if (found) {
        const persona = AGENT_PERSONAS[role];
        displayTags.push(`*@${persona?.displayName || name}*`);
        resolvedIds.push(found[0]);
        continue;
      }
    }

    // 3. Role name match (e.g., "planner", "implementer")
    const byRole = [...teamMembers.entries()].find(([, m]) => m.role === name || m.role === nameLower);
    if (byRole) {
      const persona = AGENT_PERSONAS[byRole[1].role];
      displayTags.push(`*@${persona?.displayName || name}*`);
      resolvedIds.push(byRole[0]);
      continue;
    }

    // 4. Partial match on member ID prefix
    const byPrefix = [...teamMembers.entries()].find(([id]) => id.startsWith(nameLower));
    if (byPrefix) {
      const persona = AGENT_PERSONAS[byPrefix[1].role];
      displayTags.push(`*@${persona?.displayName || name}*`);
      resolvedIds.push(byPrefix[0]);
      continue;
    }

    // Fallback: use raw name
    displayTags.push(`*@${name}*`);
    resolvedIds.push(name);
  }

  return { resolvedIds, displayTags };
}

export function registerTeamTools(server: McpServer): void {

  // ── slack_team_create ────────────────────────────────────────

  server.tool(
    "slack_team_create",
    "에이전트 팀 전용 Slack 채널을 생성하고 초기 멤버를 등록합니다. spawn-team 시작 시 호출.",
    {
      team_id: z.string().describe("팀 식별자 (예: T12, B-6)"),
      team_name: z.string().describe("팀 목표/이름 (예: Feature X 구현, 버그 수정)"),
      channel_name: z.string().optional().describe("생성할 채널 이름 (미지정 시 team-{team_id} 자동 생성). 소문자, 하이픈만 허용."),
      is_private: z.boolean().default(false).describe("true 시 비공개 채널로 생성 (기본: 공개)"),
      members: z.array(z.object({
        id: z.string().describe("멤버 식별자 (예: Aria, Nova, Forge)"),
        role: z.string().describe("역할명 (예: lead, sub-leader, implementer, reviewer)"),
        agent_type: z.string().describe("에이전트 유형 (예: planner, implementer, validator)"),
        track: z.string().optional().describe("담당 트랙 (예: A, B)"),
      })).describe("초기 팀 멤버 목록"),
    },
    async ({ team_id, team_name, channel_name, is_private, members }) => {
      const chName = (channel_name || `team-${team_id}`)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 80);

      let channelId: string | undefined;
      let reused = false;

      try {
        const createResult = await slack.conversations.create({
          name: chName,
          is_private,
        });
        channelId = createResult.channel?.id;
      } catch (err: unknown) {
        const slackErr = err as { data?: { error?: string } };
        if (slackErr.data?.error === "name_taken") {
          // Channel already exists — find and reuse it
          const listResult = await slack.conversations.list({
            types: is_private ? "private_channel" : "public_channel",
            limit: 1000,
            exclude_archived: true,
          });
          const existing = (listResult.channels || []).find(
            (c) => c.name === chName || c.name_normalized === chName,
          );
          if (existing?.id) {
            channelId = existing.id;
            reused = true;
            // Unarchive if needed
            if (existing.is_archived) {
              await slack.conversations.unarchive({ channel: channelId }).catch(() => {});
            }
          } else {
            // Fallback: append timestamp suffix
            const suffixed = (chName + "-" + Date.now().toString(36)).slice(0, 80);
            const retry = await slack.conversations.create({ name: suffixed, is_private });
            channelId = retry.channel?.id;
          }
        } else {
          throw err;
        }
      }

      if (!channelId) throw new Error("채널 생성 실패");

      await slack.conversations.setTopic({
        channel: channelId,
        topic: `🤖 ${team_id}: ${team_name} | Agent Team Channel`,
      });

      const memberMap = new Map<string, TeamMember>();
      for (const m of members) {
        memberMap.set(m.id, {
          role: m.role,
          agentType: m.agent_type,
          track: m.track,
          status: "active",
          joinedAt: new Date().toISOString(),
        });
      }

      const team = {
        id: team_id,
        name: team_name,
        channelId,
        channelName: chName,
        members: memberMap,
        createdAt: new Date().toISOString(),
        status: "active" as const,
        rootThreadTs: undefined as string | undefined,
      };

      teams.set(team_id, team);
      saveTeamById(team_id);

      // Save initial agent contexts to SQLite
      for (const m of members) {
        saveAgentContext({
          agent_id: m.id,
          team_id,
          role: m.role,
          track: m.track,
          context_snapshot: { goal: team_name, phase: "init", channelId },
          last_updated: new Date().toISOString(),
        });
      }

      const memberList = members
        .map((m) => {
          const icon = getRoleIcon(m.role);
          const track = m.track ? ` [Track ${m.track}]` : "";
          return `${icon} *${m.id}* — ${m.agent_type}${track}`;
        })
        .join("\n");

      const introMsg = await slack.chat.postMessage({
        channel: channelId,
        text: [
          `🚀 *팀 ${team_id} 활성화: ${team_name}*`,
          "",
          `*멤버 (${members.length}명):*`,
          memberList,
          "",
          "─────────────────────────",
          "📌 이 채널에서 팀 활동이 실시간으로 공유됩니다.",
        ].join("\n"),
        mrkdwn: true,
      });

      team.rootThreadTs = introMsg.ts;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            team_id,
            channel_id: channelId,
            channel_name: chName,
            root_thread_ts: introMsg.ts,
            members_count: members.length,
            message: `팀 채널 #${chName} ${reused ? "재사용" : "생성"} 완료`,
            member_workflow_hint: "각 팀원 에이전트에게 아래 지시를 전달하세요: 작업 진행/완료 시 반드시 slack_team_send 또는 slack_team_report를 호출하여 팀 채널에 보고할 것.",
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_team_register ──────────────────────────────────────

  server.tool(
    "slack_team_register",
    "기존 팀에 새 멤버를 추가합니다. 팀 채널에 입장 알림을 보냅니다.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      member_id: z.string().describe("멤버 식별자 (예: Spec)"),
      role: z.string().describe("역할명 (예: test-writer)"),
      agent_type: z.string().describe("에이전트 유형"),
      track: z.string().optional().describe("담당 트랙"),
    },
    async ({ team_id: rawTeamId, member_id, role, agent_type, track }) => {
      const team_id = resolveTeamId(rawTeamId);
      const team = getTeam(team_id);

      const member: TeamMember = {
        role,
        agentType: agent_type,
        track,
        status: "active",
        joinedAt: new Date().toISOString(),
      };

      team.members.set(member_id, member);
      saveTeamById(team_id);

      // Save agent context to SQLite
      saveAgentContext({
        agent_id: member_id,
        team_id,
        role,
        track,
        context_snapshot: { phase: "joined", channelId: team.channelId },
        last_updated: new Date().toISOString(),
      });

      const trackStr = track ? ` [Track ${track}]` : "";
      const identity = agentIdentity(member_id, member);

      await slack.chat.postMessage({
        channel: team.channelId,
        text: `합류했습니다 — ${agent_type}${trackStr}`,
        mrkdwn: true,
        username: identity.username,
        icon_emoji: identity.icon_emoji,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            team_id,
            member_id,
            channel_id: team.channelId,
            total_members: team.members.size,
            message: `${member_id} 팀 합류 완료`,
            workflow: getTeamWorkflowInstructions({
              agentId: member_id,
              teamId: team_id,
              channelId: team.channelId,
              role,
            }),
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_team_send ──────────────────────────────────────────

  server.tool(
    "slack_team_send",
    "팀 채널에 메시지를 보냅니다 (모든 팀원 사용 가능). mention으로 다른 팀원을 @페르소나이름 또는 @역할로 멘션할 수 있습니다. (예: ['@Sage', '@Forge', 'validator'])",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      sender: z.string().describe("보내는 멤버 ID (예: Nova, Forge)"),
      message: z.string().describe("메시지 내용"),
      mention: z.array(z.string()).optional().describe("멘션할 대상 목록. @페르소나이름(@Sage, @Forge), 역할명(planner), 멤버ID(Forge) 모두 가능."),
      thread_ts: z.string().optional().describe("스레드에 답장할 경우 해당 ts. 미지정 시 채널에 직접 전송."),
      update_status: z.enum(["active", "idle", "done"]).optional().describe("메시지 전송과 함께 멤버 상태 업데이트"),
    },
    async ({ team_id: rawTeamId, sender, message, mention, thread_ts, update_status }) => {
      const team_id = resolveTeamId(rawTeamId);
      let team: ReturnType<typeof getTeam> | null = null;
      let member: TeamMember | undefined;
      let channelId: string;

      try {
        team = getTeam(team_id);
        member = team.members.get(sender);
        channelId = team.channelId;
      } catch {
        const storedChannelId = getAgentStoredChannelId(sender, team_id);
        channelId = storedChannelId || SLACK_DEFAULT_CHANNEL;
        console.error(`[team_send] Team '${team_id}' not in memory, fallback to channel ${channelId}`);
      }

      if (member && update_status) {
        member.status = update_status;
        saveTeamById(team_id);
      }

      // Resolve @persona mentions to member IDs
      let mentionTags = "";
      let resolvedMentionIds: string[] = [];
      if (mention && mention.length > 0 && team) {
        const resolved = resolvePersonaMentions(mention, team.members);
        mentionTags = resolved.displayTags.join(" ") + " ";
        resolvedMentionIds = resolved.resolvedIds;
      } else if (mention && mention.length > 0) {
        mentionTags = mention.map((m) => `*@${m.replace(/^@/, "")}*`).join(" ") + " ";
        resolvedMentionIds = mention.map((m) => m.replace(/^@/, ""));
      }

      const statusTag = update_status === "done" ? " ✅" : "";
      const identity = member
        ? agentIdentity(sender, member)
        : { username: sender, icon_emoji: ":robot_face:" };

      // Get sender's persona name for the mention notice
      const senderPersona = member ? (AGENT_PERSONAS[member.role]?.displayName || sender) : sender;

      const result = await slack.chat.postMessage({
        channel: channelId,
        text: `${statusTag ? statusTag + " " : ""}${mentionTags}${message}`,
        thread_ts,
        mrkdwn: true,
        username: identity.username,
        icon_emoji: identity.icon_emoji,
      });

      // Store mention notifications in both member ID and role queues
      if (resolvedMentionIds.length > 0 && team) {
        for (const targetId of resolvedMentionIds) {
          const targetMember = team.members.get(targetId);
          const mentionNotice = JSON.stringify({
            from: senderPersona,
            from_id: sender,
            message: message.substring(0, 200),
            thread_ts: result.ts,
            channel: channelId,
            team_id,
            ts: new Date().toISOString(),
          });

          // Queue by member ID — use try-catch for concurrent write safety
          try {
            pushMentionQueue(targetId, mentionNotice);
          } catch (e) {
            console.error(`[team_send] mention_queue write failed for ${targetId}:`, e);
          }

          // Also queue by role (so agents can check by their role name)
          if (targetMember) {
            try {
              pushMentionQueue(targetMember.role, mentionNotice);
            } catch (e) {
              console.error(`[team_send] mention_queue write failed for role ${targetMember.role}:`, e);
            }
          }
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            ts: result.ts,
            channel: channelId,
            sender,
            mentioned: resolvedMentionIds,
            status: member?.status || "unknown",
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_mention_check ──────────────────────────────────────

  server.tool(
    "slack_mention_check",
    "나를 @멘션한 메시지가 있는지 확인합니다 (모든 팀원 사용 가능). 멤버ID, 역할명, 또는 페르소나 이름으로 조회 가능. 확인 후 큐는 비워집니다.",
    {
      identity: z.string().describe("확인할 대상: 멤버ID (Forge), 역할명 (implementer), 또는 페르소나이름 (Forge)"),
      peek: z.boolean().default(false).describe("true 시 큐를 비우지 않고 확인만"),
    },
    async ({ identity, peek }) => {
      const name = identity.replace(/^@/, "").trim();
      const nameLower = name.toLowerCase();

      // Try multiple keys: exact name, role from persona lookup, persona name
      const keysToCheck: string[] = [name];
      const roleFromPersona = PERSONA_NAME_TO_ROLE[nameLower];
      if (roleFromPersona) keysToCheck.push(roleFromPersona);
      // Also check if it's already a role
      if (AGENT_PERSONAS[name]) keysToCheck.push(name);
      if (AGENT_PERSONAS[nameLower]) keysToCheck.push(nameLower);

      const allMentions: unknown[] = [];
      const foundKeys: string[] = [];

      for (const key of [...new Set(keysToCheck)]) {
        const dbKey = `mention_queue:${key}`;
        const row = stmts.kvGet.get(dbKey) as { value: string } | undefined;
        if (row) {
          try {
            const parsed = JSON.parse(row.value);
            if (Array.isArray(parsed) && parsed.length > 0) {
              allMentions.push(...parsed);
              foundKeys.push(dbKey);
            }
          } catch { /* ignore parse errors */ }
        }
      }

      // Clear queues unless peek mode
      if (!peek && foundKeys.length > 0) {
        for (const key of foundKeys) {
          stmts.kvDelete.run(key);
        }
      }

      if (allMentions.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: true, mentions: [], count: 0, message: "새로운 멘션 없음" }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            count: allMentions.length,
            mentions: allMentions,
            cleared: !peek,
            hint: "멘션에 답장하려면 slack_team_send의 mention에 상대 이름을 넣어 응답하세요.",
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_check_all_notifications ────────────────────────────

  server.tool(
    "slack_check_all_notifications",
    "내게 관련된 모든 알림을 한번에 확인합니다 (모든 팀원 사용 가능). 멘션, 권한 요청(리더용), 내 요청 결과, 팀 채널 미읽, 메인 채널 미읽을 통합 조회. API 호출 없이 SQLite만 사용 (빠름, 0 API). 작업 중간에 주기적으로 호출하여 놓치는 알림이 없도록 합니다.",
    {
      agent_id: z.string().describe("에이전트 멤버 ID (예: Aria, Forge, Nova)"),
      team_id: z.string().optional().describe("팀 ID (미지정 시 모든 팀 확인)"),
      include_main_channel: z.boolean().default(true).describe("메인 채널 미읽도 포함"),
      clear_mentions: z.boolean().default(false).describe("true: 확인 후 멘션 큐 비움. false(기본): peek 모드"),
    },
    async ({ agent_id, team_id, include_main_channel, clear_mentions }) => {
      const results: Record<string, unknown> = {};
      let totalItems = 0;

      // 1. Mentions — check by agent_id + role
      const keysToCheck: string[] = [agent_id];
      const roleLower = agent_id.toLowerCase();
      const roleFromPersona = PERSONA_NAME_TO_ROLE[roleLower];
      if (roleFromPersona) keysToCheck.push(roleFromPersona);
      if (AGENT_PERSONAS[agent_id]) keysToCheck.push(agent_id);
      if (AGENT_PERSONAS[roleLower]) keysToCheck.push(roleLower);

      // Also check teams for the agent's role
      const agentTeams: Array<{ teamId: string; role: string; channelId: string }> = [];
      ensureTeamsLoaded();
      for (const [tid, team] of teams) {
        if (team_id && tid !== team_id) continue;
        const member = team.members.get(agent_id);
        if (member) {
          agentTeams.push({ teamId: tid, role: member.role, channelId: team.channelId });
          if (!keysToCheck.includes(member.role)) keysToCheck.push(member.role);
        }
      }

      const allMentions: unknown[] = [];
      const foundKeys: string[] = [];
      for (const key of [...new Set(keysToCheck)]) {
        const dbKey = `mention_queue:${key}`;
        const row = stmts.kvGet.get(dbKey) as { value: string } | undefined;
        if (row) {
          try {
            const parsed = JSON.parse(row.value);
            if (Array.isArray(parsed) && parsed.length > 0) {
              allMentions.push(...parsed);
              foundKeys.push(dbKey);
            }
          } catch { /* ignore */ }
        }
      }

      if (clear_mentions && foundKeys.length > 0) {
        for (const key of foundKeys) {
          stmts.kvDelete.run(key);
        }
      }

      results.mentions = { count: allMentions.length, items: allMentions.slice(0, 20), cleared: clear_mentions };
      totalItems += allMentions.length;

      // 2a. Pending permission requests TO REVIEW (if this agent is a leader)
      const pendingPerms: Array<{ team_id: string; id: number; requester: string; action: string; reason: string }> = [];
      for (const at of agentTeams) {
        if (at.role === "lead" || at.role === "sub-leader") {
          try {
            const pending = getPendingPermissions(at.teamId);
            for (const p of pending) {
              pendingPerms.push({ team_id: at.teamId, id: p.id, requester: p.requester_id, action: p.action, reason: p.reason });
            }
          } catch { /* ignore */ }
        }
      }
      results.pending_permissions = { count: pendingPerms.length, items: pendingPerms };
      totalItems += pendingPerms.length;

      // 2b. My permission requests — recently resolved (for any agent that requested)
      const myResolvedPerms: Array<{ team_id: string; id: number; action: string; decision: string; decided_by: string | null }> = [];
      const stmtMyResolvedPerms = db.prepare(
        `SELECT id, action, status, decided_by FROM permission_requests 
         WHERE team_id = ? AND requester_id = ? AND status != 'pending'
         AND decision_ts > datetime('now', '-1 hour')
         ORDER BY decision_ts DESC LIMIT 5`
      );
      for (const at of agentTeams) {
        try {
          const resolved = stmtMyResolvedPerms.all(at.teamId, agent_id) as Array<{ id: number; action: string; status: string; decided_by: string | null }>;
          for (const r of resolved) {
            myResolvedPerms.push({ team_id: at.teamId, id: r.id, action: r.action, decision: r.status, decided_by: r.decided_by });
          }
        } catch { /* ignore */ }
      }
      if (myResolvedPerms.length > 0) {
        results.my_resolved_permissions = { count: myResolvedPerms.length, items: myResolvedPerms };
        totalItems += myResolvedPerms.length;
      }

      // 3. Team channel unread
      const teamUnread: Array<{ team_id: string; channel: string; unread_count: number; latest?: string }> = [];
      for (const at of agentTeams) {
        const unread = inboxGetUnread(at.channelId);
        if (unread.length > 0) {
          teamUnread.push({
            team_id: at.teamId,
            channel: at.channelId,
            unread_count: unread.length,
            latest: (unread[unread.length - 1]?.text || "").substring(0, 150),
          });
          totalItems += unread.length;
        }
      }
      results.team_unread = teamUnread;

      // 4. Main channel unread
      if (include_main_channel && SLACK_DEFAULT_CHANNEL) {
        const mainUnread = inboxGetUnread(SLACK_DEFAULT_CHANNEL);
        results.main_channel_unread = {
          channel: SLACK_DEFAULT_CHANNEL,
          count: mainUnread.length,
          latest: mainUnread.length > 0
            ? (mainUnread[mainUnread.length - 1]?.text || "").substring(0, 150)
            : null,
        };
        totalItems += mainUnread.length;
      }

      // Build action hints
      const hints: string[] = [];
      if (allMentions.length > 0)
        hints.push(`멘션 ${allMentions.length}건 → slack_team_send로 응답`);
      if (pendingPerms.length > 0)
        hints.push(`권한 요청 ${pendingPerms.length}건 → slack_resolve_permission으로 처리`);
      if (myResolvedPerms.length > 0)
        hints.push(`내 권한 요청 ${myResolvedPerms.length}건 결정됨 → 결과 확인 후 작업 재개`);
      if (teamUnread.length > 0)
        hints.push(`팀 채널 미읽 → slack_team_read로 확인`);
      if (include_main_channel && SLACK_DEFAULT_CHANNEL) {
        const mc = results.main_channel_unread as { count: number };
        if (mc.count > 0) hints.push(`메인 채널 미읽 ${mc.count}건 → slack_check_inbox로 확인`);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            agent_id,
            total_notifications: totalItems,
            ...results,
            action_needed: totalItems > 0,
            hints: hints.length > 0 ? hints : ["알림 없음. 작업을 계속하세요."],
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_team_status ────────────────────────────────────────

  server.tool(
    "slack_team_status",
    "팀의 현재 상태와 멤버 목록을 조회합니다. 팀 채널에도 현황을 게시할 수 있습니다.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      post_to_channel: z.boolean().default(false).describe("true 시 팀 채널에도 현황 메시지 게시"),
    },
    async ({ team_id: rawTeamId, post_to_channel }) => {
      const team_id = resolveTeamId(rawTeamId);
      const team = getTeam(team_id);
      const statusText = formatTeamStatus(team);

      if (post_to_channel) {
        await slack.chat.postMessage({
          channel: team.channelId,
          text: `📊 *팀 현황 업데이트*\n\n${statusText}`,
          mrkdwn: true,
        });
      }

      return {
        content: [{ type: "text", text: statusText }],
      };
    }
  );

  // ── slack_team_broadcast ─────────────────────────────────────

  server.tool(
    "slack_team_broadcast",
    "팀 전체에 중요 공지를 브로드캐스트합니다. 트랙 간 공지, 의존성 알림, 긴급 사항 전달에 사용. 누구나 호출 가능.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      sender: z.string().describe("보내는 멤버 ID (예: Aria, Nova, Forge 등 누구나)"),
      message: z.string().describe("브로드캐스트 메시지"),
      mention_roles: z.array(z.string()).optional().describe("특별히 언급할 멤버 ID 목록 (예: ['Nova', 'Sage'])"),
    },
    async ({ team_id: rawTeamId, sender, message, mention_roles }) => {
      const team_id = resolveTeamId(rawTeamId);
      const team = getTeam(team_id);
      const member = team.members.get(sender);

      const mentions = mention_roles
        ? "\n" + mention_roles.map((r) => `→ *${r}*`).join(" ")
        : "";

      const formatted = `📢 *[BROADCAST]*\n${message}${mentions}`;
      const identity = member
        ? agentIdentity(sender, member)
        : { username: sender, icon_emoji: ":loudspeaker:" };

      const result = await slack.chat.postMessage({
        channel: team.channelId,
        text: formatted,
        mrkdwn: true,
        username: identity.username,
        icon_emoji: identity.icon_emoji,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: true, ts: result.ts, channel: team.channelId }, null, 2),
        }],
      };
    }
  );

  // ── slack_team_read ──────────────────────────────────────────

  server.tool(
    "slack_team_read",
    "팀 채널의 최근 메시지를 읽어옵니다 (모든 팀원 사용 가능). 인박스 우선, API fallback. 다른 팀원이 보낸 메시지, 결과 보고, 명령을 확인할 때 사용.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      limit: z.number().min(1).max(100).default(20).describe("가져올 메시지 수 (기본: 20)"),
      oldest: z.string().optional().describe("이 타임스탬프 이후의 메시지만 가져옴 (Slack ts)"),
      sender_filter: z.string().optional().describe("특정 멤버 ID의 메시지만 필터링 (예: Nova)"),
      fresh: z.boolean().default(false).describe("true: Slack API에서 최신 가져옴. false(기본): 인박스만 (빠름, 0 API)."),
    },
    async ({ team_id: rawTeamId, limit, oldest, sender_filter, fresh }) => {
      const team_id = resolveTeamId(rawTeamId);
      let ch: string;
      try {
        const team = getTeam(team_id);
        ch = team.channelId;
      } catch {
        const stored = getAgentStoredChannelId("_any_", team_id);
        ch = stored || SLACK_DEFAULT_CHANNEL;
        console.error(`[team_read] Team '${team_id}' not found, fallback to ${ch}`);
      }

      // Inbox-first: read from SQLite (0 API calls)
      if (!fresh) {
        // Use inbox data — combine unread + recent history
        // Without oldest: get most recent N messages (DESC then reverse for chronological order)
        // With oldest: get N messages after that timestamp (ASC)
        const baseQuery = oldest
          ? `SELECT * FROM inbox WHERE channel_id = ? AND message_ts > ? ORDER BY message_ts ASC LIMIT ?`
          : `SELECT * FROM inbox WHERE channel_id = ? ORDER BY message_ts DESC LIMIT ?`;
        const allRows = db.prepare(baseQuery).all(
          ...(oldest ? [ch, oldest, limit] : [ch, limit])
        ) as import("../types.js").InboxRow[];

        // Reverse DESC results to chronological order
        let messages = oldest ? allRows : allRows.reverse();
        if (sender_filter) {
          messages = messages.filter((m) => {
            if (m.text?.includes(`*${sender_filter}*`)) return true;
            if (m.raw_json) {
              try {
                const parsed = JSON.parse(m.raw_json);
                if (parsed.username?.includes(sender_filter)) return true;
              } catch { /* ignore */ }
            }
            return false;
          });
        }

        if (messages.length > 0) {
          const latest = messages[messages.length - 1];
          try { await slack.reactions.add({ channel: ch, name: "eyes", timestamp: latest.message_ts }); } catch { /* already reacted */ }

          const formatted = messages.map((r) => {
            const thread = r.thread_ts ? ` [thread: ${r.thread_ts}]` : "";
            return `[${r.message_ts}] <${r.user_id}>${thread}: ${r.text}`;
          }).join("\n");

          return {
            content: [{
              type: "text",
              text: formatted
                + `\n\n(source: inbox, ${messages.length}건)`
                + "\n[HINT] fresh=true로 최신 메시지 API 호출 가능. 작업 완료 시 반드시 slack_team_send/slack_team_report로 보고.",
            }],
          };
        }
        // Inbox empty — fall through to API
      }

      // API fallback
      const result = await slack.conversations.history({
        channel: ch,
        limit,
        ...(oldest ? { oldest } : {}),
      });
      const messages = (result.messages || []) as SlackMessage[];
      const sorted = [...messages].reverse();

      // Ingest for other agents
      if (sorted.length > 0) {
        inboxIngest(ch, sorted);
        const latest = sorted[sorted.length - 1];
        try { await slack.reactions.add({ channel: ch, name: "eyes", timestamp: latest.ts }); } catch { /* already reacted */ }
      }

      let filtered = sorted;
      if (sender_filter) {
        filtered = sorted.filter((m) =>
          m.text?.includes(`*${sender_filter}*`)
          || (m as unknown as Record<string, unknown>).username?.toString().includes(sender_filter)
        );
      }

      return {
        content: [{
          type: "text",
          text: formatMessages(filtered)
            + "\n\n[HINT] 작업 완료 시 반드시 slack_team_send/slack_team_report로 팀 채널에 보고하세요.",
        }],
      };
    }
  );

  // ── slack_team_wait ──────────────────────────────────────────

  server.tool(
    "slack_team_wait",
    "팀 채널에서 새 메시지를 대기합니다 (모든 팀원 사용 가능). timeout_seconds=0이면 1회 확인 후 즉시 반환 (논블로킹 — 작업 중간에 사용). 지시를 기다리거나 다른 멤버의 작업 완료를 대기할 때 사용.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      since_ts: z.string().optional().describe("이 ts 이후의 메시지부터 확인. 미지정 시 현재 시각부터"),
      timeout_seconds: z.number().min(0).max(300).default(60).describe("대기 시간 (초). 0=논블로킹. 기본: 60, 최대: 300."),
      poll_interval_seconds: z.number().min(2).max(30).default(5).describe("폴링 간격 (초, 기본: 5)"),
      wait_for_sender: z.string().optional().describe("특정 멤버의 메시지만 대기 (예: Aria, Nova). 미지정 시 봇이 아닌 모든 메시지"),
      wait_for_keyword: z.string().optional().describe("메시지에 특정 키워드가 포함된 것만 대기 (예: DONE, APPROVED, LGTM)"),
    },
    async ({ team_id: rawTeamId, since_ts, timeout_seconds, poll_interval_seconds, wait_for_sender, wait_for_keyword }) => {
      const team_id = resolveTeamId(rawTeamId);
      let ch: string;
      try {
        const team = getTeam(team_id);
        ch = team.channelId;
      } catch {
        const stored = getAgentStoredChannelId("_any_", team_id);
        ch = stored || SLACK_DEFAULT_CHANNEL;
        console.error(`[team_wait] Team '${team_id}' not found, fallback to ${ch}`);
      }
      const myUserId = await resolveBotUserId();
      const baseTs = since_ts || String(Math.floor(Date.now() / 1000)) + ".000000";

      // ── Shared inbox filter logic ────────────────────────────
      const filterInbox = (): import("../types.js").InboxRow[] => {
        let unread = inboxGetUnread(ch)
          .filter((r) => r.message_ts > baseTs);

        if (wait_for_sender) {
          unread = unread.filter((r) => {
            if (r.text?.includes(`*${wait_for_sender}*`)) return true;
            if (r.raw_json) {
              try {
                const parsed = JSON.parse(r.raw_json);
                if (parsed.username && parsed.username.includes(wait_for_sender)) return true;
              } catch { /* ignore */ }
            }
            return false;
          });
        } else {
          unread = unread.filter((r) => r.user_id !== myUserId);
        }

        if (wait_for_keyword) {
          const kw = wait_for_keyword.toLowerCase();
          unread = unread.filter((r) => (r.text || "").toLowerCase().includes(kw));
        }
        return unread;
      };

      const makeFoundResult = async (unread: import("../types.js").InboxRow[], attempts: number, nonBlocking = false) => {
        const latest = unread[unread.length - 1];
        setChannelCursor(ch, latest.message_ts);
        try { await slack.reactions.add({ channel: ch, name: "eyes", timestamp: latest.message_ts }); } catch { /* already reacted */ }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              found: unread.length,
              source: "inbox",
              ...(nonBlocking ? { non_blocking: true } : {}),
              last_ts: latest.message_ts,
              attempts,
              messages: unread.map((r) => ({
                ts: r.message_ts,
                user: r.user_id,
                text: r.text,
                thread_ts: r.thread_ts,
              })),
              hint: "⚠️ 지시를 수행한 후 반드시 slack_team_send 또는 slack_team_report로 결과를 팀 채널에 보고하세요.",
            }, null, 2),
          }],
        };
      };

      // ── Non-blocking mode (timeout_seconds === 0) ─────────────
      // Trigger fresh poll, check inbox, return immediately
      if (timeout_seconds === 0) {
        try { await (await import("../background-poller.js")).pollNow(); } catch { /* best effort */ }
        const unread = filterInbox();
        if (unread.length > 0) return await makeFoundResult(unread, 1, true);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              non_blocking: true,
              reason: "no_messages",
              last_ts: baseTs,
              message: "논블로킹: 새 메시지 없음. 현재 작업을 계속하세요.",
              IMPORTANT: `⚠️ 반드시 5~10개 도구 호출마다 또는 30초마다 slack_team_wait(team_id="${team_id}", timeout_seconds=0) 또는 slack_check_all_notifications(agent_id="...")를 재호출하세요. 주기적으로 체크하지 않으면 팀 메시지를 놓칩니다.`,
              next_check: "5~10 tool calls 또는 30초 후",
            }, null, 2),
          }],
        };
      }

      // ── Blocking polling loop ─────────────────────────────────
      const deadline = Date.now() + timeout_seconds * 1000;
      let cycleCount = 0;
      const API_EVERY = 3;

      while (Date.now() < deadline) {
        cycleCount++;
        const doApiFetch = cycleCount % API_EVERY === 0;

        // 1) Inbox-first
        const unread = filterInbox();
        if (unread.length > 0) return await makeFoundResult(unread, cycleCount);

        // 2) Fresh API pull (every 3rd cycle as fallback)
        if (doApiFetch) {
          try {
            const result = await slack.conversations.history({
              channel: ch,
              oldest: baseTs,
              limit: 20,
            });

            const messages = ((result.messages || []) as SlackMessage[])
              .filter((m) => m.ts !== baseTs);

            if (messages.length > 0) {
              inboxIngest(ch, messages);
              const newest = messages.reduce((a, b) => (a.ts > b.ts ? a : b));
              setChannelCursor(ch, newest.ts);
              continue; // re-check inbox immediately with new data
            }
          } catch {
            // Rate limited or error — fall through to sleep
          }
        }

        await sleep(poll_interval_seconds * 1000);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: false,
            reason: "timeout",
            timeout_seconds,
            attempts: cycleCount,
            last_ts: baseTs,
            message: `${timeout_seconds}초 동안 새 메시지 없음`,
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_team_thread ────────────────────────────────────────

  server.tool(
    "slack_team_thread",
    "팀 채널 메시지의 스레드를 읽거나 답장합니다 (모든 팀원 사용 가능). 특정 작업 스레드에서의 세부 논의에 사용.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      thread_ts: z.string().describe("스레드 원본 메시지의 ts"),
      sender: z.string().optional().describe("발신자 멤버 ID (답장 시). 미지정 시 읽기만 합니다."),
      message: z.string().optional().describe("답장 메시지 (sender와 함께 지정)"),
      limit: z.number().min(1).max(100).default(30).describe("스레드 메시지 가져올 수 (읽기 시)"),
    },
    async ({ team_id: rawTeamId, thread_ts, sender, message, limit }) => {
      const team_id = resolveTeamId(rawTeamId);
      let team: ReturnType<typeof getTeam> | null = null;
      let ch: string;
      try {
        team = getTeam(team_id);
        ch = team.channelId;
      } catch {
        const stored = getAgentStoredChannelId(sender || "_any_", team_id);
        ch = stored || SLACK_DEFAULT_CHANNEL;
        console.error(`[team_thread] Team '${team_id}' not found, fallback to ${ch}`);
      }

      if (sender && message) {
        const member = team?.members.get(sender);
        const identity = member
          ? agentIdentity(sender, member)
          : { username: sender, icon_emoji: ":robot_face:" };

        const result = await slack.chat.postMessage({
          channel: ch,
          text: message,
          thread_ts,
          mrkdwn: true,
          username: identity.username,
          icon_emoji: identity.icon_emoji,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              { ok: true, ts: result.ts, channel: ch, thread_ts, sender },
              null, 2
            ),
          }],
        };
      }

      const result = await slack.conversations.replies({
        channel: ch,
        ts: thread_ts,
        limit,
      });
      const messages = (result.messages || []) as SlackMessage[];

      return {
        content: [{ type: "text", text: formatMessages(messages) }],
      };
    }
  );

  // ── slack_team_update_message ────────────────────────────────

  server.tool(
    "slack_team_update_message",
    "팀 채널에서 자신이 보낸 메시지를 수정합니다 (모든 팀원 사용 가능). 상태 업데이트, 오타 수정, 결과 추가 등에 사용. slack_team_send/slack_team_report의 결과에서 받은 ts 값이 필요합니다.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      ts: z.string().describe("수정할 메시지의 타임스탬프 (ts). team_send/team_report 결과에서 받은 값."),
      message: z.string().describe("새 메시지 텍스트 (기존 내용을 완전히 대체)"),
    },
    async ({ team_id: rawTeamId, ts, message }) => {
      const team_id = resolveTeamId(rawTeamId);
      let ch: string;
      try {
        const team = getTeam(team_id);
        ch = team.channelId;
      } catch {
        const stored = getAgentStoredChannelId("_any_", team_id);
        ch = stored || SLACK_DEFAULT_CHANNEL;
        console.error(`[team_update_message] Team '${team_id}' not found, fallback to ${ch}`);
      }
      try {
        const result = await slack.chat.update({
          channel: ch,
          ts,
          text: message,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true, ts: result.ts, channel: ch,
              message: "팀 메시지 수정 완료",
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false, error: msg,
              hint: msg.includes("message_not_found")
                ? "해당 ts의 메시지를 찾을 수 없습니다."
                : msg.includes("cant_update_message")
                ? "봇이 보낸 메시지만 수정할 수 있습니다."
                : "메시지 수정 실패",
            }, null, 2),
          }],
        };
      }
    }
  );

  // ── slack_team_delete_message ────────────────────────────────

  server.tool(
    "slack_team_delete_message",
    "팀 채널에서 자신이 보낸 메시지를 삭제합니다 (모든 팀원 사용 가능). 잘못된 메시지, 중복 메시지 정리에 사용.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      ts: z.string().describe("삭제할 메시지의 타임스탬프 (ts)"),
    },
    async ({ team_id: rawTeamId, ts }) => {
      const team_id = resolveTeamId(rawTeamId);
      let ch: string;
      try {
        const team = getTeam(team_id);
        ch = team.channelId;
      } catch {
        const stored = getAgentStoredChannelId("_any_", team_id);
        ch = stored || SLACK_DEFAULT_CHANNEL;
        console.error(`[team_delete_message] Team '${team_id}' not found, fallback to ${ch}`);
      }
      try {
        await slack.chat.delete({
          channel: ch,
          ts,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true, ts, channel: ch,
              message: "팀 메시지 삭제 완료",
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false, error: msg,
              hint: msg.includes("message_not_found")
                ? "해당 ts의 메시지를 찾을 수 없습니다."
                : msg.includes("cant_delete_message")
                ? "봇이 보낸 메시지만 삭제할 수 있습니다."
                : "메시지 삭제 실패",
            }, null, 2),
          }],
        };
      }
    }
  );

  // ── slack_team_close ─────────────────────────────────────────

  server.tool(
    "slack_team_close",
    "팀 작업 완료 후 채널을 아카이브합니다. 최종 요약을 게시하고 채널을 닫습니다.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      summary: z.string().describe("작업 최종 요약 메시지"),
      archive_channel: z.boolean().default(true).describe("채널 아카이브 여부 (기본: true)"),
    },
    async ({ team_id: rawTeamId, summary, archive_channel }) => {
      const team_id = resolveTeamId(rawTeamId);
      const team = getTeam(team_id);

      for (const [, member] of team.members) {
        member.status = "done";
      }
      team.status = "completed";
      saveTeamById(team_id);

      // Mark all pending tasks as cancelled (not "done" — they weren't actually completed)
      const pendingTasks = getTeamTasks(team_id).filter((t) => !['done', 'cancelled'].includes(t.status));
      for (const t of pendingTasks) {
        updateTaskStatus(team_id, t.id, "cancelled", t.result_summary || "팀 종료로 취소 처리");
      }

      const doneMembers = [...team.members.entries()]
        .map(([id, m]) => `✅ ${getRoleIcon(m.role)} ${id}`)
        .join("\n");

      await slack.chat.postMessage({
        channel: team.channelId,
        text: [
          `🎉 *팀 ${team_id} 작업 완료*`,
          "",
          `*요약:*`,
          summary,
          "",
          `*멤버:*`,
          doneMembers,
          "",
          archive_channel ? "📁 채널이 아카이브됩니다." : "",
        ].filter(Boolean).join("\n"),
        mrkdwn: true,
      });

      if (archive_channel) {
        try {
          await slack.conversations.archive({ channel: team.channelId });
          team.status = "archived";
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return {
            content: [{
              type: "text",
              text: `팀 종료 완료 (아카이브 실패: ${errMsg}). 수동 아카이브 필요.`,
            }],
          };
        }
      }

      if (SLACK_DEFAULT_CHANNEL) {
        await slack.chat.postMessage({
          channel: SLACK_DEFAULT_CHANNEL,
          text: `🎉 팀 *${team_id}* (${teamNameSafe(team)}) 작업 완료. 채널 #${team.channelName} ${archive_channel ? "아카이브됨" : "유지 중"}.`,
          mrkdwn: true,
        });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            team_id,
            status: team.status,
            archived: archive_channel,
            message: `팀 ${team_id} 종료 완료`,
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_team_report ────────────────────────────────────────

  server.tool(
    "slack_team_report",
    "메인 채널에 작업 상황을 보고합니다 (모든 팀원 사용 가능). 팀 채널 + 메인 채널에 동시 게시되어 사용자가 전체 진행 상황을 한눈에 파악할 수 있습니다.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      sender: z.string().describe("보내는 멤버 ID (예: Nova, Forge)"),
      summary: z.string().describe("작업 상황 요약 (메인 채널에 게시됨)"),
      details: z.string().optional().describe("상세 내용 (팀 채널 스레드에만 게시). 미지정 시 요약만 게시."),
      status: z.enum(["progress", "blocked", "review", "done"]).default("progress").describe("상태: progress(진행중), blocked(차단), review(검토 필요), done(완료)"),
      update_member_status: z.enum(["active", "idle", "done"]).optional().describe("멤버 상태도 함께 업데이트"),
    },
    async ({ team_id: rawTeamId, sender, summary, details, status, update_member_status }) => {
      const team_id = resolveTeamId(rawTeamId);
      let team: ReturnType<typeof getTeam> | null = null;
      let member: TeamMember | undefined;
      let teamChannelId: string;

      try {
        team = getTeam(team_id);
        member = team.members.get(sender);
        teamChannelId = team.channelId;
      } catch {
        const storedChannelId = getAgentStoredChannelId(sender, team_id);
        teamChannelId = storedChannelId || SLACK_DEFAULT_CHANNEL;
        console.error(`[team_report] Team '${team_id}' not in memory, fallback to channel ${teamChannelId}`);
      }

      if (member && update_member_status) {
        member.status = update_member_status;
        saveTeamById(team_id);
      }

      const statusEmoji: Record<string, string> = {
        progress: "🔄", blocked: "🚫", review: "👀", done: "✅",
      };
      const statusLabel: Record<string, string> = {
        progress: "진행중", blocked: "차단됨", review: "검토 필요", done: "완료",
      };

      const icon = member ? getRoleIcon(member.role) : "🤖";
      const trackStr = member?.track ? ` [${member.track}]` : "";
      const emoji = statusEmoji[status] || "📋";
      const label = statusLabel[status] || status;

      const mainCh = SLACK_DEFAULT_CHANNEL;
      if (!mainCh) throw new Error("SLACK_DEFAULT_CHANNEL이 설정되지 않았습니다.");

      const mainMsg = await slack.chat.postMessage({
        channel: mainCh,
        text: [
          `${emoji} *[${team_id}]* ${icon} *${sender}*${trackStr} — ${label}`,
          summary,
        ].join("\n"),
        mrkdwn: true,
      });

      const identity = member
        ? agentIdentity(sender, member)
        : { username: sender, icon_emoji: ":robot_face:" };
      const teamMsg = await slack.chat.postMessage({
        channel: teamChannelId,
        text: `${emoji} *${label}*\n${summary}`,
        mrkdwn: true,
        username: identity.username,
        icon_emoji: identity.icon_emoji,
      });

      if (details) {
        await sendSmart(teamChannelId, details, {
          thread_ts: teamMsg.ts,
          title: `${sender} 상세 보고`,
          filename: `report-${sender}-${Date.now()}.txt`,
        });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            team_id,
            sender,
            status,
            main_channel_ts: mainMsg.ts,
            team_channel_ts: teamMsg.ts,
            message: `${label} 보고 완료 (메인 채널 + 팀 채널)`,
          }, null, 2),
        }],
      };
    }
  );
}

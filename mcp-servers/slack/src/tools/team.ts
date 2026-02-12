/**
 * Team tools: create, register, send, status, broadcast, read, wait, thread, close, report.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SlackMessage, TeamMember } from "../types.js";
import { SLACK_DEFAULT_CHANNEL } from "../types.js";
import { db, saveAgentContext, getTeamTasks, updateTaskStatus } from "../db.js";
import {
  teams, getTeam, resolveChannel,
  getRoleIcon, agentIdentity, formatTeamStatus,
  saveTeamsToState, teamNameSafe,
} from "../state.js";
import { slack, resolveBotUserId, sendSmart, sleep } from "../slack-client.js";
import { formatMessages, getTeamWorkflowInstructions } from "../formatting.js";

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
        id: z.string().describe("멤버 식별자 (예: lead, sub-leader-A, worker-A)"),
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

      const createResult = await slack.conversations.create({
        name: chName,
        is_private,
      });

      const channelId = createResult.channel?.id;
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
      saveTeamsToState();

      // Save initial agent contexts to SQLite
      for (const m of members) {
        saveAgentContext({
          agent_id: m.id,
          team_id,
          role: m.role,
          track: m.track,
          context_snapshot: { goal: team_name, phase: "init" },
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
            message: `팀 채널 #${chName} 생성 완료`,
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
      team_id: z.string().describe("팀 식별자"),
      member_id: z.string().describe("멤버 식별자 (예: test-writer-A)"),
      role: z.string().describe("역할명 (예: test-writer)"),
      agent_type: z.string().describe("에이전트 유형"),
      track: z.string().optional().describe("담당 트랙"),
    },
    async ({ team_id, member_id, role, agent_type, track }) => {
      const team = getTeam(team_id);

      const member: TeamMember = {
        role,
        agentType: agent_type,
        track,
        status: "active",
        joinedAt: new Date().toISOString(),
      };

      team.members.set(member_id, member);
      saveTeamsToState();

      // Save agent context to SQLite
      saveAgentContext({
        agent_id: member_id,
        team_id,
        role,
        track,
        context_snapshot: { phase: "joined" },
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
            }),
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_team_send ──────────────────────────────────────────

  server.tool(
    "slack_team_send",
    "에이전트가 자신의 역할 이름으로 팀 채널에 메시지를 보냅니다. mention으로 다른 팀원을 @멘션할 수 있습니다.",
    {
      team_id: z.string().describe("팀 식별자"),
      sender: z.string().describe("보내는 멤버 ID (예: sub-leader-A, worker-A)"),
      message: z.string().describe("메시지 내용"),
      mention: z.array(z.string()).optional().describe("멘션할 팀원 ID 목록 (예: ['worker-A', 'sub-leader-B']). 메시지 앞에 @멘션 태그가 추가됩니다."),
      thread_ts: z.string().optional().describe("스레드에 답장할 경우 해당 ts. 미지정 시 채널에 직접 전송."),
      update_status: z.enum(["active", "idle", "done"]).optional().describe("메시지 전송과 함께 멤버 상태 업데이트"),
    },
    async ({ team_id, sender, message, mention, thread_ts, update_status }) => {
      const team = getTeam(team_id);
      const member = team.members.get(sender);
      if (!member) {
        throw new Error(`멤버 '${sender}'가 팀 '${team_id}'에 등록되어 있지 않습니다.`);
      }

      if (update_status) {
        member.status = update_status;
        saveTeamsToState();
      }

      const mentionTags = mention && mention.length > 0
        ? mention.map((m) => `*@${m}*`).join(" ") + " "
        : "";

      const statusTag = update_status === "done" ? " ✅" : "";
      const identity = agentIdentity(sender, member);

      const result = await slack.chat.postMessage({
        channel: team.channelId,
        text: `${statusTag ? statusTag + " " : ""}${mentionTags}${message}`,
        thread_ts,
        mrkdwn: true,
        username: identity.username,
        icon_emoji: identity.icon_emoji,
      });

      if (mention && mention.length > 0) {
        const mentionNotice = `[멘션 알림] ${sender}가 당신을 멘션했습니다: ${message.substring(0, 100)}`;
        for (const targetId of mention) {
          const targetMember = team.members.get(targetId);
          if (targetMember) {
            db.prepare(
              `INSERT INTO kv_store (key, value) VALUES (?, ?)
               ON CONFLICT(key) DO UPDATE SET value = json_insert(value, '$[#]', ?), updated_at = datetime('now')`
            ).run(
              `mention_queue:${targetId}`,
              JSON.stringify([mentionNotice]),
              mentionNotice,
            );
          }
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            ts: result.ts,
            channel: team.channelId,
            sender,
            mentioned: mention || [],
            status: member.status,
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
      team_id: z.string().describe("팀 식별자"),
      post_to_channel: z.boolean().default(false).describe("true 시 팀 채널에도 현황 메시지 게시"),
    },
    async ({ team_id, post_to_channel }) => {
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
    "팀 전체에 중요 공지를 브로드캐스트합니다. lead가 트랙 간 공지, 의존성 알림 등에 사용.",
    {
      team_id: z.string().describe("팀 식별자"),
      sender: z.string().describe("보내는 멤버 ID (보통 lead)"),
      message: z.string().describe("브로드캐스트 메시지"),
      mention_roles: z.array(z.string()).optional().describe("특별히 언급할 멤버 ID 목록 (예: ['sub-leader-A', 'sub-leader-B'])"),
    },
    async ({ team_id, sender, message, mention_roles }) => {
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
    "팀 채널의 최근 메시지를 읽어옵니다. 다른 팀원이 보낸 메시지, 결과 보고, 명령을 확인할 때 사용.",
    {
      team_id: z.string().describe("팀 식별자"),
      limit: z.number().min(1).max(100).default(20).describe("가져올 메시지 수 (기본: 20)"),
      oldest: z.string().optional().describe("이 타임스탬프 이후의 메시지만 가져옴 (Slack ts)"),
      sender_filter: z.string().optional().describe("특정 멤버 ID의 메시지만 필터링 (예: sub-leader-A)"),
    },
    async ({ team_id, limit, oldest, sender_filter }) => {
      const team = getTeam(team_id);
      const result = await slack.conversations.history({
        channel: team.channelId,
        limit,
        ...(oldest ? { oldest } : {}),
      });
      const messages = (result.messages || []) as SlackMessage[];
      const sorted = [...messages].reverse();

      let filtered = sorted;
      if (sender_filter) {
        filtered = sorted.filter((m) => m.text?.includes(`*${sender_filter}*`));
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
    "팀 채널에서 특정 멤버나 lead의 새 메시지를 대기합니다. 지시를 기다리거나 다른 멤버의 작업 완료를 대기할 때 사용.",
    {
      team_id: z.string().describe("팀 식별자"),
      since_ts: z.string().optional().describe("이 ts 이후의 메시지부터 확인. 미지정 시 현재 시각부터"),
      timeout_seconds: z.number().min(5).max(300).default(60).describe("대기 시간 (초, 기본: 60, 최대: 300)"),
      poll_interval_seconds: z.number().min(2).max(30).default(5).describe("폴링 간격 (초, 기본: 5)"),
      wait_for_sender: z.string().optional().describe("특정 멤버의 메시지만 대기 (예: lead, sub-leader-A). 미지정 시 봇이 아닌 모든 메시지"),
      wait_for_keyword: z.string().optional().describe("메시지에 특정 키워드가 포함된 것만 대기 (예: DONE, APPROVED, LGTM)"),
    },
    async ({ team_id, since_ts, timeout_seconds, poll_interval_seconds, wait_for_sender, wait_for_keyword }) => {
      const team = getTeam(team_id);
      const ch = team.channelId;
      let lastTs = since_ts || String(Math.floor(Date.now() / 1000)) + ".000000";

      const deadline = Date.now() + timeout_seconds * 1000;
      let attempts = 0;

      while (Date.now() < deadline) {
        attempts++;
        await sleep(poll_interval_seconds * 1000);

        const result = await slack.conversations.history({
          channel: ch,
          oldest: lastTs,
          limit: 20,
        });

        const messages = ((result.messages || []) as SlackMessage[])
          .filter((m) => m.ts !== lastTs);

        if (messages.length === 0) continue;

        const newest = messages.reduce((a, b) => (a.ts > b.ts ? a : b));
        lastTs = newest.ts;

        let matched = messages;
        if (wait_for_sender) {
          matched = matched.filter((m) => m.text?.includes(`*${wait_for_sender}*`));
        }
        if (wait_for_keyword) {
          const kw = wait_for_keyword.toLowerCase();
          matched = matched.filter((m) => (m.text || "").toLowerCase().includes(kw));
        }
        if (!wait_for_sender) {
          const myId = await resolveBotUserId();
          matched = matched.filter((m) => m.user !== myId);
        }

        if (matched.length > 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ok: true,
                found: matched.length,
                last_ts: lastTs,
                attempts,
                messages: matched.map((m) => ({
                  ts: m.ts,
                  user: m.user,
                  text: m.text,
                  thread_ts: m.thread_ts,
                })),
                hint: "⚠️ 지시를 수행한 후 반드시 slack_team_send 또는 slack_team_report로 결과를 팀 채널에 보고하세요.",
              }, null, 2),
            }],
          };
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: false,
            reason: "timeout",
            timeout_seconds,
            attempts,
            last_ts: lastTs,
            message: `${timeout_seconds}초 동안 새 메시지 없음`,
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_team_thread ────────────────────────────────────────

  server.tool(
    "slack_team_thread",
    "팀 채널 메시지의 스레드를 읽거나 스레드에 답장합니다. 특정 작업 스레드에서의 세부 논의에 사용.",
    {
      team_id: z.string().describe("팀 식별자"),
      thread_ts: z.string().describe("스레드 원본 메시지의 ts"),
      sender: z.string().optional().describe("발신자 멤버 ID (답장 시). 미지정 시 읽기만 합니다."),
      message: z.string().optional().describe("답장 메시지 (sender와 함께 지정)"),
      limit: z.number().min(1).max(100).default(30).describe("스레드 메시지 가져올 수 (읽기 시)"),
    },
    async ({ team_id, thread_ts, sender, message, limit }) => {
      const team = getTeam(team_id);

      if (sender && message) {
        const member = team.members.get(sender);
        if (!member) {
          throw new Error(`멤버 '${sender}'가 팀 '${team_id}'에 없습니다.`);
        }
        const identity = agentIdentity(sender, member);

        const result = await slack.chat.postMessage({
          channel: team.channelId,
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
              { ok: true, ts: result.ts, channel: team.channelId, thread_ts, sender },
              null, 2
            ),
          }],
        };
      }

      const result = await slack.conversations.replies({
        channel: team.channelId,
        ts: thread_ts,
        limit,
      });
      const messages = (result.messages || []) as SlackMessage[];

      return {
        content: [{ type: "text", text: formatMessages(messages) }],
      };
    }
  );

  // ── slack_team_close ─────────────────────────────────────────

  server.tool(
    "slack_team_close",
    "팀 작업 완료 후 채널을 아카이브합니다. 최종 요약을 게시하고 채널을 닫습니다.",
    {
      team_id: z.string().describe("팀 식별자"),
      summary: z.string().describe("작업 최종 요약 메시지"),
      archive_channel: z.boolean().default(true).describe("채널 아카이브 여부 (기본: true)"),
    },
    async ({ team_id, summary, archive_channel }) => {
      const team = getTeam(team_id);

      for (const [, member] of team.members) {
        member.status = "done";
      }
      team.status = "completed";
      saveTeamsToState();

      // Mark all pending tasks as cancelled
      const pendingTasks = getTeamTasks(team_id).filter((t) => !['done', 'cancelled'].includes(t.status));
      for (const t of pendingTasks) {
        updateTaskStatus(team_id, t.id, "done", t.result_summary || "팀 종료로 완료 처리");
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
    "팀원이 메인 채널에 작업 상황을 보고합니다. 팀 채널 + 메인 채널에 동시 게시되어 사용자가 전체 진행 상황을 한눈에 파악할 수 있습니다.",
    {
      team_id: z.string().describe("팀 식별자"),
      sender: z.string().describe("보내는 멤버 ID (예: sub-leader-A, rust-impl-A)"),
      summary: z.string().describe("작업 상황 요약 (메인 채널에 게시됨)"),
      details: z.string().optional().describe("상세 내용 (팀 채널 스레드에만 게시). 미지정 시 요약만 게시."),
      status: z.enum(["progress", "blocked", "review", "done"]).default("progress").describe("상태: progress(진행중), blocked(차단), review(검토 필요), done(완료)"),
      update_member_status: z.enum(["active", "idle", "done"]).optional().describe("멤버 상태도 함께 업데이트"),
    },
    async ({ team_id, sender, summary, details, status, update_member_status }) => {
      const team = getTeam(team_id);
      const member = team.members.get(sender);
      if (!member) {
        throw new Error(`멤버 '${sender}'가 팀 '${team_id}'에 등록되어 있지 않습니다.`);
      }

      if (update_member_status) {
        member.status = update_member_status;
        saveTeamsToState();
      }

      const statusEmoji: Record<string, string> = {
        progress: "🔄", blocked: "🚫", review: "👀", done: "✅",
      };
      const statusLabel: Record<string, string> = {
        progress: "진행중", blocked: "차단됨", review: "검토 필요", done: "완료",
      };

      const icon = getRoleIcon(member.role);
      const trackStr = member.track ? ` [${member.track}]` : "";
      const emoji = statusEmoji[status] || "📋";
      const label = statusLabel[status] || status;

      const mainCh = SLACK_DEFAULT_CHANNEL;
      if (!mainCh) throw new Error("SLACK_DEFAULT_CHANNEL이 설정되지 않았습니다.");

      const mainMsg = await slack.chat.postMessage({
        channel: mainCh,
        text: [
          `${emoji} *[${team.id}]* ${icon} *${sender}*${trackStr} — ${label}`,
          summary,
        ].join("\n"),
        mrkdwn: true,
      });

      const identity = agentIdentity(sender, member);
      const teamMsg = await slack.chat.postMessage({
        channel: team.channelId,
        text: `${emoji} *${label}*\n${summary}`,
        mrkdwn: true,
        username: identity.username,
        icon_emoji: identity.icon_emoji,
      });

      if (details) {
        await sendSmart(team.channelId, details, {
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

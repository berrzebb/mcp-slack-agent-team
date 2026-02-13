/**
 * Dashboard & Heartbeat tools:
 * - slack_progress_dashboard: visual task progress + agent status
 * - slack_heartbeat: agent heartbeat ping
 * - slack_heartbeat_status: check all agent heartbeats
 * - slack_thread_summary: summarize long threads
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AGENT_PERSONAS, SLACK_DEFAULT_CHANNEL } from "../types.js";
import {
  getTeamTasks, getTeamContexts, getHeartbeats, getStaleAgents,
  updateHeartbeat, markAgentStale,
  searchInbox, addScheduledMessage,
  createPermissionRequest, resolvePermissionRequest, getPendingPermissions,
  pushMentionQueue, getPermissionStatus, getPermissionById,
} from "../db.js";
import {
  teams, getTeam, getRoleIcon, resolveChannel,
} from "../state.js";
import { slack, resolveBotUserId, sendSmart, sleep } from "../slack-client.js";
import { getRateLimiterMetrics } from "../rate-limiter.js";
import type { SlackMessage } from "../types.js";

export function registerDashboardTools(server: McpServer): void {

  // ── slack_progress_dashboard ─────────────────────────────────

  server.tool(
    "slack_progress_dashboard",
    "팀의 작업 진행률을 시각적 대시보드로 표시합니다. 진행 바, 에이전트 상태, rate limiter 상태를 한 화면에 보여줍니다.",
    {
      team_id: z.string().describe("팀 식별자"),
      post_to_channel: z.boolean().default(true).describe("팀 채널에 대시보드를 게시할지 여부"),
    },
    async ({ team_id, post_to_channel }) => {
      const team = getTeam(team_id);
      const tasks = getTeamTasks(team_id);
      const contexts = getTeamContexts(team_id);
      const heartbeats = getHeartbeats();
      const staleAgents = getStaleAgents();
      const metrics = getRateLimiterMetrics();

      // Task statistics
      const total = tasks.length;
      const done = tasks.filter((t) => t.status === "done").length;
      const inProgress = tasks.filter((t) => t.status === "in-progress").length;
      const blocked = tasks.filter((t) => t.status === "blocked").length;
      const pending = tasks.filter((t) => ["pending", "assigned"].includes(t.status)).length;
      const review = tasks.filter((t) => t.status === "review").length;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;

      // Progress bar (20 chars wide)
      const barLen = 20;
      const filled = Math.round((pct / 100) * barLen);
      const progressBar = "█".repeat(filled) + "░".repeat(barLen - filled);

      // Agent status table
      const agentLines: string[] = [];
      for (const [memberId, member] of team.members) {
        const icon = getRoleIcon(member.role);
        const persona = AGENT_PERSONAS[member.role];
        const hb = heartbeats.find((h) => h.agent_id === memberId);
        const isStale = staleAgents.some((s) => s.agent_id === memberId);
        const statusEmoji = isStale ? "🔴" : member.status === "active" ? "🟢" : member.status === "idle" ? "🟡" : "✅";
        const hbAge = hb ? timeSince(hb.last_seen) : "N/A";
        const name = persona?.displayName || memberId;
        agentLines.push(`${statusEmoji} ${icon} *${name}* (${memberId}) — ${member.status} | HB: ${hbAge}`);
      }

      // Build dashboard text
      const dashboard = [
        `📊 *팀 ${team_id} 대시보드* — ${team.name}`,
        "",
        `*진행률:* ${pct}%  \`${progressBar}\`  (${done}/${total})`,
        "",
        `🟢 완료 ${done} | 🔄 진행 ${inProgress} | 🚫 차단 ${blocked} | 👀 리뷰 ${review} | ⏳ 대기 ${pending}`,
        "",
        "*에이전트 상태:*",
        ...agentLines,
        "",
        `*Rate Limiter:* 요청 ${metrics.totalRequests} | 제한 ${metrics.totalRateLimited} | 토큰 ${metrics.currentTokens}`,
        ...(staleAgents.length > 0 ? [
          "",
          `⚠️ *무응답 에이전트 (${staleAgents.length}명):* ${staleAgents.map((s) => s.agent_id).join(", ")}`,
        ] : []),
      ].join("\n");

      if (post_to_channel) {
        await sendSmart(team.channelId, dashboard);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            team_id,
            progress_pct: pct,
            tasks: { total, done, in_progress: inProgress, blocked, review, pending },
            agents: agentLines.length,
            stale_agents: staleAgents.map((s) => s.agent_id),
            rate_limiter: metrics,
            dashboard_text: dashboard,
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_heartbeat ──────────────────────────────────────────

  server.tool(
    "slack_heartbeat",
    "에이전트 생존 신호(heartbeat)를 보냅니다. 주기적으로 호출하여 리더가 에이전트 상태를 추적할 수 있게 합니다.",
    {
      agent_id: z.string().describe("에이전트/멤버 ID"),
      team_id: z.string().optional().describe("팀 식별자"),
      current_task: z.string().optional().describe("현재 수행 중인 작업 설명"),
    },
    async ({ agent_id, team_id, current_task }) => {
      updateHeartbeat(agent_id, team_id, current_task ? { current_task } : undefined);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            agent_id,
            timestamp: new Date().toISOString(),
            message: "Heartbeat recorded",
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_heartbeat_status ───────────────────────────────────

  server.tool(
    "slack_heartbeat_status",
    "모든 에이전트의 heartbeat 상태를 조회합니다. 무응답 에이전트를 감지하여 리더에게 알립니다.",
    {
      threshold_minutes: z.number().min(1).max(60).default(5).describe("이 시간(분) 이상 heartbeat가 없는 에이전트를 무응답으로 판단"),
      notify_lead: z.boolean().default(false).describe("true 시 무응답 에이전트가 있으면 메인 채널에 알림"),
    },
    async ({ threshold_minutes, notify_lead }) => {
      const heartbeats = getHeartbeats();
      const stale = getStaleAgents(threshold_minutes);

      // Mark stale agents
      for (const agent of stale) {
        markAgentStale(agent.agent_id);
      }

      if (notify_lead && stale.length > 0 && SLACK_DEFAULT_CHANNEL) {
        const names = stale.map((s) => `*${s.agent_id}*`).join(", ");
        await slack.chat.postMessage({
          channel: SLACK_DEFAULT_CHANNEL,
          text: `⚠️ *무응답 에이전트 감지* (${threshold_minutes}분 이상): ${names}\n리더의 확인이 필요합니다.`,
          mrkdwn: true,
        });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            total_agents: heartbeats.length,
            alive: heartbeats.filter((h) => h.status === "alive").length,
            stale: stale.length,
            agents: heartbeats.map((h) => ({
              agent_id: h.agent_id,
              team_id: h.team_id,
              status: h.status,
              last_seen: h.last_seen,
              age: timeSince(h.last_seen),
            })),
            stale_agents: stale.map((s) => s.agent_id),
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_thread_summary ─────────────────────────────────────

  server.tool(
    "slack_thread_summary",
    "긴 스레드를 자동으로 요약합니다. 20개 이상의 메시지가 있는 스레드를 compact하게 정리합니다.",
    {
      thread_ts: z.string().describe("요약할 스레드의 원본 메시지 ts"),
      channel: z.string().optional().describe("채널 ID (미지정 시 기본 채널)"),
      max_messages: z.number().min(5).max(200).default(100).describe("가져올 최대 메시지 수"),
      post_summary: z.boolean().default(false).describe("true 시 요약을 스레드에 게시"),
    },
    async ({ thread_ts, channel, max_messages, post_summary }) => {
      const ch = resolveChannel(channel);

      const result = await slack.conversations.replies({
        channel: ch,
        ts: thread_ts,
        limit: max_messages,
      });

      const messages = (result.messages || []) as SlackMessage[];
      if (messages.length < 2) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: true, message: "스레드에 요약할 메시지가 없습니다.", count: messages.length }, null, 2),
          }],
        };
      }

      // Build summary
      const userMsgCounts = new Map<string, number>();
      const keyMessages: string[] = [];
      let totalLength = 0;

      for (const m of messages) {
        const user = m.user || "unknown";
        userMsgCounts.set(user, (userMsgCounts.get(user) || 0) + 1);
        totalLength += (m.text || "").length;

        // Keep messages that seem important (long, contain key patterns)
        const text = m.text || "";
        if (
          text.length > 200 ||
          text.includes("✅") || text.includes("❌") ||
          text.includes("*결론*") || text.includes("*요약*") ||
          text.includes("DONE") || text.includes("BLOCKED") ||
          text.includes("[BROADCAST]") || text.includes("[승인")
        ) {
          keyMessages.push(`[${m.ts}] <${user}>: ${text.substring(0, 300)}`);
        }
      }

      const participants = [...userMsgCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([user, count]) => `<${user}>: ${count}건`)
        .join(", ");

      const summary = [
        `📝 *스레드 요약* (${messages.length}개 메시지)`,
        "",
        `*참여자:* ${participants}`,
        `*총 텍스트 길이:* ${totalLength.toLocaleString()} chars`,
        `*기간:* ${messages[0].ts} → ${messages[messages.length - 1].ts}`,
        "",
        keyMessages.length > 0
          ? `*주요 메시지 (${keyMessages.length}건):*\n${keyMessages.slice(0, 10).join("\n")}`
          : "*주요 메시지:* 특별한 패턴 없음",
      ].join("\n");

      if (post_summary) {
        await sendSmart(ch, summary, { thread_ts });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            thread_ts,
            message_count: messages.length,
            participants: Object.fromEntries(userMsgCounts),
            total_text_length: totalLength,
            key_messages_count: keyMessages.length,
            summary,
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_search_inbox ───────────────────────────────────────

  server.tool(
    "slack_search_inbox",
    "인박스에서 키워드로 메시지를 검색합니다. FTS5 전문검색을 사용하여 빠르게 원하는 메시지를 찾습니다.",
    {
      query: z.string().describe("검색할 키워드 또는 문구"),
      limit: z.number().min(1).max(50).default(20).describe("최대 결과 수"),
    },
    async ({ query, limit }) => {
      const results = searchInbox(query, limit);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            query,
            count: results.length,
            results: results.map((r) => ({
              ts: r.message_ts,
              channel: r.channel_id,
              user: r.user_id,
              text: (r.text || "").substring(0, 500),
              thread_ts: r.thread_ts,
              status: r.status,
              fetched_at: r.fetched_at,
            })),
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_pin_message ────────────────────────────────────────

  server.tool(
    "slack_pin_message",
    "중요한 메시지를 채널에 고정합니다. 중요 결정사항, 스펙, 회의록 등을 고정할 때 사용.",
    {
      timestamp: z.string().describe("고정할 메시지의 타임스탬프 (ts)"),
      channel: z.string().optional().describe("채널 ID (미지정 시 기본 채널)"),
      unpin: z.boolean().default(false).describe("true 시 고정 해제"),
    },
    async ({ timestamp, channel, unpin }) => {
      const ch = resolveChannel(channel);

      try {
        if (unpin) {
          await slack.pins.remove({ channel: ch, timestamp });
          return { content: [{ type: "text", text: `📌 메시지 고정 해제 완료 (ts: ${timestamp})` }] };
        } else {
          await slack.pins.add({ channel: ch, timestamp });
          return { content: [{ type: "text", text: `📌 메시지 고정 완료 (ts: ${timestamp})` }] };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("already_pinned")) {
          return { content: [{ type: "text", text: `📌 이미 고정된 메시지입니다 (ts: ${timestamp})` }] };
        }
        throw err;
      }
    }
  );

  // ── slack_send_dm ────────────────────────────────────────────

  server.tool(
    "slack_send_dm",
    "특정 사용자에게 DM(다이렉트 메시지)을 보냅니다. 민감한 정보나 개인 알림에 사용.",
    {
      user_id: z.string().describe("DM을 보낼 Slack 사용자 ID (예: U01ABCDEF)"),
      message: z.string().describe("전송할 메시지 내용"),
    },
    async ({ user_id, message }) => {
      // Open DM channel
      const openResult = await slack.conversations.open({ users: user_id });
      const dmChannelId = openResult.channel?.id;

      if (!dmChannelId) throw new Error("DM 채널 열기 실패");

      const result = await sendSmart(dmChannelId, message);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            dm_channel: dmChannelId,
            ts: result.ts,
            user_id,
            method: result.method,
            message: "DM 전송 완료",
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_schedule_message ───────────────────────────────────

  server.tool(
    "slack_schedule_message",
    "예약된 시간에 메시지를 전송합니다. 리마인더, 정기 보고, 예약 알림에 사용. Slack의 chat.scheduleMessage API를 사용합니다.",
    {
      message: z.string().describe("전송할 메시지 내용"),
      post_at: z.string().describe("전송 시간 (ISO 8601 형식: 2024-01-15T09:00:00Z 또는 Unix timestamp 문자열)"),
      channel: z.string().optional().describe("채널 ID (미지정 시 기본 채널)"),
      thread_ts: z.string().optional().describe("스레드에 예약 답장할 경우 ts"),
    },
    async ({ message, post_at, channel, thread_ts }) => {
      const ch = resolveChannel(channel);

      // Parse post_at to Unix timestamp
      let unixTs: number;
      if (/^\d{10,}$/.test(post_at)) {
        unixTs = parseInt(post_at, 10);
      } else {
        unixTs = Math.floor(new Date(post_at).getTime() / 1000);
      }

      if (unixTs <= Math.floor(Date.now() / 1000)) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: "예약 시간이 현재 시각보다 이전입니다. 미래 시각을 지정하세요.",
            }, null, 2),
          }],
        };
      }

      try {
        const result = await slack.chat.scheduleMessage({
          channel: ch,
          text: message,
          post_at: unixTs,
          ...(thread_ts ? { thread_ts } : {}),
        });

        // Also record in DB for tracking
        addScheduledMessage(
          ch, message, new Date(unixTs * 1000).toISOString(),
          thread_ts, "slack_api",
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              scheduled_message_id: result.scheduled_message_id,
              post_at: new Date(unixTs * 1000).toISOString(),
              channel: ch,
              message: `✅ 메시지 예약 완료 — ${new Date(unixTs * 1000).toLocaleString()}에 전송됩니다.`,
            }, null, 2),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: msg,
              hint: msg.includes("time_in_past") ? "예약 시간이 과거입니다." : "메시지 예약 실패",
            }, null, 2),
          }],
        };
      }
    }
  );

  // ── slack_team_request_permission ────────────────────────────

  server.tool(
    "slack_team_request_permission",
    "팀원이 리더에게 위험한 작업의 승인을 요청합니다. ⚠️ 메시지 보내기/읽기/보고 등 일반 Slack 작업에는 사용하지 마세요 — 그런 작업은 slack_team_send, slack_team_read, slack_team_report를 직접 호출하세요. DB 마이그레이션, 프로덕션 배포, 파일 삭제 등 파괴적/비가역적 작업에만 사용.",
    {
      team_id: z.string().describe("팀 식별자"),
      requester: z.string().describe("요청하는 팀원 멤버 ID"),
      action: z.string().describe("수행하려는 위험한 작업 (예: 'DB 마이그레이션', '프로덕션 배포', 'API 키 생성'). 일반 메시지/읽기/보고는 권한이 불필요."),
      reason: z.string().describe("권한이 필요한 이유"),
      timeout_seconds: z.number().min(30).max(600).default(180).describe("리더 응답 대기 시간 (초). 기본 180초(3분)."),
      poll_interval_seconds: z.number().min(2).max(30).default(5).describe("폴링 간격 (초)."),
    },
    async ({ team_id, requester, action, reason, timeout_seconds, poll_interval_seconds }) => {
      // Auto-approve basic Slack operations that never need permission
      const actionLower = action.toLowerCase();
      const BASIC_OPS_PATTERNS = [
        /\b(send|보내|전송|메시지|message|msg|chat)\b/i,
        /\b(read|읽|조회|check|확인|fetch)\b/i,
        /\b(report|보고|알림|notify|notification)\b/i,
        /\b(mention|멘션|mention_check)\b/i,
        /\b(heartbeat|status|상태)\b/i,
        /\bslack_team_(send|read|report|broadcast|thread|wait|register)\b/i,
        /\bslack_(mention_check|check_all_notifications|heartbeat)\b/i,
      ];
      const isBasicOp = BASIC_OPS_PATTERNS.some(p => p.test(action));
      if (isBasicOp) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              approved: true,
              method: "auto_approved",
              action,
              message: `✅ 자동 승인 — '${action}'은(는) 기본 작업이므로 권한 요청이 불필요합니다. 해당 도구를 직접 호출하세요. (slack_team_send, slack_team_read, slack_team_report 등)`,
            }, null, 2),
          }],
        };
      }

      const team = getTeam(team_id);
      const member = team.members.get(requester);
      const myUserId = await resolveBotUserId();

      // Find lead member
      const leadEntry = [...team.members.entries()].find(([, m]) => m.role === "lead");
      const leadId = leadEntry?.[0] || "lead";
      const leadPersona = AGENT_PERSONAS["lead"];

      // Requester identity
      const icon = member ? getRoleIcon(member.role) : "🤖";
      const persona = member ? AGENT_PERSONAS[member.role] : null;
      const requesterName = persona?.displayName || requester;

      // Post permission request to team channel
      const reqMsg = await slack.chat.postMessage({
        channel: team.channelId,
        text: [
          `🔐 *[권한 요청]* ${icon} *${requesterName}* (${requester})`,
          "",
          `*작업:* ${action}`,
          `*사유:* ${reason}`,
          "",
          `👑 *@${leadPersona?.displayName || leadId}* 님의 승인이 필요합니다.`,
          "",
          `✅ 승인 | ❌ 거부 — _리액션으로 응답해주세요._`,
          `⏳ _${timeout_seconds}초 후 자동 타임아웃_`,
        ].join("\n"),
        mrkdwn: true,
      });

      const reqTs = reqMsg.ts!;

      // Save to DB
      const permId = createPermissionRequest(team_id, requester, action, reason, reqTs, team.channelId);

      // Also notify main channel
      if (SLACK_DEFAULT_CHANNEL && SLACK_DEFAULT_CHANNEL !== team.channelId) {
        await slack.chat.postMessage({
          channel: SLACK_DEFAULT_CHANNEL,
          text: `🔐 *권한 요청* — ${requesterName} (팀 ${team_id}): ${action}\n팀 채널에서 리더 승인 대기 중.`,
          mrkdwn: true,
        });
      }

      // Store mention notification for lead
      const mentionNotice = JSON.stringify({
        from: requesterName,
        from_id: requester,
        message: `[권한 요청] ${action}: ${reason}`,
        thread_ts: reqTs,
        channel: team.channelId,
        team_id,
        ts: new Date().toISOString(),
        type: "permission_request",
        perm_id: permId,
      });

      pushMentionQueue(leadId, mentionNotice);

      // Poll for reaction from any non-bot user (leader) — staggered (1 API call/cycle)
      const deadline = Date.now() + timeout_seconds * 1000;
      const interval = poll_interval_seconds * 1000;
      let permCycle = 0;

      while (Date.now() < deadline) {
        permCycle++;
        await sleep(interval);

        // DB resolution check (every cycle, 0 API cost) — picks up slack_resolve_permission
        try {
          const dbPerm = getPermissionStatus(permId);
          if (dbPerm && dbPerm.status !== "pending") {
            const isApproved = dbPerm.status === "approved";
            const emoji = isApproved ? "white_check_mark" : "x";
            await slack.reactions.add({ channel: team.channelId, name: emoji, timestamp: reqTs }).catch(() => {});
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  approved: isApproved,
                  method: "db_resolution",
                  decided_by: dbPerm.decided_by,
                  action,
                  message: isApproved
                    ? `✅ 권한 승인됨 — ${action}. 작업을 진행하세요.`
                    : `❌ 권한 거부됨 — ${action}. 작업을 중단하세요.`,
                }, null, 2),
              }],
            };
          }
        } catch { /* DB read failed, continue to API checks */ }

        // Reactions check (odd cycles)
        if (permCycle % 2 === 1) try {
          const reactResult = await slack.reactions.get({
            channel: team.channelId,
            timestamp: reqTs,
            full: true,
          });

          const reactions = (reactResult.message as { reactions?: Array<{ name: string; users?: string[] }> })?.reactions || [];

          for (const r of reactions) {
            const nonBotUsers = (r.users || []).filter((u) => u !== myUserId);
            if (nonBotUsers.length === 0) continue;

            // Approved
            if (["white_check_mark", "+1", "heavy_check_mark", "thumbsup"].includes(r.name)) {
              resolvePermissionRequest(permId, "approved", nonBotUsers[0]);

              await slack.reactions.add({ channel: team.channelId, name: "white_check_mark", timestamp: reqTs }).catch(() => {});

              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    approved: true,
                    method: "reaction",
                    reaction: r.name,
                    decided_by: nonBotUsers[0],
                    action,
                    message: `✅ 권한 승인됨 — ${action}. 작업을 진행하세요.`,
                  }, null, 2),
                }],
              };
            }

            // Denied
            if (["x", "-1", "no_entry", "thumbsdown", "no_entry_sign"].includes(r.name)) {
              resolvePermissionRequest(permId, "denied", nonBotUsers[0]);

              await slack.reactions.add({ channel: team.channelId, name: "x", timestamp: reqTs }).catch(() => {});

              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    approved: false,
                    method: "reaction",
                    reaction: r.name,
                    decided_by: nonBotUsers[0],
                    action,
                    message: `❌ 권한 거부됨 — ${action}. 작업을 중단하세요.`,
                  }, null, 2),
                }],
              };
            }
          }
        } catch {
          // reactions.get failed, continue polling
        }

        // Also check thread replies (even cycles)
        if (permCycle % 2 === 0) try {
          const threadResult = await slack.conversations.replies({
            channel: team.channelId,
            ts: reqTs,
            oldest: reqTs,
            limit: 10,
          });

          const replies = ((threadResult.messages || []) as SlackMessage[])
            .filter((m) => m.ts !== reqTs && m.user !== myUserId);

          if (replies.length > 0) {
            const latest = replies[replies.length - 1];
            const text = (latest.text || "").toLowerCase().trim();

            const approvePatterns = ["승인", "확인", "진행", "ok", "yes", "approve", "lgtm", "go"];
            const denyPatterns = ["거부", "거절", "중단", "no", "deny", "reject", "stop"];

            const isApproved = approvePatterns.some((p) => text.includes(p));
            const isDenied = denyPatterns.some((p) => text.includes(p));

            if (isApproved || isDenied) {
              const decision = isApproved ? "approved" : "denied";
              resolvePermissionRequest(permId, decision, latest.user || "user");

              const emoji = isApproved ? "white_check_mark" : "x";
              await slack.reactions.add({ channel: team.channelId, name: emoji, timestamp: reqTs }).catch(() => {});

              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    approved: isApproved,
                    method: "text",
                    reply_text: latest.text,
                    decided_by: latest.user,
                    action,
                    message: isApproved
                      ? `✅ 권한 승인됨 — ${action}. 작업을 진행하세요.`
                      : `❌ 권한 거부됨 — ${action}. 작업을 중단하세요.`,
                  }, null, 2),
                }],
              };
            }
          }
        } catch {
          // thread read failed
        }
      }

      // Timeout
      await slack.reactions.add({ channel: team.channelId, name: "hourglass", timestamp: reqTs }).catch(() => {});

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: false,
            approved: null,
            reason: "timeout",
            timeout_seconds,
            action,
            message: `⏰ ${timeout_seconds}초 동안 리더 응답 없음. 재요청하거나 메인 채널에서 사용자에게 직접 문의하세요.`,
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_list_permissions ───────────────────────────────────

  server.tool(
    "slack_list_permissions",
    "팀의 대기 중인 권한 요청 목록을 조회합니다. 리더가 미처리 요청을 확인할 때 사용. slack_resolve_permission으로 승인/거부합니다.",
    {
      team_id: z.string().describe("팀 식별자"),
    },
    async ({ team_id }) => {
      const pending = getPendingPermissions(team_id);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            team_id,
            count: pending.length,
            requests: pending.map((p) => ({
              id: p.id,
              requester: p.requester_id,
              action: p.action,
              reason: p.reason,
              message_ts: p.message_ts,
              channel: p.channel_id,
              created_at: p.created_at,
              hint: `slack_resolve_permission(permission_id=${p.id}, decision="approved" 또는 "denied")로 처리`,
            })),
            message: pending.length > 0
              ? `대기 중인 권한 요청 ${pending.length}건. slack_resolve_permission으로 승인/거부하세요.`
              : "대기 중인 권한 요청 없음",
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_resolve_permission ─────────────────────────────────

  server.tool(
    "slack_resolve_permission",
    "리더/서브리더가 팀원의 권한 요청을 승인/거부합니다. slack_list_permissions 또는 slack_check_all_notifications로 대기 요청을 확인 후 호출. 요청자의 대기 폴링에 자동 감지됩니다.",
    {
      permission_id: z.number().describe("권한 요청 ID (slack_list_permissions에서 확인)"),
      decision: z.enum(["approved", "denied"]).describe("승인(approved) 또는 거부(denied)"),
      decided_by: z.string().describe("결정한 리더의 멤버 ID (예: Aria, Nova)"),
      reason: z.string().optional().describe("결정 사유 (거부 시 권장)"),
    },
    async ({ permission_id, decision, decided_by, reason }) => {
      // Look up the permission request
      const perm = getPermissionById(permission_id);

      if (!perm) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: false, error: `권한 요청 #${permission_id}을 찾을 수 없습니다.` }, null, 2),
          }],
        };
      }

      if (perm.status !== "pending") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: `이미 처리됨: ${perm.status}`,
              permission_id,
            }, null, 2),
          }],
        };
      }

      // Resolve in DB — this will be picked up by the requester's polling loop
      resolvePermissionRequest(permission_id, decision, decided_by);

      // Post response message in thread for visibility
      const emoji = decision === "approved" ? "✅" : "❌";
      const label = decision === "approved" ? "승인" : "거부";
      const reasonText = reason ? `\n*사유:* ${reason}` : "";

      try {
        await slack.chat.postMessage({
          channel: perm.channel_id,
          thread_ts: perm.message_ts,
          text: [
            `${emoji} *권한 ${label}됨*`,
            `*작업:* ${perm.action}`,
            `*요청자:* ${perm.requester_id}`,
            `*결정자:* ${decided_by}`,
            reasonText,
          ].filter(Boolean).join("\n"),
          mrkdwn: true,
        });

        // Add visual reaction
        const reactionName = decision === "approved" ? "white_check_mark" : "x";
        await slack.reactions.add({ channel: perm.channel_id, name: reactionName, timestamp: perm.message_ts }).catch(() => {});
      } catch (e) {
        console.error(`[resolve_permission] Slack message failed:`, e);
      }

      // Notify requester via mention queue
      const notice = JSON.stringify({
        from: decided_by,
        from_id: decided_by,
        message: `[권한 ${label}] ${perm.action}${reason ? ` — ${reason}` : ""}`,
        channel: perm.channel_id,
        team_id: perm.team_id,
        ts: new Date().toISOString(),
        type: "permission_resolved",
        perm_id: permission_id,
        decision,
      });

      try {
        pushMentionQueue(perm.requester_id, notice);
      } catch { /* ignore */ }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            permission_id,
            decision,
            action: perm.action,
            requester: perm.requester_id,
            decided_by,
            message: `${emoji} 권한 요청 #${permission_id} ${label}됨 — ${perm.action}`,
          }, null, 2),
        }],
      };
    }
  );
}

// ── Helpers ────────────────────────────────────────────────────

function timeSince(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

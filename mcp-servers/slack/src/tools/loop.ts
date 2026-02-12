/**
 * Command loop tools: check_inbox, command_loop, wait_for_reply.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SlackMessage } from "../types.js";
import { resolveChannel } from "../state.js";
import { saveState } from "../state.js";
import { slack, resolveBotUserId, sleep } from "../slack-client.js";
import { enrichMessage, getWorkflowInstructions, findTeamMentions } from "../formatting.js";
import {
  inboxIngest, inboxGetUnread, inboxMarkAllRead,
  getChannelCursor, setChannelCursor,
  addWatchedThread,
} from "../db.js";
import { pollNow } from "../background-poller.js";

export function registerLoopTools(server: McpServer): void {

  // ── slack_check_inbox ────────────────────────────────────────

  server.tool(
    "slack_check_inbox",
    "SQLite 인박스에서 미읽 메시지를 확인합니다. 백그라운드 폴러가 10초마다 자동 수집하므로, 대부분의 메시지는 이미 인박스에 있습니다. fresh=true로 즉시 최신 Slack API 데이터를 가져올 수도 있습니다.",
    {
      channel: z.string().optional().describe("채널 ID (미지정 시 기본 채널)"),
      mark_as_read: z.boolean().default(true).describe("true: 읽은 후 인박스에서 제거. false: peek 모드 (남겨둠)"),
      include_bot: z.boolean().default(false).describe("봇 메시지도 포함할지 여부"),
      agent_id: z.string().default("main").describe("읽는 에이전트 식별자 (read_by에 기록)"),
      fresh: z.boolean().default(false).describe("true: 즉시 Slack API에서 최신 메시지를 가져온 후 인박스 확인. false(기본): 백그라운드 폴러가 수집한 인박스만 확인 (빠름)."),
    },
    async ({ channel, mark_as_read, include_bot, agent_id, fresh }) => {
      const ch = resolveChannel(channel);
      const myUserId = await resolveBotUserId();

      // Fresh fetch if requested — triggers background poller immediately
      if (fresh) {
        await pollNow();
      }

      // Read from SQLite inbox (already populated by background poller)
      let unread = inboxGetUnread(ch);

      // Filter out bot messages if not wanted
      if (!include_bot) {
        unread = unread.filter((r) => r.user_id !== myUserId);
      }

      if (mark_as_read && unread.length > 0) {
        inboxMarkAllRead(ch, agent_id);
      }

      const cursor = getChannelCursor(ch);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            unread_count: unread.length,
            channel: ch,
            cursor_ts: cursor || "(none - first read)",
            source: fresh ? "fresh_fetch" : "background_poller",
            messages: unread.map((r) => ({
              text: r.text,
              user: r.user_id,
              ts: r.message_ts,
              thread_ts: r.thread_ts,
              type: r.thread_ts ? "thread_reply" : "channel_message",
              reply_to: r.thread_ts
                ? { method: "slack_respond" as const, thread_ts: r.thread_ts, channel: ch }
                : { method: "slack_respond" as const, channel: ch },
            })),
            hint: unread.length > 0
              ? `미읽 메시지 ${unread.length}건. ${mark_as_read ? "인박스에서 제거됨." : "peek 모드 — 인박스에 남아있음."}`
              : "미읽 메시지가 없습니다. (백그라운드 폴러가 10초마다 수집 중)",
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_command_loop ───────────────────────────────────────

  server.tool(
    "slack_command_loop",
    "Slack에서 사용자의 다음 명령을 대기합니다. Claude Code 채팅 인터페이스를 완전히 대체하는 핵심 도구입니다. 사용자가 명령을 입력할 때까지 polling하고, 명령을 수신하면 자동으로 👀 리액션 후 명령 내용을 반환합니다. 채널별 읽기 커서를 자동 추적하여 메시지 유실을 방지합니다.",
    {
      channel: z.string().optional().describe("명령을 수신할 Slack 채널 ID"),
      timeout_seconds: z.number().min(10).max(600).default(300).describe("대기 시간 (초). 기본 300초(5분). 타임아웃 시 재호출 필요."),
      poll_interval_seconds: z.number().min(2).max(30).default(3).describe("폴링 간격 (초). 기본 3초."),
      since_ts: z.string().optional().describe("이 타임스탬프 이후의 메시지만 감지. 미지정 시 채널 읽기 커서를 자동 사용 (권장)."),
      greeting: z.string().optional().describe("대기 시작 시 채널에 보낼 메시지 (예: '✅ 이전 작업 완료. 다음 명령을 기다립니다.')"),
      watch_threads: z.array(z.string()).optional().describe("감시할 스레드 ts 목록. 이 스레드에 새 답장이 달리면 명령으로 인식. 미지정 시 봇의 최근 메시지 스레드를 자동 감시."),
    },
    async ({ channel, timeout_seconds, poll_interval_seconds, since_ts, greeting, watch_threads }) => {
      const ch = resolveChannel(channel);
      const myUserId = await resolveBotUserId();

      // Register explicit watch_threads into SQLite for background poller
      if (watch_threads) {
        for (const ts of watch_threads) {
          addWatchedThread(ch, ts, "command_loop:explicit");
        }
      }

      if (greeting) {
        const greetMsg = await slack.chat.postMessage({
          channel: ch,
          text: greeting,
          mrkdwn: true,
        });
        if (greetMsg.ts) {
          setChannelCursor(ch, greetMsg.ts);
          addWatchedThread(ch, greetMsg.ts, "command_loop:greeting");
        }
      }

      if (since_ts) {
        setChannelCursor(ch, since_ts);
      }

      const deadline = Date.now() + timeout_seconds * 1000;
      const interval = poll_interval_seconds * 1000;

      // 기존 unread 확인
      const existingUnread = inboxGetUnread(ch);
      if (existingUnread.length > 0) {
        const latest = existingUnread[existingUnread.length - 1];
        inboxMarkAllRead(ch, "command_loop");
        setChannelCursor(ch, latest.message_ts);

        try {
          await slack.reactions.add({ channel: ch, name: "eyes", timestamp: latest.message_ts });
        } catch { /* already reacted */ }

        saveState({ loop: { active: true, channel: ch, last_ts: latest.message_ts, started_at: new Date().toISOString() } });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              command_received: true,
              source: "inbox_backlog",
              ...enrichMessage(
                { text: latest.text, user: latest.user_id, ts: latest.message_ts, thread_ts: latest.thread_ts },
                ch,
              ),
              channel: ch,
              all_messages: existingUnread.map((r) => enrichMessage(
                { text: r.text, user: r.user_id, ts: r.message_ts, thread_ts: r.thread_ts },
                ch,
              )),
              unread_count: existingUnread.length,
              workflow: getWorkflowInstructions(existingUnread.length,
                existingUnread.some((r) => findTeamMentions(r.text).length > 0)),
            }, null, 2),
          }],
        };
      }

      // Polling loop — SQLite-first: background poller가 10초마다 수집한 데이터를 읽음
      while (Date.now() < deadline) {
        // 백그라운드 폴러의 최신 데이터를 즉시 반영
        await pollNow();

        // SQLite inbox에서 미읽 메시지 확인
        let unread = inboxGetUnread(ch);
        unread = unread.filter((r) => r.user_id !== myUserId);

        if (unread.length > 0) {
          inboxMarkAllRead(ch, "command_loop");

          const latest = unread[unread.length - 1];
          setChannelCursor(ch, latest.message_ts);

          try {
            await slack.reactions.add({ channel: ch, name: "eyes", timestamp: latest.message_ts });
          } catch { /* already reacted */ }

          saveState({
            loop: {
              active: true,
              channel: ch,
              last_ts: latest.message_ts,
              started_at: new Date().toISOString(),
            },
          });

          const sorted = unread.map((r) => ({
            text: r.text,
            user: r.user_id,
            ts: r.message_ts,
            thread_ts: r.thread_ts,
          } as SlackMessage));

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                command_received: true,
                ...enrichMessage(sorted[sorted.length - 1], ch),
                channel: ch,
                all_messages: sorted.map((m) => enrichMessage(m, ch)),
                unread_count: sorted.length,
                workflow: getWorkflowInstructions(sorted.length,
                  sorted.some((m) => findTeamMentions(m.text).length > 0)),
              }, null, 2),
            }],
          };
        }

        await sleep(interval);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            command_received: false,
            timeout: true,
            waited_seconds: timeout_seconds,
            channel: ch,
            hint: "타임아웃. slack_command_loop()를 다시 호출하여 대기를 재개하세요. 커서는 자동 유지됩니다.",
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_wait_for_reply ─────────────────────────────────────

  server.tool(
    "slack_wait_for_reply",
    "사용자의 새 메시지 또는 스레드 답장을 대기합니다. 지정된 시간 동안 polling하여 새 메시지를 감지합니다.",
    {
      channel: z.string().optional().describe("Slack 채널 ID (미지정 시 기본 채널 사용)"),
      thread_ts: z.string().optional().describe("특정 스레드의 답장만 대기할 경우 해당 스레드의 ts. 미지정 시 채널 전체 메시지 대기."),
      since_ts: z.string().optional().describe("이 타임스탬프 이후의 메시지만 감지. 미지정 시 현재 시점 이후."),
      timeout_seconds: z.number().min(5).max(300).default(60).describe("대기 시간 (초). 기본 60초, 최대 300초."),
      poll_interval_seconds: z.number().min(2).max(30).default(5).describe("폴링 간격 (초). 기본 5초."),
    },
    async ({ channel, thread_ts, since_ts, timeout_seconds, poll_interval_seconds }) => {
      const ch = resolveChannel(channel);
      const myUserId = await resolveBotUserId();
      const baseTs = since_ts || String(Math.floor(Date.now() / 1000)) + ".000000";

      const deadline = Date.now() + timeout_seconds * 1000;
      const interval = poll_interval_seconds * 1000;

      while (Date.now() < deadline) {
        try {
          let messages: SlackMessage[] = [];

          if (thread_ts) {
            const result = await slack.conversations.replies({
              channel: ch,
              ts: thread_ts,
              oldest: baseTs,
              limit: 20,
            });
            messages = ((result.messages || []) as SlackMessage[]).filter(
              (m) => m.ts !== thread_ts
            );
          } else {
            const result = await slack.conversations.history({
              channel: ch,
              oldest: baseTs,
              limit: 20,
            });
            messages = (result.messages || []) as SlackMessage[];
          }

          const userMessages = messages.filter((m) => m.user !== myUserId);

          if (userMessages.length > 0) {
            const sorted = [...userMessages].reverse();
            // Ingest into inbox for reliable tracking
            inboxIngest(ch, sorted);
            inboxMarkAllRead(ch, "wait_for_reply");
            const latestTs = sorted[sorted.length - 1].ts;
            setChannelCursor(ch, latestTs);

            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  received: true,
                  count: sorted.length,
                  messages: sorted.map((m) => enrichMessage(m, ch)),
                  channel: ch,
                }, null, 2),
              }],
            };
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes("rate_limited")) {
            await sleep(10000);
            continue;
          }
          throw err;
        }

        await sleep(interval);
      }

      return {
        content: [{
          type: "text",
          text: `⏰ ${timeout_seconds}초 동안 새 메시지가 없었습니다.`,
        }],
      };
    }
  );
}

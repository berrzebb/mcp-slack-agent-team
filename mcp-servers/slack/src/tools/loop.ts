/**
 * Command loop tools: check_inbox, command_loop, wait_for_reply.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SlackMessage, InboxRow } from "../types.js";
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

// ── Reaction-as-Command ────────────────────────────────────────

/** Reaction names that map to specific command intents */
const REACTION_COMMANDS: Record<string, string> = {
  // Approval / continue
  white_check_mark: "승인",
  heavy_check_mark: "승인",
  "+1":             "승인",
  thumbsup:         "승인",
  rocket:           "진행",
  // Deny / stop
  x:                "거부",
  "-1":             "거부",
  thumbsdown:       "거부",
  no_entry_sign:    "중단",
  octagonal_sign:   "중단",
  // Other actions
  eyes:             "_ack_",    // skip — bot's own ack marker
  hourglass_flowing_sand: "_ack_",
  repeat:           "재시도",
  recycle:          "재시도",
  wastebasket:      "취소",
  question:         "설명해줘",
  construction:     "크런치",
};

/**
 * Check reactions on a specific message for user (non-bot) reactions.
 * Returns the first meaningful reaction command or null.
 */
async function checkReactionCommand(
  ch: string, ts: string, botUserId: string,
): Promise<{ command: string; reaction: string; user: string } | null> {
  try {
    const result = await slack.reactions.get({ channel: ch, timestamp: ts, full: true });
    const reactions = (result.message as { reactions?: Array<{ name: string; users?: string[] }> })?.reactions || [];

    for (const r of reactions) {
      const nonBotUsers = (r.users || []).filter((u: string) => u !== botUserId);
      if (nonBotUsers.length === 0) continue;

      const cmd = REACTION_COMMANDS[r.name];
      if (cmd && cmd !== "_ack_") {
        return { command: cmd, reaction: r.name, user: nonBotUsers[0] };
      }
    }
  } catch { /* reactions.get failed */ }
  return null;
}

/**
 * Get the bot's most recent message ts in a channel (for reaction watching).
 */
async function findLastBotMessageTs(ch: string, botUserId: string): Promise<string | null> {
  try {
    const result = await slack.conversations.history({ channel: ch, limit: 10 });
    const msgs = (result.messages || []) as SlackMessage[];
    const botMsg = msgs.find((m) => m.user === botUserId || (m as unknown as Record<string, unknown>).bot_id);
    return botMsg?.ts || null;
  } catch { return null; }
}

// ── Digest Builder ─────────────────────────────────────────────

interface DigestGroup {
  user: string;
  thread_ts: string | null;
  count: number;
  first_ts: string;
  last_ts: string;
  messages: string[];       // text excerpts
  reply_to: { method: string; channel: string; thread_ts?: string };
}

/**
 * Groups unread messages by (user, thread) and produces a compact digest.
 * Consecutive messages from the same user in the same thread are merged.
 */
function buildDigest(rows: InboxRow[], channel: string): {
  total: number;
  groups: DigestGroup[];
  combined_text: string;
} {
  const key = (r: InboxRow) => `${r.user_id || "unknown"}::${r.thread_ts || "channel"}`;
  const map = new Map<string, DigestGroup>();

  for (const r of rows) {
    const k = key(r);
    const existing = map.get(k);
    const excerpt = (r.text || "").substring(0, 300);

    if (existing) {
      existing.count++;
      existing.last_ts = r.message_ts;
      existing.messages.push(excerpt);
    } else {
      map.set(k, {
        user: r.user_id || "unknown",
        thread_ts: r.thread_ts,
        count: 1,
        first_ts: r.message_ts,
        last_ts: r.message_ts,
        messages: [excerpt],
        reply_to: r.thread_ts
          ? { method: "slack_respond", channel, thread_ts: r.thread_ts }
          : { method: "slack_respond", channel },
      });
    }
  }

  const groups = [...map.values()];

  // Build a single combined text block for easy consumption
  const lines: string[] = [];
  for (const g of groups) {
    const threadLabel = g.thread_ts ? ` (thread ${g.thread_ts})` : "";
    lines.push(`── 👤 ${g.user}${threadLabel} (${g.count}건) ──`);
    for (const m of g.messages) {
      lines.push(`  • ${m}`);
    }
  }

  return {
    total: rows.length,
    groups,
    combined_text: lines.join("\n"),
  };
}

export function registerLoopTools(server: McpServer): void {

  // ── slack_check_inbox ────────────────────────────────────────

  server.tool(
    "slack_check_inbox",
    "SQLite 인박스에서 미읽 메시지를 확인합니다. digest=true 시 누적 메시지를 사용자별/스레드별로 그룹핑하여 요약 다이제스트로 반환합니다. 백그라운드 폴러가 10초마다 자동 수집하므로 대부분의 메시지는 이미 인박스에 있습니다.",
    {
      channel: z.string().optional().describe("채널 ID (미지정 시 기본 채널)"),
      mark_as_read: z.boolean().default(true).describe("true: 읽은 후 인박스에서 제거. false: peek 모드 (남겨둠)"),
      include_bot: z.boolean().default(false).describe("봇 메시지도 포함할지 여부"),
      agent_id: z.string().default("main").describe("읽는 에이전트 식별자 (read_by에 기록)"),
      fresh: z.boolean().default(false).describe("true: 즉시 Slack API에서 최신 메시지를 가져온 후 인박스 확인. false(기본): 백그라운드 폴러가 수집한 인박스만 확인 (빠름)."),
      digest: z.boolean().default(false).describe("true: 누적 메시지를 사용자별/스레드별로 그룹핑하여 요약 다이제스트로 반환. 메시지가 많을 때 한눈에 파악 가능."),
    },
    async ({ channel, mark_as_read, include_bot, agent_id, fresh, digest }) => {
      const ch = resolveChannel(channel);
      const myUserId = await resolveBotUserId();

      if (fresh) {
        await pollNow();
      }

      let unread = inboxGetUnread(ch);

      if (!include_bot) {
        unread = unread.filter((r) => r.user_id !== myUserId);
      }

      if (mark_as_read && unread.length > 0) {
        inboxMarkAllRead(ch, agent_id);
      }

      const cursor = getChannelCursor(ch);

      // ── Digest mode: group & summarize ───────────────────────
      if (digest && unread.length > 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              unread_count: unread.length,
              channel: ch,
              cursor_ts: cursor || "(none)",
              mode: "digest",
              digest: buildDigest(unread, ch),
              hint: `${unread.length}건 → 다이제스트 생성됨. ${mark_as_read ? "인박스에서 제거됨." : "peek 모드."}`,
            }, null, 2),
          }],
        };
      }

      // ── Normal mode (unchanged) ──────────────────────────────
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

      // Track bot's message ts for reaction watching
      let watchReactionTs: string | null = null;
      if (greeting) {
        // Use the greeting's ts that was set above
        watchReactionTs = await findLastBotMessageTs(ch, myUserId);
      } else {
        // Watch the bot's most recent message in channel
        watchReactionTs = await findLastBotMessageTs(ch, myUserId);
      }

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

        // Auto-digest when 5+ messages accumulated
        const useDigest = existingUnread.length >= 5;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              command_received: true,
              source: "inbox_backlog",
              mode: useDigest ? "digest" : "normal",
              ...enrichMessage(
                { text: latest.text, user: latest.user_id, ts: latest.message_ts, thread_ts: latest.thread_ts },
                ch,
              ),
              channel: ch,
              ...(useDigest
                ? { digest: buildDigest(existingUnread, ch) }
                : {
                    all_messages: existingUnread.map((r) => enrichMessage(
                      { text: r.text, user: r.user_id, ts: r.message_ts, thread_ts: r.thread_ts },
                      ch,
                    )),
                  }
              ),
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

        // 1) 리액션 확인 (봇의 마지막 메시지에 대한 사용자 리액션)
        if (watchReactionTs) {
          const reaction = await checkReactionCommand(ch, watchReactionTs, myUserId);
          if (reaction) {
            saveState({
              loop: { active: true, channel: ch, last_ts: watchReactionTs, started_at: new Date().toISOString() },
            });

            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  command_received: true,
                  source: "reaction",
                  text: reaction.command,
                  reaction: reaction.reaction,
                  user: reaction.user,
                  reacted_message_ts: watchReactionTs,
                  channel: ch,
                  reply_to: { method: "slack_respond", channel: ch },
                  workflow: [`사용자가 :${reaction.reaction}: 리액션으로 "${reaction.command}" 명령을 보냈습니다.`],
                }, null, 2),
              }],
            };
          }
        }

        // 2) SQLite inbox에서 미읽 메시지 확인
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
    "사용자의 새 메시지, 스레드 답장, 또는 리액션을 대기합니다. 사용자가 봇 메시지에 ✅/❌ 등 리액션을 추가하면 해당 명령으로 인식합니다.",
    {
      channel: z.string().optional().describe("Slack 채널 ID (미지정 시 기본 채널 사용)"),
      thread_ts: z.string().optional().describe("특정 스레드의 답장만 대기할 경우 해당 스레드의 ts. 미지정 시 채널 전체 메시지 대기."),
      since_ts: z.string().optional().describe("이 타임스탬프 이후의 메시지만 감지. 미지정 시 현재 시점 이후."),
      watch_message_ts: z.string().optional().describe("이 메시지에 대한 리액션을 감시. 미지정 시 봇의 최근 메시지 자동 감시."),
      timeout_seconds: z.number().min(5).max(300).default(60).describe("대기 시간 (초). 기본 60초, 최대 300초."),
      poll_interval_seconds: z.number().min(2).max(30).default(5).describe("폴링 간격 (초). 기본 5초."),
    },
    async ({ channel, thread_ts, since_ts, watch_message_ts, timeout_seconds, poll_interval_seconds }) => {
      const ch = resolveChannel(channel);
      const myUserId = await resolveBotUserId();
      const baseTs = since_ts || String(Math.floor(Date.now() / 1000)) + ".000000";

      // Determine which message to monitor for reactions
      const reactionTargetTs = watch_message_ts || await findLastBotMessageTs(ch, myUserId);

      const deadline = Date.now() + timeout_seconds * 1000;
      const interval = poll_interval_seconds * 1000;

      while (Date.now() < deadline) {
        try {
          // 1) 리액션 확인
          if (reactionTargetTs) {
            const reaction = await checkReactionCommand(ch, reactionTargetTs, myUserId);
            if (reaction) {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    received: true,
                    source: "reaction",
                    count: 1,
                    messages: [{
                      text: reaction.command,
                      user: reaction.user,
                      ts: reactionTargetTs,
                      reaction: reaction.reaction,
                    }],
                    channel: ch,
                    hint: `사용자가 :${reaction.reaction}: 리액션 → "${reaction.command}"`,
                  }, null, 2),
                }],
              };
            }
          }

          // 2) 텍스트 메시지 확인
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

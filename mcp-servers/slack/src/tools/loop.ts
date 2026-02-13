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

  // Cap messages per group to prevent context overflow
  const MAX_PER_GROUP = 5;
  for (const g of groups) {
    if (g.messages.length > MAX_PER_GROUP) {
      const skippedCount = g.messages.length - MAX_PER_GROUP;
      g.messages = g.messages.slice(-MAX_PER_GROUP);
      g.messages.unshift(`(... ${skippedCount}건 이전 메시지 생략 ...)`);
    }
  }

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

      // Auto-fresh: inbox가 비어있으면 자동으로 pollNow 실행 (10초 폴링 지연 방지)
      if (unread.length === 0 && !fresh) {
        try { await pollNow(); } catch { /* best effort */ }
        unread = inboxGetUnread(ch);
        if (!include_bot) {
          unread = unread.filter((r) => r.user_id !== myUserId);
        }
      }

      if (mark_as_read && unread.length > 0) {
        inboxMarkAllRead(ch, agent_id);
      }

      // Add 👀 reaction to latest user message to signal acknowledgment
      if (unread.length > 0) {
        const latest = unread[unread.length - 1];
        try { await slack.reactions.add({ channel: ch, name: "eyes", timestamp: latest.message_ts }); } catch { /* already reacted */ }
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
    "Slack에서 사용자의 다음 명령을 대기합니다. timeout_seconds=0이면 인박스와 리액션을 1회 확인 후 즉시 반환합니다 (논블로킹 — 작업 중간에 주기적으로 호출하여 Slack 명령을 놓치지 않도록 사용). timeout_seconds>0이면 해당 시간만큼 polling합니다.",
    {
      channel: z.string().optional().describe("명령을 수신할 Slack 채널 ID"),
      timeout_seconds: z.number().min(0).max(600).default(300).describe("대기 시간 (초). 0=논블로킹(1회 체크). 기본 300초(5분)."),
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

      // 기존 unread 확인 — 오래된 메시지 폭주 방지를 위해 최신 N건만 처리
      let existingUnread = inboxGetUnread(ch);
      // Filter out bot's own messages from backlog (prevent self-command loop)
      existingUnread = existingUnread.filter((r) => r.user_id !== myUserId);
      const totalBacklogCount = existingUnread.length;
      const MAX_BACKLOG = 30;
      if (existingUnread.length > MAX_BACKLOG) {
        existingUnread = existingUnread.slice(-MAX_BACKLOG);
      }
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
              unread_count: totalBacklogCount,
              skipped: totalBacklogCount > MAX_BACKLOG ? totalBacklogCount - MAX_BACKLOG : 0,
              workflow: getWorkflowInstructions(totalBacklogCount,
                existingUnread.some((r) => findTeamMentions(r.text).length > 0)),
            }, null, 2),
          }],
        };
      }

      // ── Non-blocking mode (timeout_seconds === 0) ─────────────────
      // Trigger a fresh poll so inbox is up-to-date, then check.
      if (timeout_seconds === 0) {
        try { await pollNow(); } catch { /* best effort */ }

        // Re-check inbox after fresh poll
        let freshUnread = inboxGetUnread(ch);
        freshUnread = freshUnread.filter((r) => r.user_id !== myUserId);
        if (freshUnread.length > 0) {
          const latest = freshUnread[freshUnread.length - 1];
          inboxMarkAllRead(ch, "command_loop");
          setChannelCursor(ch, latest.message_ts);
          try { await slack.reactions.add({ channel: ch, name: "eyes", timestamp: latest.message_ts }); } catch { /* already reacted */ }
          saveState({ loop: { active: true, channel: ch, last_ts: latest.message_ts, started_at: new Date().toISOString() } });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                command_received: true,
                source: "inbox_fresh",
                non_blocking: true,
                ...enrichMessage(
                  { text: latest.text, user: latest.user_id, ts: latest.message_ts, thread_ts: latest.thread_ts },
                  ch,
                ),
                channel: ch,
                all_messages: freshUnread.map((r) => enrichMessage(
                  { text: r.text, user: r.user_id, ts: r.message_ts, thread_ts: r.thread_ts }, ch,
                )),
                unread_count: freshUnread.length,
                workflow: getWorkflowInstructions(freshUnread.length,
                  freshUnread.some((r) => findTeamMentions(r.text).length > 0)),
              }, null, 2),
            }],
          };
        }

        if (watchReactionTs) {
          const reaction = await checkReactionCommand(ch, watchReactionTs, myUserId);
          if (reaction) {
            saveState({ loop: { active: true, channel: ch, last_ts: watchReactionTs, started_at: new Date().toISOString() } });
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  command_received: true,
                  source: "reaction",
                  non_blocking: true,
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
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              command_received: false,
              non_blocking: true,
              channel: ch,
              hint: "논블로킹: 새 명령 없음. 현재 작업을 계속 진행하세요.",
              IMPORTANT: "⚠️ 반드시 5~10개 도구 호출마다 또는 30초마다 slack_command_loop(timeout_seconds=0) 또는 slack_check_inbox()를 재호출하세요. 주기적으로 체크하지 않으면 사용자 명령을 놓칩니다.",
              next_check: "5~10 tool calls 또는 30초 후",
            }, null, 2),
          }],
        };
      }

      // ── Blocking polling loop ─────────────────────────────────
      // inbox-first: 대부분 cycle은 SQLite만 확인 (0 API calls)
      // 매 4번째 cycle에만 Slack API로 fresh pull (1 API call)
      // 매 3번째 cycle에만 reactions.get (1 API call)
      let cycleCount = 0;
      const FRESH_PULL_EVERY = 4;
      const REACTION_CHECK_EVERY = 3;

      while (Date.now() < deadline) {
        cycleCount++;

        // Fresh pull from Slack API (every 4th cycle only)
        if (cycleCount % FRESH_PULL_EVERY === 0) {
          try {
            const pollCursor = getChannelCursor(ch);
            const histResult = await slack.conversations.history({
              channel: ch, limit: 10,
              ...(pollCursor ? { oldest: pollCursor } : {}),
            });
            const freshMsgs = (histResult.messages || []) as SlackMessage[];
            const newMsgs = freshMsgs.filter(
              m => !pollCursor || m.ts !== pollCursor
            );
            if (newMsgs.length > 0) {
              inboxIngest(ch, newMsgs);
              const latestNewTs = newMsgs.reduce((max, m) => m.ts > max ? m.ts : max, newMsgs[0].ts);
              setChannelCursor(ch, latestNewTs);
            }
          } catch {
            // Rate limited or Slack API error — fall through to inbox check
          }
        }

        // 1) 리액션 확인 (매 3rd cycle — 봇의 마지막 메시지에 대한 사용자 리액션)
        if (watchReactionTs && cycleCount % REACTION_CHECK_EVERY === 0) {
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
        const allUnread = inboxGetUnread(ch);
        const userUnread = allUnread.filter((r) => r.user_id !== myUserId);
        // Bot messages (team reports sent via bot identity) — track as background activity
        const botActivity = allUnread.filter((r) => r.user_id === myUserId);

        if (userUnread.length > 0) {
          inboxMarkAllRead(ch, "command_loop");

          const latest = userUnread[userUnread.length - 1];
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

          const sorted = userUnread.map((r) => ({
            text: r.text,
            user: r.user_id,
            ts: r.message_ts,
            thread_ts: r.thread_ts,
          } as SlackMessage));

          // Include team activity summary if any bot messages accumulated
          const teamActivitySummary = botActivity.length > 0
            ? {
                team_activity: {
                  count: botActivity.length,
                  recent: botActivity.slice(-5).map((r) => ({
                    text: (r.text || "").substring(0, 200),
                    ts: r.message_ts,
                  })),
                  hint: botActivity.length > 5
                    ? `+${botActivity.length - 5}건 추가 팀 활동. slack_check_inbox(include_bot=true)로 전체 확인.`
                    : undefined,
                },
              }
            : {};

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                command_received: true,
                ...enrichMessage(sorted[sorted.length - 1], ch),
                channel: ch,
                all_messages: sorted.map((m) => enrichMessage(m, ch)),
                unread_count: sorted.length,
                ...teamActivitySummary,
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
    "사용자의 새 메시지, 스레드 답장, 또는 리액션을 대기합니다. timeout_seconds=0이면 1회 확인 후 즉시 반환 (논블로킹). 사용자가 봇 메시지에 ✅/❌ 등 리액션을 추가하면 해당 명령으로 인식합니다.",
    {
      channel: z.string().optional().describe("Slack 채널 ID (미지정 시 기본 채널 사용)"),
      thread_ts: z.string().optional().describe("특정 스레드의 답장만 대기할 경우 해당 스레드의 ts. 미지정 시 채널 전체 메시지 대기."),
      since_ts: z.string().optional().describe("이 타임스탬프 이후의 메시지만 감지. 미지정 시 현재 시점 이후."),
      watch_message_ts: z.string().optional().describe("이 메시지에 대한 리액션을 감시. 미지정 시 봇의 최근 메시지 자동 감시."),
      timeout_seconds: z.number().min(0).max(300).default(60).describe("대기 시간 (초). 0=논블로킹. 기본 60초, 최대 300초."),
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

      // ── Non-blocking mode (timeout_seconds === 0) ─────────────
      if (timeout_seconds === 0) {
        // Trigger a fresh poll so inbox is up-to-date
        try { await pollNow(); } catch { /* best effort */ }

        // Reaction
        if (reactionTargetTs) {
          const reaction = await checkReactionCommand(ch, reactionTargetTs, myUserId);
          if (reaction) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  received: true, non_blocking: true, source: "reaction", count: 1,
                  messages: [{ text: reaction.command, user: reaction.user, ts: reactionTargetTs, reaction: reaction.reaction }],
                  channel: ch,
                }, null, 2),
              }],
            };
          }
        }
        // Inbox
        let unread = inboxGetUnread(ch)
          .filter((r) => r.user_id !== myUserId)
          .filter((r) => r.message_ts > baseTs);
        if (thread_ts) unread = unread.filter((r) => r.thread_ts === thread_ts);
        if (unread.length > 0) {
          inboxMarkAllRead(ch, "wait_for_reply");
          const latestTs = unread[unread.length - 1].message_ts;
          setChannelCursor(ch, latestTs);
          try { await slack.reactions.add({ channel: ch, name: "eyes", timestamp: latestTs }); } catch { /* already reacted */ }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                received: true, non_blocking: true, source: "inbox", count: unread.length,
                messages: unread.map((r) => enrichMessage(
                  { text: r.text, user: r.user_id, ts: r.message_ts, thread_ts: r.thread_ts }, ch,
                )),
                channel: ch,
              }, null, 2),
            }],
          };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              received: false, non_blocking: true, channel: ch,
              hint: "논블로킹: 새 메시지 없음. 현재 작업을 계속하세요.",
              IMPORTANT: "⚠️ 반드시 5~10개 도구 호출마다 또는 30초마다 slack_wait_for_reply(timeout_seconds=0) 또는 slack_check_inbox()를 재호출하세요. 주기적으로 체크하지 않으면 사용자 응답을 놓칩니다.",
              next_check: "5~10 tool calls 또는 30초 후",
            }, null, 2),
          }],
        };
      }

      // ── Blocking polling loop ─────────────────────────────────
      let cycleCount = 0;
      const API_EVERY = 3; // Only call Slack API every 3rd cycle

      while (Date.now() < deadline) {
        cycleCount++;
        const doApiFetch = cycleCount % API_EVERY === 0;

        try {
          // 1) 리액션 확인 (every 3rd cycle)
          if (reactionTargetTs && doApiFetch) {
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

          // 2) Inbox-first: check SQLite for messages already ingested by poller
          let unread = inboxGetUnread(ch)
            .filter((r) => r.user_id !== myUserId)
            .filter((r) => r.message_ts > baseTs);

          // Thread filter: if waiting for a specific thread, only show those
          if (thread_ts) {
            unread = unread.filter((r) => r.thread_ts === thread_ts);
          }

          if (unread.length > 0) {
            inboxMarkAllRead(ch, "wait_for_reply");
            const latestTs = unread[unread.length - 1].message_ts;
            setChannelCursor(ch, latestTs);
            try { await slack.reactions.add({ channel: ch, name: "eyes", timestamp: latestTs }); } catch { /* already reacted */ }

            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  received: true,
                  source: "inbox",
                  count: unread.length,
                  messages: unread.map((r) => enrichMessage(
                    { text: r.text, user: r.user_id, ts: r.message_ts, thread_ts: r.thread_ts },
                    ch,
                  )),
                  channel: ch,
                }, null, 2),
              }],
            };
          }

          // 3) Fresh API pull (every 3rd cycle as fallback)
          if (doApiFetch) {
            let messages: SlackMessage[] = [];
            if (thread_ts) {
              const result = await slack.conversations.replies({
                channel: ch, ts: thread_ts, oldest: baseTs, limit: 20,
              });
              messages = ((result.messages || []) as SlackMessage[]).filter(
                (m) => m.ts !== thread_ts
              );
            } else {
              const result = await slack.conversations.history({
                channel: ch, oldest: baseTs, limit: 20,
              });
              messages = (result.messages || []) as SlackMessage[];
            }

            const userMessages = messages.filter((m) => m.user !== myUserId);
            if (userMessages.length > 0) {
              const sorted = [...userMessages].reverse();
              inboxIngest(ch, sorted);
              inboxMarkAllRead(ch, "wait_for_reply");
              const latestTs = sorted[sorted.length - 1].ts;
              setChannelCursor(ch, latestTs);
              try { await slack.reactions.add({ channel: ch, name: "eyes", timestamp: latestTs }); } catch { /* already reacted */ }

              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    received: true,
                    source: "api",
                    count: sorted.length,
                    messages: sorted.map((m) => enrichMessage(m, ch)),
                    channel: ch,
                  }, null, 2),
                }],
              };
            }
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

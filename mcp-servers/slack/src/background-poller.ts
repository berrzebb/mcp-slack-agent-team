/**
 * Background Poller — 도구 호출 없이도 Slack 메시지를 지속적으로 수집.
 *
 * 문제: 에이전트가 긴 작업(cargo clippy, 31개 도구 호출 등)을 수행하는 동안
 *       Slack 도구를 호출할 수 없어 메시지가 수집되지 않음.
 *
 * 해결: MCP 서버 프로세스 내에 setInterval 기반 백그라운드 폴러를 실행.
 *       - 10초 간격으로 기본 채널 + 팀 채널 + 감시 스레드 자동 수집
 *       - 모든 메시지를 SQLite inbox에 적재
 *       - 에이전트가 check_inbox 호출 시 이미 메시지가 준비되어 있음
 */

import type { SlackMessage } from "./types.js";
import { SLACK_DEFAULT_CHANNEL } from "./types.js";
import { slack, resolveBotUserId } from "./slack-client.js";
import {
  inboxIngest, getChannelCursor, setChannelCursor,
  getWatchedThreads,
} from "./db.js";
import { teams } from "./state.js";

// ── Configuration ──────────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.BG_POLL_INTERVAL || "10000", 10); // 10s default
const MAX_THREAD_POLLS = 8; // max threads to poll per cycle to avoid rate limits

let pollerHandle: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

// ── Core Poll Function ─────────────────────────────────────────

async function pollOnce(): Promise<void> {
  if (isPolling) return; // prevent overlap
  isPolling = true;

  try {
    const myUserId = await resolveBotUserId();
    if (!myUserId) return;

    // Collect channels to poll: default + all team channels
    const channels = new Set<string>();
    if (SLACK_DEFAULT_CHANNEL) channels.add(SLACK_DEFAULT_CHANNEL);
    for (const team of teams.values()) {
      if (team.status === "active" && team.channelId) {
        channels.add(team.channelId);
      }
    }

    for (const ch of channels) {
      try {
        await pollChannel(ch, myUserId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("rate_limited")) {
          console.error(`[bg-poller] Rate limited on ${ch}, backing off`);
          return; // stop this cycle entirely
        }
        if (!msg.includes("channel_not_found") && !msg.includes("not_in_channel")) {
          console.error(`[bg-poller] Error polling ${ch}: ${msg}`);
        }
      }
    }
  } catch (err) {
    console.error(`[bg-poller] Unexpected error: ${err instanceof Error ? err.message : err}`);
  } finally {
    isPolling = false;
  }
}

async function pollChannel(ch: string, myUserId: string): Promise<void> {
  const cursor = getChannelCursor(ch);

  // 1. Channel history
  const result = await slack.conversations.history({
    channel: ch,
    limit: 20,
    ...(cursor ? { oldest: cursor } : {}),
  });

  let messages = (result.messages || []) as SlackMessage[];
  if (cursor) messages = messages.filter((m) => m.ts !== cursor);
  // Keep all messages including bot's own — inbox deduplication handles it
  const userMessages = messages.filter((m) => m.user !== myUserId);

  // 2. Watched threads for this channel
  const watchedThreads = getWatchedThreads(ch);
  let threadPollCount = 0;

  for (const wt of watchedThreads) {
    if (threadPollCount >= MAX_THREAD_POLLS) break;
    threadPollCount++;

    try {
      const threadResult = await slack.conversations.replies({
        channel: ch,
        ts: wt.thread_ts,
        ...(cursor ? { oldest: cursor } : {}),
        limit: 10,
      });
      const threadReplies = ((threadResult.messages || []) as SlackMessage[])
        .filter((m) => m.ts !== wt.thread_ts && (!cursor || m.ts > cursor))
        .filter((m) => m.user !== myUserId);
      for (const r of threadReplies) {
        if (!r.thread_ts) r.thread_ts = wt.thread_ts;
      }
      userMessages.push(...threadReplies);
    } catch { /* thread inaccessible */ }
  }

  // 3. Deduplicate
  const seen = new Set<string>();
  const deduped = userMessages.filter((m) => {
    if (seen.has(m.ts)) return false;
    seen.add(m.ts);
    return true;
  });

  // 4. Ingest to SQLite
  if (deduped.length > 0) {
    const inserted = inboxIngest(ch, deduped);
    if (inserted > 0) {
      console.error(`[bg-poller] ${ch}: +${inserted} new messages ingested`);
    }
    const latestTs = deduped.reduce((max, m) => m.ts > max ? m.ts : max, deduped[0].ts);
    setChannelCursor(ch, latestTs);
  }
}

// ── Start / Stop ───────────────────────────────────────────────

export function startBackgroundPoller(): void {
  if (pollerHandle) return;

  console.error(`[bg-poller] Starting (interval: ${POLL_INTERVAL_MS}ms)`);

  // Initial poll after 3s (let server finish startup)
  setTimeout(() => {
    pollOnce().catch(() => {});
  }, 3000);

  pollerHandle = setInterval(() => {
    pollOnce().catch(() => {});
  }, POLL_INTERVAL_MS);

  // Don't let the poller keep the process alive if everything else exits
  if (pollerHandle && typeof pollerHandle === "object" && "unref" in pollerHandle) {
    pollerHandle.unref();
  }
}

export function stopBackgroundPoller(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
    console.error("[bg-poller] Stopped");
  }
}

/** 즉시 한 번 폴링 (수동 트리거) */
export async function pollNow(): Promise<void> {
  await pollOnce();
}

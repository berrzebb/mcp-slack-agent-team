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
import { SLACK_DEFAULT_CHANNEL, AGENT_PERSONAS } from "./types.js";
import { slack, resolveBotUserId } from "./slack-client.js";
import {
  db, inboxIngest, getChannelCursor, setChannelCursor,
  getWatchedThreads, pushMentionQueue,
} from "./db.js";
import { teams, ensureTeamsLoaded } from "./state.js";

// ── Poller Leadership (DB-based lease) ─────────────────────────
// Only ONE MCP server process should run the background poller.
// Multiple processes (leader + teammates) all start the same code,
// so we use a DB-based lease to elect a single poller leader.
// Lease TTL = 30s; holder must renew each cycle; stale lease = takeover.

const POLLER_LEASE_KEY = "bg_poller_lease";
const POLLER_LEASE_TTL_MS = 30_000;

function tryAcquirePollerLease(): boolean {
  try {
    const myPid = process.pid.toString();
    const row = db.prepare(
      "SELECT value, updated_at FROM kv_store WHERE key = ?"
    ).get(POLLER_LEASE_KEY) as { value: string; updated_at: string } | undefined;

    if (row) {
      // SQLite datetime('now') returns UTC but without 'Z' → "YYYY-MM-DD HH:MM:SS"
      // Ensure proper UTC parsing regardless of local timezone
      const utcStr = row.updated_at.replace(" ", "T") + (row.updated_at.endsWith("Z") ? "" : "Z");
      const leaseAge = Date.now() - new Date(utcStr).getTime();
      if (leaseAge >= 0 && leaseAge < POLLER_LEASE_TTL_MS && row.value !== myPid) {
        return false; // Another process holds a fresh lease
      }
    }

    // Acquire or renew lease
    db.prepare(`
      INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(POLLER_LEASE_KEY, myPid);

    return true;
  } catch (err) {
    console.error("[bg-poller] Lease acquisition failed:", err);
    return false;
  }
}

function renewPollerLease(): void {
  try {
    db.prepare(
      "UPDATE kv_store SET updated_at = datetime('now') WHERE key = ? AND value = ?"
    ).run(POLLER_LEASE_KEY, process.pid.toString());
  } catch { /* best effort */ }
}

function releasePollerLease(): void {
  try {
    db.prepare("DELETE FROM kv_store WHERE key = ? AND value = ?")
      .run(POLLER_LEASE_KEY, process.pid.toString());
  } catch { /* best effort */ }
}

// ── Configuration ──────────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.BG_POLL_INTERVAL || "10000", 10); // 10s default
const MAX_THREAD_POLLS = 8; // max threads to poll per cycle to avoid rate limits

let pollerHandle: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

// ── Core Poll Function ─────────────────────────────────────────

async function pollOnce(): Promise<void> {
  if (isPolling) return; // prevent overlap
  isPolling = true;

  // Renew lease so other processes know this poller is alive
  renewPollerLease();

  try {
    const myUserId = await resolveBotUserId();
    if (!myUserId) return;

    // Collect channels to poll: default + all team channels
    const channels = new Set<string>();
    if (SLACK_DEFAULT_CHANNEL) channels.add(SLACK_DEFAULT_CHANNEL);
    ensureTeamsLoaded();
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
  // Ingest ALL messages including bot's own (team_report, team_send use bot identity).
  // Filtering is done at READ time (check_inbox, command_loop), not at WRITE time.
  const userMessages = messages;

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
        .filter((m) => m.ts !== wt.thread_ts && (!cursor || m.ts > cursor));
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
      // Scan for @mentions and route to mention queues
      scanAndRouteMentions(ch, deduped, myUserId);
    }
    const latestTs = deduped.reduce((max, m) => m.ts > max ? m.ts : max, deduped[0].ts);
    setChannelCursor(ch, latestTs);
  }
}

// ── Mention Auto-Routing ───────────────────────────────────────

/**
 * Scan newly ingested messages for @persona mentions and route to mention queues.
 * This ensures that even messages from human users or other channels are captured
 * in the mention queue system, so agents can discover them via slack_mention_check
 * or slack_check_all_notifications.
 *
 * Detects patterns: *@PersonaName*, @PersonaName, @role-name, @memberId
 */
function scanAndRouteMentions(ch: string, messages: SlackMessage[], botUserId: string): void {
  // Build a lookup of all known names → member IDs
  const nameToMemberIds = new Map<string, Array<{ memberId: string; teamId: string; role: string }>>();

  for (const [teamId, team] of teams) {
    if (team.status !== "active") continue;
    for (const [memberId, member] of team.members) {
      // Index by memberId, role, and persona displayName
      const keys = [memberId.toLowerCase(), member.role.toLowerCase()];
      const persona = AGENT_PERSONAS[member.role];
      if (persona) keys.push(persona.displayName.toLowerCase());

      for (const key of keys) {
        const existing = nameToMemberIds.get(key) || [];
        // Avoid duplicates
        if (!existing.some(e => e.memberId === memberId && e.teamId === teamId)) {
          existing.push({ memberId, teamId, role: member.role });
          nameToMemberIds.set(key, existing);
        }
      }
    }
  }

  if (nameToMemberIds.size === 0) return;

  // Scan each message for mentions
  for (const msg of messages) {
    if (!msg.text || msg.user === botUserId) continue;

    const text = msg.text;
    // Match patterns: *@Name*, @Name, or just persona names in bold
    const mentionPattern = /(?:\*@?|@)([a-zA-Z][a-zA-Z0-9_-]*)\*?/g;
    let match: RegExpExecArray | null;
    const mentionedMembers = new Set<string>();

    while ((match = mentionPattern.exec(text)) !== null) {
      const name = match[1].toLowerCase();
      const targets = nameToMemberIds.get(name);
      if (!targets) continue;

      for (const target of targets) {
        const key = `${target.teamId}:${target.memberId}`;
        if (mentionedMembers.has(key)) continue;
        mentionedMembers.add(key);

        const notice = JSON.stringify({
          from: msg.user || "unknown",
          from_id: msg.user || "unknown",
          message: text.substring(0, 200),
          thread_ts: msg.thread_ts || msg.ts,
          channel: ch,
          team_id: target.teamId,
          ts: new Date().toISOString(),
          type: "auto_detected",
        });

        // Queue by memberId and role
        for (const queueKey of [target.memberId, target.role]) {
          try {
            pushMentionQueue(queueKey, notice);
          } catch { /* concurrent write — best effort */ }
        }
      }
    }
  }
}

// ── Start / Stop ───────────────────────────────────────────────

export function startBackgroundPoller(): void {
  if (pollerHandle) return;

  if (!tryAcquirePollerLease()) {
    console.error(`[bg-poller] Another process holds the poller lease — skipping (pid: ${process.pid})`);
    return;
  }

  console.error(`[bg-poller] Starting (interval: ${POLL_INTERVAL_MS}ms, pid: ${process.pid})`);

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
    releasePollerLease();
    console.error("[bg-poller] Stopped");
  }
}

/** 즉시 한 번 폴링 (수동 트리거) */
export async function pollNow(): Promise<void> {
  await pollOnce();
}

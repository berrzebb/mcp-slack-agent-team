/**
 * SQLite database initialization and helpers.
 * Manages inbox, channel cursors, cost reports, and kv_store.
 */

import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { DB_FILE, STATE_DIR } from "./types.js";
import type { InboxRow, SlackMessage, TeamTask, AgentContext, TeamDecision, TaskStatus, LoopState, TeamMember } from "./types.js";

// ── Database Initialization ────────────────────────────────────

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

export const db: DatabaseType = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

// DDL wrapped in try-catch: multiple agent processes may race to create tables.
// busy_timeout handles most contention, but if DDL still fails (tables already exist
// from another process), the process must NOT crash.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id    TEXT    NOT NULL,
      message_ts    TEXT    NOT NULL,
      thread_ts     TEXT,
      user_id       TEXT,
      text          TEXT,
      raw_json      TEXT,
      status        TEXT    NOT NULL DEFAULT 'unread',
      fetched_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      read_at       TEXT,
      read_by       TEXT,
      UNIQUE(channel_id, message_ts)
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox(channel_id, status);
    CREATE INDEX IF NOT EXISTS idx_inbox_ts ON inbox(channel_id, message_ts);
    CREATE INDEX IF NOT EXISTS idx_inbox_purge ON inbox(status, fetched_at);

    CREATE TABLE IF NOT EXISTS channel_cursors (
      channel_id    TEXT PRIMARY KEY,
      last_read_ts  TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cost_reports (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       TEXT    NOT NULL DEFAULT (datetime('now')),
      report_type     TEXT,
      total_cost_usd  REAL,
      total_tokens    INTEGER,
      input_tokens    INTEGER,
      output_tokens   INTEGER,
      cache_read      INTEGER,
      cache_write     INTEGER,
      raw_json        TEXT
    );

    CREATE TABLE IF NOT EXISTS kv_store (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Team Context: structured task assignments
    CREATE TABLE IF NOT EXISTS team_tasks (
      id            TEXT    NOT NULL,
      team_id       TEXT    NOT NULL,
      title         TEXT    NOT NULL,
      description   TEXT    NOT NULL DEFAULT '',
      assigned_to   TEXT    NOT NULL,
      assigned_by   TEXT    NOT NULL,
      track         TEXT,
      dependencies  TEXT    NOT NULL DEFAULT '[]',
      status        TEXT    NOT NULL DEFAULT 'pending',
      result_summary TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT,
      PRIMARY KEY (team_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON team_tasks(team_id, assigned_to);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON team_tasks(team_id, status);

    -- Team Context: per-agent context snapshots
    CREATE TABLE IF NOT EXISTS agent_context (
      agent_id          TEXT NOT NULL,
      team_id           TEXT NOT NULL,
      role              TEXT NOT NULL,
      track             TEXT,
      current_task_id   TEXT,
      context_snapshot  TEXT NOT NULL DEFAULT '{}',
      last_updated      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team_id, agent_id)
    );

    -- Team Context: decision log
    CREATE TABLE IF NOT EXISTS team_decisions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id         TEXT    NOT NULL,
      decision_type   TEXT    NOT NULL,
      question        TEXT    NOT NULL,
      answer          TEXT    NOT NULL,
      decided_by      TEXT    NOT NULL,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_team ON team_decisions(team_id);

    -- Watched threads: bot-sent messages to monitor for user replies
    CREATE TABLE IF NOT EXISTS watched_threads (
      channel_id  TEXT NOT NULL,
      thread_ts   TEXT NOT NULL,
      context     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel_id, thread_ts)
    );
    CREATE INDEX IF NOT EXISTS idx_watched_created ON watched_threads(created_at);

    -- Agent heartbeat tracking
    CREATE TABLE IF NOT EXISTS agent_heartbeats (
      agent_id    TEXT PRIMARY KEY,
      team_id     TEXT,
      status      TEXT NOT NULL DEFAULT 'alive',
      last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
      metadata    TEXT
    );

    -- Scheduled messages
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id    TEXT    NOT NULL,
      message       TEXT    NOT NULL,
      scheduled_at  TEXT    NOT NULL,
      thread_ts     TEXT,
      status        TEXT    NOT NULL DEFAULT 'pending',
      slack_scheduled_id TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      created_by    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sched_status ON scheduled_messages(status, scheduled_at);

    -- Permission requests (leader auto-approval)
    CREATE TABLE IF NOT EXISTS permission_requests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id       TEXT    NOT NULL,
      requester_id  TEXT    NOT NULL,
      action        TEXT    NOT NULL,
      reason        TEXT    NOT NULL DEFAULT '',
      status        TEXT    NOT NULL DEFAULT 'pending',
      decided_by    TEXT,
      decision_ts   TEXT,
      message_ts    TEXT,
      channel_id    TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_perm_status ON permission_requests(team_id, status);

    -- Teams registry (replaces state.json)
    CREATE TABLE IF NOT EXISTS teams (
      id            TEXT    PRIMARY KEY,
      name          TEXT    NOT NULL,
      channel_id    TEXT    NOT NULL,
      channel_name  TEXT    NOT NULL DEFAULT '',
      status        TEXT    NOT NULL DEFAULT 'active',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Team members (replaces nested JSON in state.json)
    CREATE TABLE IF NOT EXISTS team_members (
      team_id       TEXT    NOT NULL,
      member_id     TEXT    NOT NULL,
      role          TEXT    NOT NULL,
      agent_type    TEXT    NOT NULL,
      track         TEXT,
      status        TEXT    NOT NULL DEFAULT 'active',
      joined_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team_id, member_id),
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
    );
  `);
} catch (ddlErr) {
  // Another process likely created the tables already — non-fatal
  console.error("[db] DDL init warning (likely concurrent startup):", ddlErr);
}

// ── Prepared Statements ────────────────────────────────────────

export const stmts: Record<string, Statement> = {
  inboxInsert: db.prepare(`
    INSERT OR IGNORE INTO inbox (channel_id, message_ts, thread_ts, user_id, text, raw_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  inboxUnread: db.prepare(`
    SELECT * FROM inbox WHERE channel_id = ? AND status = 'unread'
    ORDER BY message_ts ASC
  `),
  inboxMarkRead: db.prepare(`
    UPDATE inbox SET status = 'read', read_at = datetime('now'), read_by = ?
    WHERE channel_id = ? AND status = 'unread'
  `),
  inboxMarkProcessed: db.prepare(`
    UPDATE inbox SET status = 'processed'
    WHERE channel_id = ? AND message_ts = ?
  `),
  inboxCount: db.prepare(`
    SELECT COUNT(*) as cnt FROM inbox WHERE channel_id = ? AND status = 'unread'
  `),
  inboxPurgeOld: db.prepare(`
    DELETE FROM inbox WHERE status IN ('read', 'processed')
    AND fetched_at < datetime('now', '-7 days')
  `),
  cursorGet: db.prepare(`SELECT last_read_ts FROM channel_cursors WHERE channel_id = ?`),
  cursorSet: db.prepare(`
    INSERT INTO channel_cursors (channel_id, last_read_ts, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET
      last_read_ts = CASE WHEN excluded.last_read_ts > last_read_ts THEN excluded.last_read_ts ELSE last_read_ts END,
      updated_at = datetime('now')
  `),
  costInsert: db.prepare(`
    INSERT INTO cost_reports (report_type, total_cost_usd, total_tokens, input_tokens, output_tokens, cache_read, cache_write, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  costRecent: db.prepare(`SELECT * FROM cost_reports ORDER BY id DESC LIMIT ?`),
  kvGet: db.prepare(`SELECT value FROM kv_store WHERE key = ?`),
  kvSet: db.prepare(`
    INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `),
  kvDelete: db.prepare(`DELETE FROM kv_store WHERE key = ?`),

  // ── Team Tasks ─────────────────────────────────────────────
  taskUpsert: db.prepare(`
    INSERT INTO team_tasks (id, team_id, title, description, assigned_to, assigned_by, track, dependencies, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(team_id, id) DO UPDATE SET
      title = excluded.title, description = excluded.description,
      assigned_to = excluded.assigned_to, track = excluded.track,
      dependencies = excluded.dependencies, status = excluded.status,
      updated_at = datetime('now')
  `),
  taskUpdateStatus: db.prepare(`
    UPDATE team_tasks SET status = ?, result_summary = ?,
      updated_at = datetime('now'),
      completed_at = CASE WHEN ? IN ('done', 'cancelled') THEN datetime('now') ELSE completed_at END
    WHERE team_id = ? AND id = ?
  `),
  taskGet: db.prepare(`SELECT * FROM team_tasks WHERE team_id = ? AND id = ?`),
  tasksByTeam: db.prepare(`SELECT * FROM team_tasks WHERE team_id = ? ORDER BY created_at ASC`),
  tasksByAssignee: db.prepare(`SELECT * FROM team_tasks WHERE team_id = ? AND assigned_to = ? ORDER BY created_at ASC`),
  tasksPending: db.prepare(`SELECT * FROM team_tasks WHERE team_id = ? AND status NOT IN ('done', 'cancelled') ORDER BY created_at ASC`),

  // ── Agent Context ──────────────────────────────────────────
  ctxUpsert: db.prepare(`
    INSERT INTO agent_context (agent_id, team_id, role, track, current_task_id, context_snapshot, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(team_id, agent_id) DO UPDATE SET
      role = excluded.role, track = excluded.track,
      current_task_id = excluded.current_task_id,
      context_snapshot = excluded.context_snapshot,
      last_updated = datetime('now')
  `),
  ctxGet: db.prepare(`SELECT * FROM agent_context WHERE team_id = ? AND agent_id = ?`),
  ctxByTeam: db.prepare(`SELECT * FROM agent_context WHERE team_id = ? ORDER BY agent_id ASC`),
  ctxChannelLookup: db.prepare(`SELECT context_snapshot FROM agent_context WHERE agent_id = ? AND team_id = ?`),

  // ── Team Decisions ─────────────────────────────────────────
  decisionInsert: db.prepare(`
    INSERT INTO team_decisions (team_id, decision_type, question, answer, decided_by)
    VALUES (?, ?, ?, ?, ?)
  `),
  decisionsByTeam: db.prepare(`SELECT * FROM team_decisions WHERE team_id = ? ORDER BY created_at ASC`),
  decisionsByType: db.prepare(`SELECT * FROM team_decisions WHERE team_id = ? AND decision_type = ? ORDER BY created_at ASC`),
  decisionRecent: db.prepare(`SELECT * FROM team_decisions WHERE team_id = ? ORDER BY created_at DESC LIMIT ?`),

  // ── Watched Threads ────────────────────────────────────────
  watchAdd: db.prepare(`
    INSERT OR IGNORE INTO watched_threads (channel_id, thread_ts, context)
    VALUES (?, ?, ?)
  `),
  watchGet: db.prepare(`
    SELECT thread_ts, context FROM watched_threads
    WHERE channel_id = ? AND created_at > datetime('now', '-24 hours')
    ORDER BY created_at DESC
  `),
  watchClean: db.prepare(`
    DELETE FROM watched_threads WHERE created_at < datetime('now', '-48 hours')
  `),
  watchCount: db.prepare(`
    SELECT COUNT(*) as cnt FROM watched_threads WHERE channel_id = ?
    AND created_at > datetime('now', '-24 hours')
  `),
};

// ── Inbox Helpers ──────────────────────────────────────────────

/** Slack API에서 가져온 메시지를 inbox에 삽입 (중복 무시) */
export function inboxIngest(channelId: string, messages: SlackMessage[]): number {
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const m of messages) {
      const info = stmts.inboxInsert.run(
        channelId,
        m.ts,
        m.thread_ts || null,
        m.user || null,
        m.text || null,
        JSON.stringify(m),
      );
      if (info.changes > 0) inserted++;
    }
  });
  tx();
  return inserted;
}

/** unread 메시지 조회 */
export function inboxGetUnread(channelId: string): InboxRow[] {
  return stmts.inboxUnread.all(channelId) as InboxRow[];
}

/** 채널의 unread를 모두 read로 마킹 (agent 식별자 기록) */
export function inboxMarkAllRead(channelId: string, readBy: string = "main"): void {
  stmts.inboxMarkRead.run(readBy, channelId);
}

/** 특정 메시지를 processed로 마킹 */
export function inboxMarkProcessed(channelId: string, messageTs: string): void {
  stmts.inboxMarkProcessed.run(channelId, messageTs);
}

/** unread 건수 */
export function inboxUnreadCount(channelId: string): number {
  const row = stmts.inboxCount.get(channelId) as { cnt: number };
  return row.cnt;
}

// ── FTS5 Full-Text Search on inbox ─────────────────────────────

try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS inbox_fts USING fts5(
      text, user_id, channel_id,
      content='inbox',
      content_rowid='id'
    );
  `);
  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS inbox_ai AFTER INSERT ON inbox BEGIN
      INSERT INTO inbox_fts(rowid, text, user_id, channel_id)
      VALUES (new.id, new.text, new.user_id, new.channel_id);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS inbox_ad AFTER DELETE ON inbox BEGIN
      INSERT INTO inbox_fts(inbox_fts, rowid, text, user_id, channel_id)
      VALUES ('delete', old.id, old.text, old.user_id, old.channel_id);
    END;
  `);
} catch {
  // FTS5 extension not available — search will fall back to LIKE
  console.error("[db] FTS5 not available, full-text search will use LIKE fallback");
}

// 오래된 데이터 정리 (7일 이상 read/processed)
// Wrapped in try-catch: concurrent processes may contend for write lock
try {
  stmts.inboxPurgeOld.run();
  // 오래된 watched threads 정리 (48시간 이상)
  stmts.watchClean.run();
} catch (purgeErr) {
  console.error("[db] Startup purge warning (likely concurrent access):", purgeErr);
}

// ── Auto-Purge Interval (every 6 hours) ────────────────────────

const AUTO_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

const purgeHandle = setInterval(() => {
  try {
    const purged = stmts.inboxPurgeOld.run();
    stmts.watchClean.run();
    if (purged.changes > 0) {
      console.error(`[db] Auto-purge: removed ${purged.changes} old inbox entries`);
    }
  } catch (err) {
    console.error("[db] Auto-purge error:", err);
  }
}, AUTO_PURGE_INTERVAL_MS);

if (purgeHandle && typeof purgeHandle === "object" && "unref" in purgeHandle) {
  purgeHandle.unref();
}

// ── Channel Cursor Helpers ─────────────────────────────────────

export function getChannelCursor(ch: string): string | undefined {
  const row = stmts.cursorGet.get(ch) as { last_read_ts: string } | undefined;
  return row?.last_read_ts;
}

export function setChannelCursor(ch: string, ts: string): void {
  stmts.cursorSet.run(ch, ts);
}

// ── Watched Thread Helpers ─────────────────────────────────────

/** 봇이 보낸 메시지를 감시 대상으로 등록 (스레드 답글 감지용) */
export function addWatchedThread(channelId: string, threadTs: string, context?: string): void {
  stmts.watchAdd.run(channelId, threadTs, context || null);
}

/** 채널에서 최근 24시간 내 감시 중인 스레드 목록 */
export function getWatchedThreads(channelId: string): Array<{ thread_ts: string; context: string | null }> {
  return stmts.watchGet.all(channelId) as Array<{ thread_ts: string; context: string | null }>;
}

/** 채널의 감시 스레드 수 */
export function getWatchedThreadCount(channelId: string): number {
  const row = stmts.watchCount.get(channelId) as { cnt: number };
  return row.cnt;
}

// ── Cost Report Helpers ────────────────────────────────────────

export function saveCostReport(data: {
  report_type: string;
  total_cost_usd: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
}): void {
  stmts.costInsert.run(
    data.report_type,
    data.total_cost_usd,
    data.total_tokens,
    data.input_tokens,
    data.output_tokens,
    data.cache_read,
    data.cache_write,
    null,
  );
}

// ── Team Context Helpers ───────────────────────────────────────

/** 태스크 생성/갱신 */
export function upsertTask(task: Omit<TeamTask, "created_at" | "updated_at" | "completed_at">): void {
  stmts.taskUpsert.run(
    task.id, task.team_id, task.title, task.description,
    task.assigned_to, task.assigned_by, task.track || null,
    JSON.stringify(task.dependencies), task.status,
  );
}

/** 태스크 상태 업데이트 */
export function updateTaskStatus(teamId: string, taskId: string, status: TaskStatus, resultSummary?: string): void {
  stmts.taskUpdateStatus.run(status, resultSummary || null, status, teamId, taskId);
}

/** 태스크 단건 조회 */
export function getTask(teamId: string, taskId: string): TeamTask | undefined {
  const row = stmts.taskGet.get(teamId, taskId) as Record<string, unknown> | undefined;
  return row ? parseTaskRow(row) : undefined;
}

/** 팀의 모든 태스크 */
export function getTeamTasks(teamId: string): TeamTask[] {
  return (stmts.tasksByTeam.all(teamId) as Record<string, unknown>[]).map(parseTaskRow);
}

/** 특정 에이전트에 할당된 태스크 */
export function getAgentTasks(teamId: string, agentId: string): TeamTask[] {
  return (stmts.tasksByAssignee.all(teamId, agentId) as Record<string, unknown>[]).map(parseTaskRow);
}

/** 미완료 태스크만 */
export function getPendingTasks(teamId: string): TeamTask[] {
  return (stmts.tasksPending.all(teamId) as Record<string, unknown>[]).map(parseTaskRow);
}

function parseTaskRow(row: Record<string, unknown>): TeamTask {
  return {
    id: row.id as string,
    team_id: row.team_id as string,
    title: row.title as string,
    description: row.description as string,
    assigned_to: row.assigned_to as string,
    assigned_by: row.assigned_by as string,
    track: row.track as string | undefined,
    dependencies: JSON.parse((row.dependencies as string) || "[]"),
    status: row.status as TaskStatus,
    result_summary: row.result_summary as string | undefined,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    completed_at: row.completed_at as string | undefined,
  };
}

/** 에이전트 컨텍스트 저장 */
export function saveAgentContext(ctx: AgentContext): void {
  stmts.ctxUpsert.run(
    ctx.agent_id, ctx.team_id, ctx.role, ctx.track || null,
    ctx.current_task_id || null, JSON.stringify(ctx.context_snapshot),
  );
}

/** 에이전트 컨텍스트 조회 */
export function getAgentContext(teamId: string, agentId: string): AgentContext | undefined {
  const row = stmts.ctxGet.get(teamId, agentId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    agent_id: row.agent_id as string,
    team_id: row.team_id as string,
    role: row.role as string,
    track: row.track as string | undefined,
    current_task_id: row.current_task_id as string | undefined,
    context_snapshot: JSON.parse((row.context_snapshot as string) || "{}"),
    last_updated: row.last_updated as string,
  };
}

/** 에이전트의 저장된 channelId 조회 (팀이 메모리에 없을 때 fallback용) */
export function getAgentStoredChannelId(agentId: string, teamId: string): string | undefined {
  // Try exact agent match first
  if (agentId && agentId !== "_any_") {
    const row = stmts.ctxChannelLookup.get(agentId, teamId) as { context_snapshot: string } | undefined;
    if (row) {
      try { return JSON.parse(row.context_snapshot)?.channelId; } catch { /* ignore */ }
    }
  }
  // Fallback: any agent in this team (for tools that don't know the agent_id)
  const anyRow = db.prepare(
    `SELECT context_snapshot FROM agent_context WHERE team_id = ? LIMIT 1`
  ).get(teamId) as { context_snapshot: string } | undefined;
  if (anyRow) {
    try { return JSON.parse(anyRow.context_snapshot)?.channelId; } catch { /* ignore */ }
  }
  // Last resort: check teams table directly
  const teamRow = db.prepare(
    `SELECT channel_id FROM teams WHERE id = ? AND status != 'archived' LIMIT 1`
  ).get(teamId) as { channel_id: string } | undefined;
  return teamRow?.channel_id;
}

/** 팀의 전체 에이전트 컨텍스트 */
export function getTeamContexts(teamId: string): AgentContext[] {
  return (stmts.ctxByTeam.all(teamId) as Record<string, unknown>[]).map((row) => ({
    agent_id: row.agent_id as string,
    team_id: row.team_id as string,
    role: row.role as string,
    track: row.track as string | undefined,
    current_task_id: row.current_task_id as string | undefined,
    context_snapshot: JSON.parse((row.context_snapshot as string) || "{}"),
    last_updated: row.last_updated as string,
  }));
}

/** 의사결정 기록 */
export function logDecision(d: TeamDecision): void {
  stmts.decisionInsert.run(d.team_id, d.decision_type, d.question, d.answer, d.decided_by);
}

/** 팀의 모든 의사결정 */
export function getTeamDecisions(teamId: string): TeamDecision[] {
  return stmts.decisionsByTeam.all(teamId) as TeamDecision[];
}

/** 특정 유형의 의사결정 */
export function getDecisionsByType(teamId: string, type: string): TeamDecision[] {
  return stmts.decisionsByType.all(teamId, type) as TeamDecision[];
}

/** 최근 N개 의사결정 */
export function getRecentDecisions(teamId: string, limit: number = 10): TeamDecision[] {
  return stmts.decisionRecent.all(teamId, limit) as TeamDecision[];
}

// ── Heartbeat Helpers ──────────────────────────────────────────

const stmtHeartbeatUpsert = db.prepare(`
  INSERT INTO agent_heartbeats (agent_id, team_id, status, last_seen, metadata)
  VALUES (?, ?, 'alive', datetime('now'), ?)
  ON CONFLICT(agent_id) DO UPDATE SET
    team_id = COALESCE(excluded.team_id, team_id),
    status = 'alive',
    last_seen = datetime('now'),
    metadata = COALESCE(excluded.metadata, metadata)
`);
const stmtHeartbeatAll = db.prepare(`SELECT * FROM agent_heartbeats ORDER BY last_seen DESC`);
const stmtHeartbeatStale = db.prepare(`
  SELECT agent_id, team_id, last_seen FROM agent_heartbeats
  WHERE last_seen < datetime('now', '-' || ? || ' minutes')
  AND status = 'alive'
`);
const stmtHeartbeatMarkStale = db.prepare(`UPDATE agent_heartbeats SET status = 'stale' WHERE agent_id = ?`);

export function updateHeartbeat(agentId: string, teamId?: string, metadata?: Record<string, unknown>): void {
  stmtHeartbeatUpsert.run(agentId, teamId || null, metadata ? JSON.stringify(metadata) : null);
}

export function getHeartbeats(): Array<{
  agent_id: string; team_id: string | null;
  status: string; last_seen: string; metadata: string | null;
}> {
  return stmtHeartbeatAll.all() as Array<{
    agent_id: string; team_id: string | null;
    status: string; last_seen: string; metadata: string | null;
  }>;
}

export function getStaleAgents(thresholdMinutes: number = 5): Array<{
  agent_id: string; team_id: string | null;
  last_seen: string;
}> {
  return stmtHeartbeatStale.all(thresholdMinutes) as Array<{
    agent_id: string; team_id: string | null;
    last_seen: string;
  }>;
}

export function markAgentStale(agentId: string): void {
  stmtHeartbeatMarkStale.run(agentId);
}

// ── Inbox Search Helpers ───────────────────────────────────────

let stmtSearchFts: Statement | null | undefined = null;
const stmtSearchLike = db.prepare(`
  SELECT * FROM inbox WHERE text LIKE ? ORDER BY message_ts DESC LIMIT ?
`);

// Lazily compile FTS5 query (table may not exist in all envs)
function getSearchFts() {
  if (stmtSearchFts === null) {
    try {
      stmtSearchFts = db.prepare(`
        SELECT inbox.* FROM inbox_fts
        JOIN inbox ON inbox.id = inbox_fts.rowid
        WHERE inbox_fts MATCH ?
        ORDER BY inbox.message_ts DESC LIMIT ?
      `);
    } catch {
      stmtSearchFts = undefined;  // mark as unavailable
    }
  }
  return stmtSearchFts;
}

export function searchInbox(query: string, limit: number = 20): InboxRow[] {
  const fts = getSearchFts();
  if (fts) {
    try {
      return fts.all(query, limit) as InboxRow[];
    } catch { /* FTS match syntax error — fall through */ }
  }
  return stmtSearchLike.all(`%${query}%`, limit) as InboxRow[];
}

// ── Scheduled Message Helpers ──────────────────────────────────

const stmtSchedInsert = db.prepare(`
  INSERT INTO scheduled_messages (channel_id, message, scheduled_at, thread_ts, created_by)
  VALUES (?, ?, ?, ?, ?)
`);
const stmtSchedPending = db.prepare(`
  SELECT * FROM scheduled_messages
  WHERE status = 'pending' AND scheduled_at <= datetime('now')
  ORDER BY scheduled_at ASC
`);
const stmtSchedMarkSent = db.prepare(`
  UPDATE scheduled_messages SET status = 'sent', slack_scheduled_id = ?
  WHERE id = ?
`);
const stmtSchedByChannel = db.prepare(`
  SELECT * FROM scheduled_messages WHERE channel_id = ? ORDER BY scheduled_at ASC
`);
const stmtSchedAll = db.prepare(`SELECT * FROM scheduled_messages ORDER BY scheduled_at ASC`);

export function addScheduledMessage(channelId: string, message: string, scheduledAt: string, threadTs?: string, createdBy?: string): number {
  const result = stmtSchedInsert.run(channelId, message, scheduledAt, threadTs || null, createdBy || null);
  return result.lastInsertRowid as number;
}

export function getPendingScheduledMessages(): Array<{
  id: number; channel_id: string; message: string;
  scheduled_at: string; thread_ts: string | null; status: string;
}> {
  return stmtSchedPending.all() as Array<{
    id: number; channel_id: string; message: string;
    scheduled_at: string; thread_ts: string | null; status: string;
  }>;
}

export function markScheduledSent(id: number, slackId?: string): void {
  stmtSchedMarkSent.run(slackId || null, id);
}

export function getScheduledMessages(channelId?: string): Array<{
  id: number; channel_id: string; message: string;
  scheduled_at: string; status: string; created_by: string | null;
}> {
  if (channelId) {
    return stmtSchedByChannel.all(channelId) as Array<{
      id: number; channel_id: string; message: string;
      scheduled_at: string; status: string; created_by: string | null;
    }>;
  }
  return stmtSchedAll.all() as Array<{
    id: number; channel_id: string; message: string;
    scheduled_at: string; status: string; created_by: string | null;
  }>;
}

// ── Permission Request Helpers ─────────────────────────────────

const stmtPermInsert = db.prepare(`
  INSERT INTO permission_requests (team_id, requester_id, action, reason, message_ts, channel_id)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const stmtPermResolve = db.prepare(`
  UPDATE permission_requests SET status = ?, decided_by = ?, decision_ts = datetime('now')
  WHERE id = ?
`);
const stmtPermPending = db.prepare(`
  SELECT * FROM permission_requests
  WHERE team_id = ? AND status = 'pending'
  ORDER BY created_at ASC
`);

export function createPermissionRequest(teamId: string, requesterId: string, action: string, reason: string, messageTs: string, channelId: string): number {
  const result = stmtPermInsert.run(teamId, requesterId, action, reason, messageTs, channelId);
  return result.lastInsertRowid as number;
}

export function resolvePermissionRequest(id: number, status: "approved" | "denied", decidedBy: string): void {
  stmtPermResolve.run(status, decidedBy, id);
}

export function getPendingPermissions(teamId: string): Array<{
  id: number; requester_id: string; action: string;
  reason: string; message_ts: string; channel_id: string;
  created_at: string;
}> {
  return stmtPermPending.all(teamId) as Array<{
    id: number; requester_id: string; action: string;
    reason: string; message_ts: string; channel_id: string;
    created_at: string;
  }>;
}

// ── Mention Queue Helper ───────────────────────────────────────

const stmtMentionQueueUpsert = db.prepare(
  `INSERT INTO kv_store (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = json_insert(value, '$[#]', json(?)), updated_at = datetime('now')`
);

/** Push a mention notice JSON string into the queue for the given key (memberId or role) */
export function pushMentionQueue(queueKey: string, noticeJson: string): void {
  stmtMentionQueueUpsert.run(
    `mention_queue:${queueKey}`,
    JSON.stringify([JSON.parse(noticeJson)]),
    noticeJson,
  );
}

// ── Permission Status Check (cached) ──────────────────────────

const stmtPermStatusCheck = db.prepare(
  `SELECT status, decided_by FROM permission_requests WHERE id = ?`
);

export function getPermissionStatus(id: number): { status: string; decided_by: string | null } | undefined {
  return stmtPermStatusCheck.get(id) as { status: string; decided_by: string | null } | undefined;
}

const stmtPermById = db.prepare(`SELECT * FROM permission_requests WHERE id = ?`);

export interface PermissionRequestRow {
  id: number; team_id: string; requester_id: string; action: string;
  reason: string; status: string; message_ts: string; channel_id: string;
  decided_by: string | null; decision_ts: string | null; created_at: string;
}

export function getPermissionById(id: number): PermissionRequestRow | undefined {
  return stmtPermById.get(id) as PermissionRequestRow | undefined;
}

// ── Teams DB Helpers (replaces state.json) ─────────────────────

const stmtTeamUpsert = db.prepare(`
  INSERT INTO teams (id, name, channel_id, channel_name, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name, channel_id = excluded.channel_id,
    channel_name = excluded.channel_name, status = excluded.status
`);
const stmtTeamDelete = db.prepare(`DELETE FROM teams WHERE id = ?`);
const stmtTeamGet = db.prepare(`SELECT * FROM teams WHERE id = ?`);
const stmtTeamAll = db.prepare(`SELECT * FROM teams WHERE status != 'archived' ORDER BY created_at ASC`);
const stmtTeamAllIds = db.prepare(`SELECT id FROM teams`);
const stmtTeamArchive = db.prepare(`UPDATE teams SET status = 'archived' WHERE id = ?`);
const stmtMemberUpsert = db.prepare(`
  INSERT INTO team_members (team_id, member_id, role, agent_type, track, status, joined_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(team_id, member_id) DO UPDATE SET
    role = excluded.role, agent_type = excluded.agent_type,
    track = excluded.track, status = excluded.status
`);
const stmtMembersByTeam = db.prepare(`SELECT * FROM team_members WHERE team_id = ? ORDER BY member_id ASC`);
const stmtMembersDeleteTeam = db.prepare(`DELETE FROM team_members WHERE team_id = ?`);

export interface DbTeamRow {
  id: string; name: string; channel_id: string; channel_name: string;
  status: string; created_at: string;
}
export interface DbTeamMemberRow {
  team_id: string; member_id: string; role: string; agent_type: string;
  track: string | null; status: string; joined_at: string;
}

/** Save a single team + all its members (upsert) */
export function dbSaveTeam(
  team: { id: string; name: string; channelId: string; channelName: string; status: string; createdAt: string },
  members: Array<{ id: string } & TeamMember>,
): void {
  const tx = db.transaction(() => {
    stmtTeamUpsert.run(team.id, team.name, team.channelId, team.channelName, team.status, team.createdAt);
    // Replace all members for this team
    stmtMembersDeleteTeam.run(team.id);
    for (const m of members) {
      stmtMemberUpsert.run(team.id, m.id, m.role, m.agentType, m.track || null, m.status, m.joinedAt);
    }
  });
  tx();
}

/** Load all active teams from DB */
export function dbLoadAllTeams(): Array<{ team: DbTeamRow; members: DbTeamMemberRow[] }> {
  const teamRows = stmtTeamAll.all() as DbTeamRow[];
  return teamRows.map((t) => ({
    team: t,
    members: stmtMembersByTeam.all(t.id) as DbTeamMemberRow[],
  }));
}

/** Load a single team by ID */
export function dbLoadTeam(teamId: string): { team: DbTeamRow; members: DbTeamMemberRow[] } | null {
  const t = stmtTeamGet.get(teamId) as DbTeamRow | undefined;
  if (!t) return null;
  return { team: t, members: stmtMembersByTeam.all(t.id) as DbTeamMemberRow[] };
}

/** Save all teams at once (bulk — for shutdown/periodic save).
 *  NOTE: Does NOT archive orphaned teams. In multi-process environments,
 *  each process only knows about teams it loaded or created.
 *  Archiving unknown teams would destroy teams created by other processes.
 *  Use slack_team_close for explicit archival. */
export function dbSaveAllTeams(
  teamList: Array<{
    team: { id: string; name: string; channelId: string; channelName: string; status: string; createdAt: string };
    members: Array<{ id: string } & TeamMember>;
  }>,
): void {
  const tx = db.transaction((list: typeof teamList) => {
    for (const { team, members } of list) {
      stmtTeamUpsert.run(team.id, team.name, team.channelId, team.channelName, team.status, team.createdAt);
      stmtMembersDeleteTeam.run(team.id);
      for (const m of members) {
        stmtMemberUpsert.run(team.id, m.id, m.role, m.agentType, m.track || null, m.status, m.joinedAt);
      }
    }
  });
  tx(teamList);
}

// ── Loop State (via kv_store) ──────────────────────────────────

const LOOP_STATE_KEY = "loop_state";

export function dbSaveLoopState(loop: LoopState): void {
  stmts.kvSet.run(LOOP_STATE_KEY, JSON.stringify(loop));
}

export function dbLoadLoopState(): LoopState | null {
  const row = stmts.kvGet.get(LOOP_STATE_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as LoopState;
  } catch {
    return null;
  }
}

console.error(`📦 SQLite DB initialized: ${DB_FILE}`);

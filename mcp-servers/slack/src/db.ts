/**
 * SQLite database initialization and helpers.
 * Manages inbox, channel cursors, cost reports, and kv_store.
 */

import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { DB_FILE, STATE_DIR } from "./types.js";
import type { InboxRow, SlackMessage, TeamTask, AgentContext, TeamDecision, TaskStatus } from "./types.js";

// ── Database Initialization ────────────────────────────────────

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

export const db: DatabaseType = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

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
`);

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

  // ── Team Decisions ─────────────────────────────────────────
  decisionInsert: db.prepare(`
    INSERT INTO team_decisions (team_id, decision_type, question, answer, decided_by)
    VALUES (?, ?, ?, ?, ?)
  `),
  decisionsByTeam: db.prepare(`SELECT * FROM team_decisions WHERE team_id = ? ORDER BY created_at ASC`),
  decisionsByType: db.prepare(`SELECT * FROM team_decisions WHERE team_id = ? AND decision_type = ? ORDER BY created_at ASC`),
  decisionRecent: db.prepare(`SELECT * FROM team_decisions WHERE team_id = ? ORDER BY created_at DESC LIMIT ?`),
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

// 오래된 데이터 정리 (7일 이상 read/processed)
stmts.inboxPurgeOld.run();

// ── Channel Cursor Helpers ─────────────────────────────────────

export function getChannelCursor(ch: string): string | undefined {
  const row = stmts.cursorGet.get(ch) as { last_read_ts: string } | undefined;
  return row?.last_read_ts;
}

export function setChannelCursor(ch: string, ts: string): void {
  stmts.cursorSet.run(ch, ts);
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

console.error(`📦 SQLite DB initialized: ${DB_FILE}`);

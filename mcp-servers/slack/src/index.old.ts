#!/usr/bin/env node

/**
 * Slack MCP Server
 *
 * Claude Code ↔ User 간 Slack 기반 커뮤니케이션을 위한 MCP 서버.
 *
 * Basic Tools:
 *   - slack_send_message:    채널에 메시지 전송 (자동 분할)
 *   - slack_read_messages:   채널의 최근 메시지 읽기
 *   - slack_reply_thread:    스레드에 답장 (자동 분할)
 *   - slack_wait_for_reply:  사용자의 새 메시지/답장 대기 (polling)
 *   - slack_add_reaction:    메시지에 이모지 리액션 추가
 *   - slack_list_channels:   접근 가능한 채널 목록
 *   - slack_get_thread:      스레드 전체 읽기
 *
 * Content Tools (긴 출력 처리):
 *   - slack_upload_snippet:  코드/로그를 파일로 업로드
 *   - slack_send_code:       코드 블록 전송 (syntax highlight)
 *
 * File Tools (파일/이미지 전송):
 *   - slack_download_file:   Slack에 업로드된 파일을 로컬에 다운로드
 *   - slack_upload_file:     로컬 파일을 Slack 채널에 업로드
 *
 * Command Loop:
 *   - slack_check_inbox:     미읽 메시지 확인 (커서 자동 추적, 메시지 유실 방지)
 *   - slack_command_loop:    사용자 명령 대기 루프 (채팅 대체 핵심, 커서 자동)
 *
 * Team Tools:
 *   - slack_team_create:     팀 전용 채널 생성 + 멤버 등록
 *   - slack_team_register:   팀에 새 멤버 추가
 *   - slack_team_send:       에이전트 역할로 메시지 전송
 *   - slack_team_read:       팀 채널 메시지 읽기 (sender 필터 가능)
 *   - slack_team_wait:       팀 채널에서 새 메시지 대기 (polling)
 *   - slack_team_thread:     팀 스레드 읽기/답장
 *   - slack_team_status:     팀 현황 조회
 *   - slack_team_broadcast:  전체 팀원에게 브로드캐스트
 *   - slack_team_report:     팀원이 메인 채널 + 팀 채널에 작업 상황 보고
 *   - slack_team_close:      팀 채널 아카이브
 *
 * Approval:
 *   - slack_request_approval: 사용자에게 승인 요청 후 리액션/텍스트 응답 대기
 *
 * State Management:
 *   - slack_save_state:      루프/팀 상태를 파일에 저장
 *   - slack_load_state:      저장된 상태 복원 (compact/재시작 후 복구)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from "fs";
import { resolve, dirname, basename, extname } from "path";
import { execSync } from "child_process";
import { pipeline } from "stream/promises";
import Database from "better-sqlite3";

// ── State Persistence ──────────────────────────────────────────

const STATE_DIR = resolve(process.cwd(), ".claude", "mcp-servers", "slack");
const STATE_FILE = resolve(STATE_DIR, "state.json");

interface LoopState {
  active: boolean;
  channel: string;
  last_ts: string;
  started_at: string;
  task_context?: string;
}

interface PersistentState {
  loop?: LoopState;
  teams: Record<string, {
    id: string;
    name: string;
    channelId: string;
    channelName: string;
    status: string;
    members: Record<string, TeamMember>;
    createdAt: string;
  }>;
  updated_at: string;
}

function loadState(): PersistentState | null {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {
    // corrupted state file — ignore
  }
  return null;
}

function saveState(state: Partial<PersistentState>): void {
  try {
    const existing = loadState() || { teams: {}, updated_at: "" };
    const merged = { ...existing, ...state, updated_at: new Date().toISOString() };
    if (!existsSync(dirname(STATE_FILE))) mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(merged, null, 2));
  } catch (err) {
    console.error("State save failed:", err);
  }
}

function saveTeamsToState(): void {
  const teamsObj: PersistentState["teams"] = {};
  for (const [id, team] of teams) {
    const membersObj: Record<string, TeamMember> = {};
    for (const [mid, m] of team.members) membersObj[mid] = m;
    teamsObj[id] = {
      id: team.id,
      name: team.name,
      channelId: team.channelId,
      channelName: team.channelName,
      status: team.status,
      members: membersObj,
      createdAt: team.createdAt,
    };
  }
  saveState({ teams: teamsObj });
}

function restoreTeamsFromState(): void {
  const state = loadState();
  if (!state?.teams) return;
  for (const [id, t] of Object.entries(state.teams)) {
    if (t.status === "archived") continue;
    const memberMap = new Map<string, TeamMember>();
    for (const [mid, m] of Object.entries(t.members)) memberMap.set(mid, m);
    teams.set(id, {
      id: t.id,
      name: t.name,
      channelId: t.channelId,
      channelName: t.channelName,
      members: memberMap,
      createdAt: t.createdAt,
      status: t.status as Team["status"],
    });
  }
  if (teams.size > 0) console.error(`📋 Restored ${teams.size} team(s) from state`);
}

// ── SQLite Database ────────────────────────────────────────────

const DB_FILE = resolve(STATE_DIR, "slack_mcp.db");
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

const db = new Database(DB_FILE);
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
`);

// ── Prepared Statements ────────────────────────────────────────
const stmts = {
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
};

// ── Inbox Helpers ──────────────────────────────────────────────

interface InboxRow {
  id: number;
  channel_id: string;
  message_ts: string;
  thread_ts: string | null;
  user_id: string | null;
  text: string | null;
  raw_json: string | null;
  status: string;
  fetched_at: string;
  read_at: string | null;
  read_by: string | null;
}

/** Slack API에서 가져온 메시지를 inbox에 삽입 (중복 무시) */
function inboxIngest(channelId: string, messages: SlackMessage[]): number {
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
function inboxGetUnread(channelId: string): InboxRow[] {
  return stmts.inboxUnread.all(channelId) as InboxRow[];
}

/** 채널의 unread를 모두 read로 마킹 (agent 식별자 기록) */
function inboxMarkAllRead(channelId: string, readBy: string = "main"): void {
  stmts.inboxMarkRead.run(readBy, channelId);
}

/** 특정 메시지를 processed로 마킹 */
function inboxMarkProcessed(channelId: string, messageTs: string): void {
  stmts.inboxMarkProcessed.run(channelId, messageTs);
}

/** unread 건수 */
function inboxUnreadCount(channelId: string): number {
  const row = stmts.inboxCount.get(channelId) as { cnt: number };
  return row.cnt;
}

// 오래된 데이터 정리 (7일 이상 read/processed)
stmts.inboxPurgeOld.run();

// ── Channel Cursor Helpers ─────────────────────────────────────

function getChannelCursor(ch: string): string | undefined {
  const row = stmts.cursorGet.get(ch) as { last_read_ts: string } | undefined;
  return row?.last_read_ts;
}

function setChannelCursor(ch: string, ts: string): void {
  stmts.cursorSet.run(ch, ts);
}

// ── Cost Report Helpers ────────────────────────────────────────

function saveCostReport(data: {
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

console.error(`📦 SQLite DB initialized: ${DB_FILE}`);

// ── Mention & Workflow Helpers ──────────────────────────────────

/** 메시지 텍스트에서 @agent-name 멘션을 파싱합니다 */
function parseMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  const mentions: string[] = [];
  // @agent-name 패턴 (팀 멤버 ID 형식: lead, sub-leader-A, worker-B 등)
  const pattern = /@([a-zA-Z][a-zA-Z0-9_-]*)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    mentions.push(match[1]);
  }
  return mentions;
}

/** 현재 등록된 모든 팀 멤버 ID 목록 */
function getAllTeamMemberIds(): string[] {
  const ids: string[] = [];
  for (const team of teams.values()) {
    for (const mid of team.members.keys()) {
      if (!ids.includes(mid)) ids.push(mid);
    }
  }
  return ids;
}

/** 메시지에서 팀 멤버 멘션만 필터링 */
function findTeamMentions(text: string | null | undefined): string[] {
  const allMentions = parseMentions(text);
  const memberIds = getAllTeamMemberIds();
  return allMentions.filter((m) => memberIds.includes(m));
}

/** 메시지를 워크플로우 포맷으로 변환 (mentions, type, reply_to, files 포함) */
function enrichMessage(msg: { text?: string | null; user?: string | null; ts: string; thread_ts?: string | null; files?: SlackFile[] }, ch: string) {
  const mentions = findTeamMentions(msg.text);
  const isThread = !!msg.thread_ts;
  const files = msg.files && msg.files.length > 0
    ? msg.files.map((f) => ({
        id: f.id,
        name: f.name,
        mimetype: f.mimetype,
        size: f.size,
        filetype: f.filetype,
        download: { method: "slack_download_file" as const, file_id: f.id, filename: f.name },
      }))
    : undefined;
  return {
    text: msg.text,
    user: msg.user,
    ts: msg.ts,
    thread_ts: msg.thread_ts,
    type: isThread ? "thread_reply" as const : "channel_message" as const,
    mentions: mentions.length > 0 ? mentions : undefined,
    files,
    reply_to: isThread
      ? { method: "slack_reply_thread" as const, thread_ts: msg.thread_ts!, channel: ch }
      : { method: "slack_send_message" as const, channel: ch },
  };
}

/** command_loop/check_inbox 반환 시 포함할 워크플로우 지시사항 */
function getWorkflowInstructions(unreadCount: number, hasMentions: boolean): string[] {
  const instructions: string[] = [];
  instructions.push(
    "[WORKFLOW]",
    "1. reply_to 필드를 확인 → type=thread_reply면 slack_reply_thread, type=channel_message면 slack_send_message 사용",
    "2. mentions 필드가 있으면 해당 팀원에게 slack_team_send(mention=[...])로 전달",
    "3. files 필드가 있으면 slack_download_file(file_id)로 다운로드 후 처리",
    "4. 작업 완료 후 slack_command_loop()로 다음 명령 대기",
    "5. 긴 작업 중에는 slack_check_inbox()로 중간에 미읽 메시지 확인",
  );
  if (hasMentions) {
    instructions.push("6. @멘션된 팀원에게 작업을 위임하거나 결과를 전달하세요");
  }
  return instructions;
}

// ── Configuration ──────────────────────────────────────────────

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_DEFAULT_CHANNEL = process.env.SLACK_DEFAULT_CHANNEL || "";

// Slack message limits
const SLACK_MSG_LIMIT = 3900; // Safe limit (actual: 40000, but chunking at 3900 for readability)
const SLACK_FILE_THRESHOLD = 8000; // 이 이상이면 자동으로 파일 업로드

if (!SLACK_BOT_TOKEN) {
  console.error("❌ SLACK_BOT_TOKEN environment variable is required");
  process.exit(1);
}

const slack = new WebClient(SLACK_BOT_TOKEN, {
  headers: {
    "User-Agent": "slack-mcp-server/1.0.0",
  },
});

// Bot user ID (resolved on startup)
let botUserId: string | undefined;

async function resolveBotUserId(): Promise<string> {
  if (botUserId) return botUserId;
  try {
    const auth = await slack.auth.test();
    botUserId = auth.user_id as string;
    return botUserId;
  } catch {
    return "";
  }
}

// ── Team Registry ──────────────────────────────────────────────

interface TeamMember {
  role: string;            // e.g. "lead", "sub-leader-A", "worker-A"
  agentType: string;       // e.g. "planner", "implementer", "reviewer", "validator"
  track?: string;          // e.g. "A", "B" (optional)
  status: "active" | "idle" | "done";
  joinedAt: string;        // ISO timestamp
}

interface Team {
  id: string;              // e.g. "T12", "B-6"
  name: string;            // e.g. "Feature X 구현", "버그 수정 Sprint 3"
  channelId: string;       // Slack channel ID
  channelName: string;     // Slack channel name
  rootThreadTs?: string;   // Root thread for status updates
  members: Map<string, TeamMember>;
  createdAt: string;
  status: "active" | "completed" | "archived";
}

// In-memory team store (persists for MCP server lifetime)
const teams = new Map<string, Team>();

const ROLE_ICONS: Record<string, string> = {
  lead: "👑",
  planner: "📋",
  "sub-leader": "🎯",
  implementer: "🔨",
  "test-writer": "🧪",
  validator: "✅",
  "code-reviewer": "🔍",
  debugger: "🐛",
  refactorer: "♻️",
  researcher: "🔬",
};

// Slack emoji names for icon_emoji (chat:write.customize scope)
const ROLE_SLACK_EMOJI: Record<string, string> = {
  lead: ":crown:",
  planner: ":clipboard:",
  "sub-leader": ":dart:",
  implementer: ":hammer:",
  "test-writer": ":test_tube:",
  validator: ":white_check_mark:",
  "code-reviewer": ":mag:",
  debugger: ":bug:",
  refactorer: ":recycle:",
  researcher: ":microscope:",
};

function getRoleSlackEmoji(role: string): string {
  if (ROLE_SLACK_EMOJI[role]) return ROLE_SLACK_EMOJI[role];
  for (const [key, emoji] of Object.entries(ROLE_SLACK_EMOJI)) {
    if (role.startsWith(key)) return emoji;
  }
  return ":robot_face:";
}

/**
 * Returns { username, icon_emoji } for chat.postMessage
 * so each agent appears as a distinct Slack "user".
 * Requires chat:write.customize bot scope.
 */
function agentIdentity(senderId: string, member: TeamMember): { username: string; icon_emoji: string } {
  const trackSuffix = member.track ? `-${member.track}` : "";
  // Username must be ASCII-safe (no spaces, brackets, or non-ASCII chars)
  // to avoid "Invalid character in header content" errors
  const username = `${senderId}${trackSuffix}`.replace(/[^a-zA-Z0-9._-]/g, "-");
  return {
    username,
    icon_emoji: getRoleSlackEmoji(member.role),
  };
}

function getRoleIcon(role: string): string {
  // Try exact match first, then prefix match
  if (ROLE_ICONS[role]) return ROLE_ICONS[role];
  for (const [key, icon] of Object.entries(ROLE_ICONS)) {
    if (role.startsWith(key)) return icon;
  }
  return "🤖";
}

function getTeam(teamId: string): Team {
  const team = teams.get(teamId);
  if (!team) throw new Error(`팀 '${teamId}'를 찾을 수 없습니다. 등록된 팀: ${[...teams.keys()].join(", ") || "(없음)"}`);
  return team;
}

function formatTeamStatus(team: Team): string {
  const members = [...team.members.entries()]
    .map(([id, m]) => {
      const icon = getRoleIcon(m.role);
      const track = m.track ? ` [Track ${m.track}]` : "";
      const status = m.status === "active" ? "🟢" : m.status === "idle" ? "⏸️" : "✅";
      return `${status} ${icon} *${id}* (${m.agentType})${track}`;
    })
    .join("\n");

  return [
    `*팀: ${team.name}* (${team.id})`,
    `채널: <#${team.channelId}>`,
    `상태: ${team.status}`,
    `생성: ${team.createdAt}`,
    `멤버 (${team.members.size}명):`,
    members,
  ].join("\n");
}

// ── Helpers ────────────────────────────────────────────────────

function resolveChannel(channel?: string): string {
  const ch = channel || SLACK_DEFAULT_CHANNEL;
  if (!ch) {
    throw new Error(
      "채널이 지정되지 않았습니다. channel 파라미터를 입력하거나 SLACK_DEFAULT_CHANNEL 환경변수를 설정하세요."
    );
  }
  return ch;
}

interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
  mode?: string;
}

interface SlackMessage {
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  files?: SlackFile[];
}

function formatMessages(messages: SlackMessage[]): string {
  if (messages.length === 0) return "(메시지 없음)";
  return messages
    .map((m) => {
      const thread = m.thread_ts ? ` [thread: ${m.thread_ts}]` : "";
      const replies = m.reply_count ? ` (${m.reply_count} replies)` : "";
      const fileInfo = m.files && m.files.length > 0
        ? ` [📎 ${m.files.length} file(s): ${m.files.map(f => f.name || f.id).join(", ")}]`
        : "";
      return `[${m.ts}] <${m.user}>${thread}${replies}${fileInfo}: ${m.text}`;
    })
    .join("\n");
}

// ── Long Message Handling ──────────────────────────────────────

/**
 * 긴 메시지를 자동으로 처리:
 * - 3900자 이하: 그대로 전송
 * - 3900~8000자: 여러 메시지로 분할 전송
 * - 8000자 초과: 파일로 업로드
 */
async function sendSmart(
  channel: string,
  text: string,
  options?: { thread_ts?: string; title?: string; filename?: string }
): Promise<{ ts: string; method: "message" | "chunked" | "file"; chunks?: number }> {
  const len = text.length;

  // Case 1: 짧은 메시지 - 그대로 전송
  if (len <= SLACK_MSG_LIMIT) {
    const result = await slack.chat.postMessage({
      channel,
      text,
      thread_ts: options?.thread_ts,
      mrkdwn: true,
    });
    return { ts: result.ts || "", method: "message" };
  }

  // Case 2: 중간 길이 - 청크 분할 전송
  if (len <= SLACK_FILE_THRESHOLD) {
    const chunks = splitMessage(text, SLACK_MSG_LIMIT);
    let firstTs = "";
    // 첫 번째 청크는 채널/스레드에, 나머지는 스레드로
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `_(${i + 1}/${chunks.length})_\n` : "";
      const result = await slack.chat.postMessage({
        channel,
        text: prefix + chunks[i],
        thread_ts: i === 0 ? options?.thread_ts : (firstTs || options?.thread_ts),
        mrkdwn: true,
      });
      if (i === 0) firstTs = result.ts || "";
    }
    return { ts: firstTs, method: "chunked", chunks: chunks.length };
  }

  // Case 3: 긴 내용 - 파일로 업로드
  const filename = options?.filename || `output-${Date.now()}.txt`;
  const title = options?.title || "📄 출력 결과";
  const uploadResult = await uploadContent(channel, text, {
    filename,
    title,
    thread_ts: options?.thread_ts,
  });
  return { ts: uploadResult.ts, method: "file" };
}

function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    // 단일 라인이 maxLen 초과하면 강제 분할
    if (line.length > maxLen) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += maxLen) {
        chunks.push(line.slice(i, i + maxLen));
      }
      continue;
    }

    if (current.length + line.length + 1 > maxLen) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function uploadContent(
  channel: string,
  content: string,
  options: { filename: string; title: string; thread_ts?: string; filetype?: string }
): Promise<{ ts: string; fileId: string }> {
  // Build args with required thread_ts (Slack API requires it for filesUploadV2)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any = {
    channel_id: channel,
    content,
    filename: options.filename,
    title: options.title,
  };
  if (options.thread_ts) args.thread_ts = options.thread_ts;
  if (options.filetype) args.snippet_type = options.filetype;

  const result = await slack.filesUploadV2(args);

  // filesUploadV2 returns file info
  const file = (result as { files?: Array<{ id?: string }> }).files?.[0];
  return {
    ts: options.thread_ts || "",
    fileId: file?.id || "",
  };
}

// ── MCP Server ─────────────────────────────────────────────────

const server = new McpServer({
  name: "slack-communicator",
  version: "1.0.0",
});

// ── Tool: slack_send_message ───────────────────────────────────

server.tool(
  "slack_send_message",
  "Slack 채널에 메시지를 전송합니다. 긴 메시지는 자동 분할 또는 파일 업로드됩니다. 작업 결과 보고, 질문, 상태 업데이트 등에 사용.",
  {
    message: z.string().describe("전송할 메시지 텍스트 (Slack mrkdwn 포맷 지원). 길이 제한 없음 — 자동 처리됨."),
    channel: z
      .string()
      .optional()
      .describe("Slack 채널 ID (미지정 시 기본 채널 사용)"),
    thread_ts: z
      .string()
      .optional()
      .describe("스레드에 답장할 경우 ts 값"),
  },
  async ({ message, channel, thread_ts }) => {
    const ch = resolveChannel(channel);
    const result = await sendSmart(ch, message, { thread_ts });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              channel: ch,
              ts: result.ts,
              method: result.method,
              chunks: result.chunks,
              message: result.method === "file"
                ? "내용이 길어 파일로 업로드됨"
                : result.method === "chunked"
                ? `${result.chunks}개 메시지로 분할 전송됨`
                : "메시지 전송 완료",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: slack_read_messages ──────────────────────────────────

server.tool(
  "slack_read_messages",
  "Slack 채널의 최근 메시지를 읽어옵니다. 사용자의 명령이나 피드백을 확인할 때 사용.",
  {
    channel: z
      .string()
      .optional()
      .describe("Slack 채널 ID (미지정 시 기본 채널 사용)"),
    limit: z
      .number()
      .min(1)
      .max(100)
      .default(10)
      .describe("가져올 메시지 수 (기본: 10, 최대: 100)"),
    oldest: z
      .string()
      .optional()
      .describe("이 타임스탬프 이후의 메시지만 가져옴 (Slack ts 형식)"),
  },
  async ({ channel, limit, oldest }) => {
    const ch = resolveChannel(channel);
    const result = await slack.conversations.history({
      channel: ch,
      limit,
      ...(oldest ? { oldest } : {}),
    });
    const messages = (result.messages || []) as SlackMessage[];

    // 최신 메시지가 위에 오도록 역순
    const sorted = [...messages].reverse();

    // 인박스에 저장 + 커서 업데이트
    if (sorted.length > 0) {
      inboxIngest(ch, sorted);
      inboxMarkAllRead(ch, "read_messages");
      setChannelCursor(ch, sorted[sorted.length - 1].ts);
    }

    return {
      content: [
        {
          type: "text",
          text: formatMessages(sorted),
        },
      ],
    };
  }
);

// ── Tool: slack_reply_thread ───────────────────────────────────

server.tool(
  "slack_reply_thread",
  "특정 메시지의 스레드에 답장합니다. 사용자의 명령에 대한 결과를 해당 스레드에 회신할 때 사용.",
  {
    thread_ts: z
      .string()
      .describe("답장할 원본 메시지의 타임스탬프 (ts 값)"),
    message: z.string().describe("답장 메시지 텍스트"),
    channel: z
      .string()
      .optional()
      .describe("Slack 채널 ID (미지정 시 기본 채널 사용)"),
  },
  async ({ thread_ts, message, channel }) => {
    const ch = resolveChannel(channel);
    const result = await sendSmart(ch, message, { thread_ts });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              channel: ch,
              ts: result.ts,
              thread_ts,
              method: result.method,
              message: "스레드 답장 완료",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: slack_upload_snippet ─────────────────────────────────

server.tool(
  "slack_upload_snippet",
  "코드, 빌드 로그, 에러 트레이스 등 긴 텍스트를 Slack 파일(snippet)로 업로드합니다. 40,000자 이상도 처리 가능.",
  {
    content: z.string().describe("업로드할 텍스트 내용 (길이 제한 없음)"),
    filename: z
      .string()
      .default("output.txt")
      .describe("파일명 (예: build.log, diff.patch, error.txt)"),
    title: z
      .string()
      .optional()
      .describe("파일 제목 (Slack에 표시됨)"),
    filetype: z
      .string()
      .optional()
      .describe("파일 타입 (예: rust, typescript, javascript, python, text, diff, shell). syntax highlight에 사용."),
    channel: z
      .string()
      .optional()
      .describe("Slack 채널 ID"),
    thread_ts: z
      .string()
      .optional()
      .describe("스레드에 첨부할 경우 ts"),
    comment: z
      .string()
      .optional()
      .describe("파일과 함께 보낼 코멘트 메시지"),
  },
  async ({ content, filename, title, filetype, channel, thread_ts, comment }) => {
    const ch = resolveChannel(channel);

    // 코멘트가 있으면 먼저 메시지 전송
    if (comment) {
      const msgResult = await slack.chat.postMessage({
        channel: ch,
        text: comment,
        thread_ts,
        mrkdwn: true,
      });
      // 파일을 코멘트의 스레드에 첨부
      thread_ts = thread_ts || msgResult.ts;
    }

    const result = await uploadContent(ch, content, {
      filename,
      title: title || filename,
      thread_ts,
      filetype,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              file_id: result.fileId,
              channel: ch,
              size: content.length,
              filename,
              message: `파일 업로드 완료 (${content.length.toLocaleString()}자)`,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: slack_send_code ──────────────────────────────────────

server.tool(
  "slack_send_code",
  "코드 블록을 보기 좋게 전송합니다. 짧은 코드는 인라인 코드 블록으로, 긴 코드는 파일로 자동 업로드.",
  {
    code: z.string().describe("코드 내용"),
    language: z
      .string()
      .default("text")
      .describe("프로그래밍 언어 (rust, typescript, python 등)"),
    title: z
      .string()
      .optional()
      .describe("코드 설명/제목"),
    channel: z
      .string()
      .optional()
      .describe("Slack 채널 ID"),
    thread_ts: z
      .string()
      .optional()
      .describe("스레드에 첨부할 경우 ts"),
  },
  async ({ code, language, title, channel, thread_ts }) => {
    const ch = resolveChannel(channel);
    const langExt = LANG_EXTENSIONS[language] || language;

    // 짧은 코드: 인라인 코드 블록
    if (code.length <= 3500) {
      const prefix = title ? `*${title}*\n` : "";
      const formatted = `${prefix}\`\`\`${language}\n${code}\n\`\`\``;
      const result = await slack.chat.postMessage({
        channel: ch,
        text: formatted,
        thread_ts,
        mrkdwn: true,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, ts: result.ts, method: "code_block", size: code.length },
              null,
              2
            ),
          },
        ],
      };
    }

    // 긴 코드: 파일 업로드
    const filename = title
      ? `${title.replace(/[^a-zA-Z0-9_-]/g, "_")}.${langExt}`
      : `code.${langExt}`;

    const result = await uploadContent(ch, code, {
      filename,
      title: title || `Code (${language})`,
      thread_ts,
      filetype: language,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              file_id: result.fileId,
              method: "file_upload",
              size: code.length,
              filename,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

const LANG_EXTENSIONS: Record<string, string> = {
  rust: "rs",
  typescript: "ts",
  javascript: "js",
  python: "py",
  sql: "sql",
  shell: "sh",
  bash: "sh",
  toml: "toml",
  json: "json",
  yaml: "yml",
  html: "html",
  css: "css",
  diff: "diff",
  text: "txt",
};

// ── Tool: slack_check_inbox ─────────────────────────────────────

server.tool(
  "slack_check_inbox",
  "SQLite 인박스에서 미읽 메시지를 확인합니다. Slack API에서 새 메시지를 가져와 인박스에 저장한 후, unread 메시지만 반환합니다. mark_as_read=true면 읽은 메시지는 인박스에서 제거(‘read’ 상태로 전환)됩니다.",
  {
    channel: z.string().optional().describe("채널 ID (미지정 시 기본 채널)"),
    mark_as_read: z.boolean().default(true).describe("true: 읽은 후 인박스에서 제거. false: peek 모드 (남겨둠)"),
    include_bot: z.boolean().default(false).describe("봇 메시지도 포함할지 여부"),
    agent_id: z.string().default("main").describe("읽는 에이전트 식별자 (read_by에 기록)"),
  },
  async ({ channel, mark_as_read, include_bot, agent_id }) => {
    const ch = resolveChannel(channel);
    const myUserId = await resolveBotUserId();
    const cursor = getChannelCursor(ch);

    // 1) Slack API에서 새 메시지 가져오기
    const result = await slack.conversations.history({
      channel: ch,
      limit: 50,
      ...(cursor ? { oldest: cursor } : {}),
    });

    let messages = (result.messages || []) as SlackMessage[];
    if (cursor) messages = messages.filter((m) => m.ts !== cursor);
    if (!include_bot) messages = messages.filter((m) => m.user !== myUserId);

    // 2) 인박스에 삽입 (INSERT OR IGNORE — 중복 안전)
    if (messages.length > 0) {
      inboxIngest(ch, messages);
      const latestTs = messages.reduce((max, m) => m.ts > max ? m.ts : max, messages[0].ts);
      setChannelCursor(ch, latestTs);
    }

    // 3) unread 메시지 조회
    const unread = inboxGetUnread(ch);

    // 4) mark_as_read 시 인박스에서 제거 (‘read’ 상태로)
    if (mark_as_read && unread.length > 0) {
      inboxMarkAllRead(ch, agent_id);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          unread_count: unread.length,
          channel: ch,
          cursor_ts: cursor || "(none - first read)",
          messages: unread.map((r) => ({
            text: r.text,
            user: r.user_id,
            ts: r.message_ts,
            thread_ts: r.thread_ts,
            type: r.thread_ts ? "thread_reply" : "channel_message",
            reply_to: r.thread_ts
              ? { method: "slack_reply_thread", thread_ts: r.thread_ts, channel: ch }
              : { method: "slack_send_message", channel: ch },
          })),
          hint: unread.length > 0
            ? `미읽 메시지 ${unread.length}건. ${mark_as_read ? "인박스에서 제거됨." : "peek 모드 — 인박스에 남아있음."}`
            : "미읽 메시지가 없습니다.",
        }, null, 2),
      }],
    };
  }
);

// ── Tool: slack_command_loop (채팅 대체 핵심) ──────────────────

server.tool(
  "slack_command_loop",
  "Slack에서 사용자의 다음 명령을 대기합니다. Claude Code 채팅 인터페이스를 완전히 대체하는 핵심 도구입니다. 사용자가 명령을 입력할 때까지 polling하고, 명령을 수신하면 자동으로 👀 리액션 후 명령 내용을 반환합니다. 채널별 읽기 커서를 자동 추적하여 메시지 유실을 방지합니다.",
  {
    channel: z
      .string()
      .optional()
      .describe("명령을 수신할 Slack 채널 ID"),
    timeout_seconds: z
      .number()
      .min(10)
      .max(600)
      .default(300)
      .describe("대기 시간 (초). 기본 300초(5분). 타임아웃 시 재호출 필요."),
    poll_interval_seconds: z
      .number()
      .min(2)
      .max(30)
      .default(3)
      .describe("폴링 간격 (초). 기본 3초."),
    since_ts: z
      .string()
      .optional()
      .describe("이 타임스탬프 이후의 메시지만 감지. 미지정 시 채널 읽기 커서를 자동 사용 (권장)."),
    greeting: z
      .string()
      .optional()
      .describe("대기 시작 시 채널에 보낼 메시지 (예: '✅ 이전 작업 완료. 다음 명령을 기다립니다.')"),
  },
  async ({ channel, timeout_seconds, poll_interval_seconds, since_ts, greeting }) => {
    const ch = resolveChannel(channel);
    const myUserId = await resolveBotUserId();

    // 대기 시작 알림
    if (greeting) {
      const greetMsg = await slack.chat.postMessage({
        channel: ch,
        text: greeting,
        mrkdwn: true,
      });
      // 인사 메시지 이후부터 감지하도록 커서 업데이트
      if (greetMsg.ts) setChannelCursor(ch, greetMsg.ts);
    }

    // 우선순위: since_ts > 채널 커서 > 현재시각
    const baseTs = since_ts || getChannelCursor(ch) || String(Math.floor(Date.now() / 1000)) + ".000000";
    const deadline = Date.now() + timeout_seconds * 1000;
    const interval = poll_interval_seconds * 1000;

    // 루프 시작 전 기존 unread 확인
    const existingUnread = inboxGetUnread(ch);
    if (existingUnread.length > 0) {
      // 인박스에 이미 미읽 메시지가 있으면 즉시 반환
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

    while (Date.now() < deadline) {
      try {
        const result = await slack.conversations.history({
          channel: ch,
          oldest: baseTs,
          limit: 20,
        });

        const messages = (result.messages || []) as SlackMessage[];
        const userMessages = messages
          .filter((m) => m.user !== myUserId && m.ts !== baseTs);

        if (userMessages.length > 0) {
          // 인박스에 저장 후 즉시 read 처리
          inboxIngest(ch, userMessages);
          inboxMarkAllRead(ch, "command_loop");

          const sorted = [...userMessages].reverse();
          const latest = sorted[sorted.length - 1];

          setChannelCursor(ch, latest.ts);

          // 자동 수신 확인 리액션
          try {
            await slack.reactions.add({
              channel: ch,
              name: "eyes",
              timestamp: latest.ts,
            });
          } catch {
            // 이미 리액션이 있을 수 있음
          }

          // 상태 자동 저장 (compact 후 복구용)
          saveState({
            loop: {
              active: true,
              channel: ch,
              last_ts: latest.ts,
              started_at: new Date().toISOString(),
            },
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    command_received: true,
                    ...enrichMessage(latest, ch),
                    channel: ch,
                    all_messages: sorted.map((m) => enrichMessage(m, ch)),
                    unread_count: sorted.length,
                    workflow: getWorkflowInstructions(sorted.length,
                      sorted.some((m) => findTeamMentions(m.text).length > 0)),
                  },
                  null,
                  2
                ),
              },
            ],
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
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              command_received: false,
              timeout: true,
              waited_seconds: timeout_seconds,
              channel: ch,
              hint: "타임아웃. slack_command_loop()를 다시 호출하여 대기를 재개하세요. 커서는 자동 유지됩니다.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: slack_wait_for_reply ─────────────────────────────────

server.tool(
  "slack_wait_for_reply",
  "사용자의 새 메시지 또는 스레드 답장을 대기합니다. 지정된 시간 동안 polling하여 새 메시지를 감지합니다.",
  {
    channel: z
      .string()
      .optional()
      .describe("Slack 채널 ID (미지정 시 기본 채널 사용)"),
    thread_ts: z
      .string()
      .optional()
      .describe(
        "특정 스레드의 답장만 대기할 경우 해당 스레드의 ts. 미지정 시 채널 전체 메시지 대기."
      ),
    since_ts: z
      .string()
      .optional()
      .describe(
        "이 타임스탬프 이후의 메시지만 감지. 미지정 시 현재 시점 이후."
      ),
    timeout_seconds: z
      .number()
      .min(5)
      .max(300)
      .default(60)
      .describe("대기 시간 (초). 기본 60초, 최대 300초."),
    poll_interval_seconds: z
      .number()
      .min(2)
      .max(30)
      .default(5)
      .describe("폴링 간격 (초). 기본 5초."),
  },
  async ({ channel, thread_ts, since_ts, timeout_seconds, poll_interval_seconds }) => {
    const ch = resolveChannel(channel);
    const myUserId = await resolveBotUserId();

    // 기준 타임스탬프: since_ts 또는 현재 시각
    const baseTs =
      since_ts || String(Math.floor(Date.now() / 1000)) + ".000000";

    const deadline = Date.now() + timeout_seconds * 1000;
    const interval = poll_interval_seconds * 1000;

    while (Date.now() < deadline) {
      try {
        let messages: SlackMessage[] = [];

        if (thread_ts) {
          // 스레드 답장 감시
          const result = await slack.conversations.replies({
            channel: ch,
            ts: thread_ts,
            oldest: baseTs,
            limit: 20,
          });
          messages = ((result.messages || []) as SlackMessage[]).filter(
            (m) => m.ts !== thread_ts // 원본 메시지 제외
          );
        } else {
          // 채널 전체 메시지 감시
          const result = await slack.conversations.history({
            channel: ch,
            oldest: baseTs,
            limit: 20,
          });
          messages = (result.messages || []) as SlackMessage[];
        }

        // 봇 자신의 메시지 제외
        const userMessages = messages.filter((m) => m.user !== myUserId);

        if (userMessages.length > 0) {
          const sorted = [...userMessages].reverse();
          return {
            content: [
              {
                type: "text",
                text: `✅ 새 메시지 ${sorted.length}건 수신:\n\n${formatMessages(sorted)}`,
              },
            ],
          };
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Rate limit일 경우 추가 대기
        if (errMsg.includes("rate_limited")) {
          await sleep(10000);
          continue;
        }
        throw err;
      }

      await sleep(interval);
    }

    return {
      content: [
        {
          type: "text",
          text: `⏰ ${timeout_seconds}초 동안 새 메시지가 없었습니다.`,
        },
      ],
    };
  }
);

// ── Tool: slack_add_reaction ───────────────────────────────────

server.tool(
  "slack_add_reaction",
  "메시지에 이모지 리액션을 추가합니다. 명령 수신 확인(👀), 작업 완료(✅) 등의 시그널에 사용.",
  {
    timestamp: z.string().describe("리액션을 달 메시지의 타임스탬프 (ts)"),
    reaction: z
      .string()
      .default("eyes")
      .describe("이모지 이름 (콜론 없이). 예: eyes, white_check_mark, rocket"),
    channel: z
      .string()
      .optional()
      .describe("Slack 채널 ID (미지정 시 기본 채널 사용)"),
  },
  async ({ timestamp, reaction, channel }) => {
    const ch = resolveChannel(channel);
    try {
      await slack.reactions.add({
        channel: ch,
        name: reaction,
        timestamp,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already_reacted")) {
        return {
          content: [
            {
              type: "text",
              text: `✅ :${reaction}: 리액션 이미 존재 (ts: ${timestamp})`,
            },
          ],
        };
      }
      throw err;
    }

    return {
      content: [
        {
          type: "text",
          text: `✅ :${reaction}: 리액션 추가 완료 (ts: ${timestamp})`,
        },
      ],
    };
  }
);

// ── Tool: slack_list_channels ──────────────────────────────────

server.tool(
  "slack_list_channels",
  "봇이 접근할 수 있는 Slack 채널 목록을 조회합니다.",
  {
    types: z
      .string()
      .default("public_channel,private_channel")
      .describe("조회할 채널 유형. 기본: public_channel,private_channel"),
    limit: z
      .number()
      .min(1)
      .max(200)
      .default(50)
      .describe("가져올 채널 수 (기본: 50)"),
  },
  async ({ types, limit }) => {
    const result = await slack.conversations.list({
      types,
      limit,
      exclude_archived: true,
    });

    const channels = (result.channels || []).map((ch) => ({
      id: ch.id,
      name: ch.name,
      is_member: ch.is_member,
      topic: (ch.topic as { value?: string })?.value || "",
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(channels, null, 2),
        },
      ],
    };
  }
);

// ── Tool: slack_get_thread ─────────────────────────────────────

server.tool(
  "slack_get_thread",
  "특정 메시지의 전체 스레드를 읽어옵니다. 대화 맥락을 파악할 때 사용.",
  {
    thread_ts: z.string().describe("스레드 원본 메시지의 타임스탬프 (ts)"),
    channel: z
      .string()
      .optional()
      .describe("Slack 채널 ID (미지정 시 기본 채널 사용)"),
    limit: z
      .number()
      .min(1)
      .max(200)
      .default(50)
      .describe("가져올 메시지 수"),
  },
  async ({ thread_ts, channel, limit }) => {
    const ch = resolveChannel(channel);
    const result = await slack.conversations.replies({
      channel: ch,
      ts: thread_ts,
      limit,
    });

    const messages = (result.messages || []) as SlackMessage[];

    return {
      content: [
        {
          type: "text",
          text: formatMessages(messages),
        },
      ],
    };
  }
);

// ── Tool: slack_team_create ─────────────────────────────────────

server.tool(
  "slack_team_create",
  "에이전트 팀 전용 Slack 채널을 생성하고 초기 멤버를 등록합니다. spawn-team 시작 시 호출.",
  {
    team_id: z.string().describe("팀 식별자 (예: T12, B-6)"),
    team_name: z.string().describe("팀 목표/이름 (예: Feature X 구현, 버그 수정)"),
    channel_name: z
      .string()
      .optional()
      .describe(
        "생성할 채널 이름 (미지정 시 team-{team_id} 자동 생성). 소문자, 하이픈만 허용."
      ),
    is_private: z
      .boolean()
      .default(false)
      .describe("true 시 비공개 채널로 생성 (기본: 공개)"),
    members: z
      .array(
        z.object({
          id: z.string().describe("멤버 식별자 (예: lead, sub-leader-A, worker-A)"),
          role: z.string().describe("역할명 (예: lead, sub-leader, implementer, reviewer)"),
          agent_type: z.string().describe("에이전트 유형 (예: planner, implementer, validator)"),
          track: z.string().optional().describe("담당 트랙 (예: A, B)"),
        })
      )
      .describe("초기 팀 멤버 목록"),
  },
  async ({ team_id, team_name, channel_name, is_private, members }) => {
    // 채널 이름 생성
    const chName = (channel_name || `team-${team_id}`)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 80);

    // Slack 채널 생성
    const createResult = await slack.conversations.create({
      name: chName,
      is_private,
    });

    const channelId = createResult.channel?.id;
    if (!channelId) throw new Error("채널 생성 실패");

    // 채널 주제 설정
    await slack.conversations.setTopic({
      channel: channelId,
      topic: `🤖 ${team_id}: ${team_name} | Agent Team Channel`,
    });

    // 팀 등록
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

    const team: Team = {
      id: team_id,
      name: team_name,
      channelId,
      channelName: chName,
      members: memberMap,
      createdAt: new Date().toISOString(),
      status: "active",
    };

    teams.set(team_id, team);
    saveTeamsToState();

    // 초기 메시지 (팀 소개 + 멤버 목록)
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

    // Root thread 저장
    team.rootThreadTs = introMsg.ts;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              team_id,
              channel_id: channelId,
              channel_name: chName,
              root_thread_ts: introMsg.ts,
              members_count: members.length,
              message: `팀 채널 #${chName} 생성 완료`,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: slack_team_register ──────────────────────────────────

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
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              team_id,
              member_id,
              channel_id: team.channelId,
              total_members: team.members.size,
              message: `${member_id} 팀 합류 완료`,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: slack_team_send ──────────────────────────────────────

server.tool(
  "slack_team_send",
  "에이전트가 자신의 역할 이름으로 팀 채널에 메시지를 보냅니다. mention으로 다른 팀원을 @멘션할 수 있습니다.",
  {
    team_id: z.string().describe("팀 식별자"),
    sender: z.string().describe("보내는 멤버 ID (예: sub-leader-A, worker-A)"),
    message: z.string().describe("메시지 내용"),
    mention: z
      .array(z.string())
      .optional()
      .describe("멘션할 팀원 ID 목록 (예: ['worker-A', 'sub-leader-B']). 메시지 앞에 @멘션 태그가 추가됩니다."),
    thread_ts: z
      .string()
      .optional()
      .describe("스레드에 답장할 경우 해당 ts. 미지정 시 채널에 직접 전송."),
    update_status: z
      .enum(["active", "idle", "done"])
      .optional()
      .describe("메시지 전송과 함께 멤버 상태 업데이트"),
  },
  async ({ team_id, sender, message, mention, thread_ts, update_status }) => {
    const team = getTeam(team_id);
    const member = team.members.get(sender);
    if (!member) {
      throw new Error(
        `멤버 '${sender}'가 팀 '${team_id}'에 등록되어 있지 않습니다.`
      );
    }

    // 상태 업데이트
    if (update_status) {
      member.status = update_status;
      saveTeamsToState();
    }

    // 멘션 태그 구성
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

    // 멘션된 팀원에게 인박스 알림 저장
    if (mention && mention.length > 0) {
      const mentionNotice = `[멘션 알림] ${sender}가 당신을 멘션했습니다: ${message.substring(0, 100)}`;
      for (const targetId of mention) {
        const targetMember = team.members.get(targetId);
        if (targetMember) {
          // kv_store에 멘션 알림 큐잉
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
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              ts: result.ts,
              channel: team.channelId,
              sender,
              mentioned: mention || [],
              status: member.status,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: slack_team_status ────────────────────────────────────

server.tool(
  "slack_team_status",
  "팀의 현재 상태와 멤버 목록을 조회합니다. 팀 채널에도 현황을 게시할 수 있습니다.",
  {
    team_id: z.string().describe("팀 식별자"),
    post_to_channel: z
      .boolean()
      .default(false)
      .describe("true 시 팀 채널에도 현황 메시지 게시"),
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
      content: [
        {
          type: "text",
          text: statusText,
        },
      ],
    };
  }
);

// ── Tool: slack_team_broadcast ─────────────────────────────────

server.tool(
  "slack_team_broadcast",
  "팀 전체에 중요 공지를 브로드캐스트합니다. lead가 트랙 간 공지, 의존성 알림 등에 사용.",
  {
    team_id: z.string().describe("팀 식별자"),
    sender: z.string().describe("보내는 멤버 ID (보통 lead)"),
    message: z.string().describe("브로드캐스트 메시지"),
    mention_roles: z
      .array(z.string())
      .optional()
      .describe("특별히 언급할 멤버 ID 목록 (예: ['sub-leader-A', 'sub-leader-B'])"),
  },
  async ({ team_id, sender, message, mention_roles }) => {
    const team = getTeam(team_id);
    const member = team.members.get(sender);
    const icon = member ? getRoleIcon(member.role) : "📢";

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
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { ok: true, ts: result.ts, channel: team.channelId },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: slack_team_read ──────────────────────────────────────

server.tool(
  "slack_team_read",
  "팀 채널의 최근 메시지를 읽어옵니다. 다른 팀원이 보낸 메시지, 결과 보고, 명령을 확인할 때 사용.",
  {
    team_id: z.string().describe("팀 식별자"),
    limit: z
      .number()
      .min(1)
      .max(100)
      .default(20)
      .describe("가져올 메시지 수 (기본: 20)"),
    oldest: z
      .string()
      .optional()
      .describe("이 타임스탬프 이후의 메시지만 가져옴 (Slack ts)"),
    sender_filter: z
      .string()
      .optional()
      .describe("특정 멤버 ID의 메시지만 필터링 (예: sub-leader-A)"),
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

    // 필터링: 특정 sender의 메시지만 (메시지 텍스트에 *sender* 패턴이 있는지 기반)
    let filtered = sorted;
    if (sender_filter) {
      filtered = sorted.filter((m) =>
        m.text?.includes(`*${sender_filter}*`)
      );
    }

    return {
      content: [
        {
          type: "text",
          text: formatMessages(filtered),
        },
      ],
    };
  }
);

// ── Tool: slack_team_wait ──────────────────────────────────────

server.tool(
  "slack_team_wait",
  "팀 채널에서 특정 멤버나 lead의 새 메시지를 대기합니다. 지시를 기다리거나 다른 멤버의 작업 완료를 대기할 때 사용.",
  {
    team_id: z.string().describe("팀 식별자"),
    since_ts: z
      .string()
      .optional()
      .describe("이 ts 이후의 메시지부터 확인. 미지정 시 현재 시각부터"),
    timeout_seconds: z
      .number()
      .min(5)
      .max(300)
      .default(60)
      .describe("대기 시간 (초, 기본: 60, 최대: 300)"),
    poll_interval_seconds: z
      .number()
      .min(2)
      .max(30)
      .default(5)
      .describe("폴링 간격 (초, 기본: 5)"),
    wait_for_sender: z
      .string()
      .optional()
      .describe("특정 멤버의 메시지만 대기 (예: lead, sub-leader-A). 미지정 시 봇이 아닌 모든 메시지"),
    wait_for_keyword: z
      .string()
      .optional()
      .describe("메시지에 특정 키워드가 포함된 것만 대기 (예: DONE, APPROVED, LGTM)"),
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
        .filter((m) => m.ts !== lastTs); // exclude exact ts match

      if (messages.length === 0) continue;

      // Update lastTs to newest message
      const newest = messages.reduce((a, b) => (a.ts > b.ts ? a : b));
      lastTs = newest.ts;

      // Filter by sender pattern (team_send prefixes with *sender*)
      let matched = messages;
      if (wait_for_sender) {
        matched = matched.filter((m) =>
          m.text?.includes(`*${wait_for_sender}*`)
        );
      }

      // Filter by keyword
      if (wait_for_keyword) {
        const kw = wait_for_keyword.toLowerCase();
        matched = matched.filter((m) =>
          (m.text || "").toLowerCase().includes(kw)
        );
      }

      // Skip bot's own messages (unless looking for a specific sender pattern)
      if (!wait_for_sender) {
        const myId = await resolveBotUserId();
        matched = matched.filter((m) => m.user !== myId);
      }

      if (matched.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
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
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }

    // Timeout
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: false,
              reason: "timeout",
              timeout_seconds,
              attempts,
              last_ts: lastTs,
              message: `${timeout_seconds}초 동안 새 메시지 없음`,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: slack_team_thread ────────────────────────────────────

server.tool(
  "slack_team_thread",
  "팀 채널 메시지의 스레드를 읽거나 스레드에 답장합니다. 특정 작업 스레드에서의 세부 논의에 사용.",
  {
    team_id: z.string().describe("팀 식별자"),
    thread_ts: z.string().describe("스레드 원본 메시지의 ts"),
    sender: z
      .string()
      .optional()
      .describe("발신자 멤버 ID (답장 시). 미지정 시 읽기만 합니다."),
    message: z
      .string()
      .optional()
      .describe("답장 메시지 (sender와 함께 지정)"),
    limit: z
      .number()
      .min(1)
      .max(100)
      .default(30)
      .describe("스레드 메시지 가져올 수 (읽기 시)"),
  },
  async ({ team_id, thread_ts, sender, message, limit }) => {
    const team = getTeam(team_id);

    // 답장 모드
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
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, ts: result.ts, channel: team.channelId, thread_ts, sender },
              null,
              2
            ),
          },
        ],
      };
    }

    // 읽기 모드
    const result = await slack.conversations.replies({
      channel: team.channelId,
      ts: thread_ts,
      limit,
    });
    const messages = (result.messages || []) as SlackMessage[];

    return {
      content: [
        {
          type: "text",
          text: formatMessages(messages),
        },
      ],
    };
  }
);

// ── Tool: slack_team_close ─────────────────────────────────────

server.tool(
  "slack_team_close",
  "팀 작업 완료 후 채널을 아카이브합니다. 최종 요약을 게시하고 채널을 닫습니다.",
  {
    team_id: z.string().describe("팀 식별자"),
    summary: z.string().describe("작업 최종 요약 메시지"),
    archive_channel: z
      .boolean()
      .default(true)
      .describe("채널 아카이브 여부 (기본: true)"),
  },
  async ({ team_id, summary, archive_channel }) => {
    const team = getTeam(team_id);

    // 모든 멤버 상태를 done으로
    for (const [, member] of team.members) {
      member.status = "done";
    }
    team.status = "completed";
    saveTeamsToState();

    // 최종 요약 게시
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
      ]
        .filter(Boolean)
        .join("\n"),
      mrkdwn: true,
    });

    // 채널 아카이브
    if (archive_channel) {
      try {
        await slack.conversations.archive({ channel: team.channelId });
        team.status = "archived";
      } catch (err) {
        // 아카이브 권한이 없을 수 있음
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `팀 종료 완료 (아카이브 실패: ${errMsg}). 수동 아카이브 필요.`,
            },
          ],
        };
      }
    }

    // 기본 채널에도 알림
    if (SLACK_DEFAULT_CHANNEL) {
      await slack.chat.postMessage({
        channel: SLACK_DEFAULT_CHANNEL,
        text: `🎉 팀 *${team_id}* (${team_name_safe(team)}) 작업 완료. 채널 #${team.channelName} ${archive_channel ? "아카이브됨" : "유지 중"}.`,
        mrkdwn: true,
      });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              team_id,
              status: team.status,
              archived: archive_channel,
              message: `팀 ${team_id} 종료 완료`,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

function team_name_safe(team: Team): string {
  return team.name.replace(/[*_~`]/g, "");
}

// ── Tool: slack_save_state ─────────────────────────────────────

server.tool(
  "slack_save_state",
  "현재 Slack 루프 상태를 파일에 저장합니다. compact/재시작 후 복구에 사용. 중요한 시점마다 호출하세요.",
  {
    channel: z.string().optional().describe("현재 대기 중인 채널 ID"),
    last_ts: z.string().optional().describe("마지막으로 처리한 메시지 ts"),
    task_context: z.string().optional().describe("현재 진행 중인 작업 설명 (compact 후 복구에 사용)"),
    loop_active: z.boolean().default(true).describe("명령 루프 활성 여부"),
  },
  async ({ channel, last_ts, task_context, loop_active }) => {
    const loopState: LoopState = {
      active: loop_active,
      channel: channel || SLACK_DEFAULT_CHANNEL,
      last_ts: last_ts || String(Math.floor(Date.now() / 1000)) + ".000000",
      started_at: new Date().toISOString(),
      task_context,
    };
    saveState({ loop: loopState });
    saveTeamsToState();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { ok: true, state_file: STATE_FILE, loop: loopState, teams_saved: teams.size },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: slack_load_state ─────────────────────────────────────

server.tool(
  "slack_load_state",
  "저장된 Slack 루프 상태를 복구합니다. compact 후 가장 먼저 호출하여 이전 상태를 복원하세요.",
  {},
  async () => {
    const state = loadState();
    if (!state) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, message: "저장된 상태가 없습니다." }),
          },
        ],
      };
    }

    // 팀 복원
    restoreTeamsFromState();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              loop: state.loop,
              teams_restored: Object.keys(state.teams || {}).length,
              updated_at: state.updated_at,
              hint: state.loop?.active
                ? `루프가 활성 상태였습니다. slack_command_loop(channel='${state.loop.channel}', since_ts='${state.loop.last_ts}')로 재개하세요.`
                : "루프가 비활성 상태였습니다.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: slack_team_report ─────────────────────────────────────

server.tool(
  "slack_team_report",
  "팀원이 메인 채널에 작업 상황을 보고합니다. 팀 채널 + 메인 채널에 동시 게시되어 사용자가 전체 진행 상황을 한눈에 파악할 수 있습니다.",
  {
    team_id: z.string().describe("팀 식별자"),
    sender: z.string().describe("보내는 멤버 ID (예: sub-leader-A, rust-impl-A)"),
    summary: z.string().describe("작업 상황 요약 (메인 채널에 게시됨)"),
    details: z
      .string()
      .optional()
      .describe("상세 내용 (팀 채널 스레드에만 게시). 미지정 시 요약만 게시."),
    status: z
      .enum(["progress", "blocked", "review", "done"])
      .default("progress")
      .describe("상태: progress(진행중), blocked(차단), review(검토 필요), done(완료)"),
    update_member_status: z
      .enum(["active", "idle", "done"])
      .optional()
      .describe("멤버 상태도 함께 업데이트"),
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
      progress: "🔄",
      blocked: "🚫",
      review: "👀",
      done: "✅",
    };
    const statusLabel: Record<string, string> = {
      progress: "진행중",
      blocked: "차단됨",
      review: "검토 필요",
      done: "완료",
    };

    const icon = getRoleIcon(member.role);
    const trackStr = member.track ? ` [${member.track}]` : "";
    const emoji = statusEmoji[status] || "📋";
    const label = statusLabel[status] || status;

    // 1) 메인 채널에 요약 게시
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

    // 2) 팀 채널에도 게시 (에이전트 identity 사용)
    const identity = agentIdentity(sender, member);
    const teamMsg = await slack.chat.postMessage({
      channel: team.channelId,
      text: `${emoji} *${label}*\n${summary}`,
      mrkdwn: true,
      username: identity.username,
      icon_emoji: identity.icon_emoji,
    });

    // 3) 상세 내용은 팀 채널 스레드에
    if (details) {
      await sendSmart(team.channelId, details, {
        thread_ts: teamMsg.ts,
        title: `${sender} 상세 보고`,
        filename: `report-${sender}-${Date.now()}.txt`,
      });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              team_id,
              sender,
              status,
              main_channel_ts: mainMsg.ts,
              team_channel_ts: teamMsg.ts,
              message: `${label} 보고 완료 (메인 채널 + 팀 채널)`,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: slack_request_approval ───────────────────────────────

server.tool(
  "slack_request_approval",
  "사용자에게 승인을 요청하고 응답을 대기합니다. 문제 발생, 중요 결정, 위험한 작업 전에 사용자 확인이 필요할 때 호출합니다. 메인 채널에 승인 요청을 게시하고 사용자가 ✅(승인) 또는 ❌(거부) 리액션이나 텍스트로 응답할 때까지 대기합니다.",
  {
    title: z.string().describe("승인 요청 제목 (예: DB 마이그레이션 실행, 프로덕션 배포)"),
    description: z.string().describe("승인이 필요한 이유와 상세 설명"),
    team_id: z
      .string()
      .optional()
      .describe("팀 식별자 (팀 컨텍스트에서 요청 시)"),
    sender: z
      .string()
      .optional()
      .describe("요청하는 멤버 ID (팀 컨텍스트)"),
    options: z
      .array(z.string())
      .optional()
      .describe("선택지 목록 (예: ['옵션A: 롤백', '옵션B: 계속 진행', '옵션C: 중단']). 미지정 시 승인/거부만."),
    channel: z
      .string()
      .optional()
      .describe("승인 요청을 보낼 채널 (미지정 시 메인 채널)"),
    timeout_seconds: z
      .number()
      .min(30)
      .max(600)
      .default(300)
      .describe("응답 대기 시간 (초). 기본 300초(5분)."),
    poll_interval_seconds: z
      .number()
      .min(2)
      .max(30)
      .default(5)
      .describe("폴링 간격 (초). 기본 5초."),
  },
  async ({ title, description, team_id, sender, options, channel, timeout_seconds, poll_interval_seconds }) => {
    const ch = channel || SLACK_DEFAULT_CHANNEL;
    if (!ch) throw new Error("채널이 지정되지 않았습니다.");

    const myUserId = await resolveBotUserId();

    // 팀 컨텍스트 정보
    let teamContext = "";
    if (team_id && sender) {
      const team = teams.get(team_id);
      const member = team?.members.get(sender);
      const icon = member ? getRoleIcon(member.role) : "🤖";
      const trackStr = member?.track ? ` [${member.track}]` : "";
      teamContext = `\n요청자: ${icon} *${sender}*${trackStr} (팀 *${team_id}*)`;
    }

    // 선택지 포맷
    let optionsText = "";
    if (options && options.length > 0) {
      optionsText = "\n\n*선택지:*\n" + options.map((o, i) => `${i + 1}️⃣ ${o}`).join("\n");
      optionsText += "\n\n_번호 또는 텍스트로 응답해주세요._";
    } else {
      optionsText = "\n\n✅ 승인 | ❌ 거부\n_리액션 또는 텍스트(승인/거부)로 응답해주세요._";
    }

    // 승인 요청 메시지 게시
    const approvalMsg = await slack.chat.postMessage({
      channel: ch,
      text: [
        `🔔 *[승인 요청]* ${title}`,
        teamContext,
        "",
        description,
        optionsText,
        "",
        `⏳ _${timeout_seconds}초 후 타임아웃_`,
      ].filter(Boolean).join("\n"),
      mrkdwn: true,
    });

    const approvalTs = approvalMsg.ts!;

    // 팀 채널에도 알림
    if (team_id) {
      const team = teams.get(team_id);
      if (team) {
        await slack.chat.postMessage({
          channel: team.channelId,
          text: `🔔 *승인 대기 중* — ${title}\n메인 채널에서 사용자 응답 대기 중...`,
          mrkdwn: true,
        });
      }
    }

    // 폴링: 리액션 또는 스레드 답장 확인
    const deadline = Date.now() + timeout_seconds * 1000;
    const interval = poll_interval_seconds * 1000;

    while (Date.now() < deadline) {
      await sleep(interval);

      // 1) 리액션 확인
      try {
        const reactResult = await slack.reactions.get({
          channel: ch,
          timestamp: approvalTs,
          full: true,
        });

        const reactions = (reactResult.message as { reactions?: Array<{ name: string; users?: string[] }> })?.reactions || [];
        for (const r of reactions) {
          const nonBotUsers = (r.users || []).filter((u) => u !== myUserId);
          if (nonBotUsers.length === 0) continue;

          if (["white_check_mark", "+1", "heavy_check_mark", "thumbsup"].includes(r.name)) {
            // 승인 확인 리액션
            await slack.reactions.add({ channel: ch, name: "white_check_mark", timestamp: approvalTs }).catch(() => {});
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ok: true,
                      approved: true,
                      method: "reaction",
                      reaction: r.name,
                      user: nonBotUsers[0],
                      approval_ts: approvalTs,
                      message: `✅ 승인됨 (:${r.name}: 리액션)`,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          if (["x", "-1", "no_entry", "thumbsdown", "no_entry_sign"].includes(r.name)) {
            await slack.reactions.add({ channel: ch, name: "x", timestamp: approvalTs }).catch(() => {});
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ok: true,
                      approved: false,
                      method: "reaction",
                      reaction: r.name,
                      user: nonBotUsers[0],
                      approval_ts: approvalTs,
                      message: `❌ 거부됨 (:${r.name}: 리액션)`,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }
      } catch {
        // reactions.get 실패 시 무시하고 텍스트 확인으로 계속
      }

      // 2) 스레드 텍스트 답장 확인
      try {
        const threadResult = await slack.conversations.replies({
          channel: ch,
          ts: approvalTs,
          oldest: approvalTs,
          limit: 10,
        });

        const replies = ((threadResult.messages || []) as SlackMessage[])
          .filter((m) => m.ts !== approvalTs && m.user !== myUserId);

        if (replies.length > 0) {
          const latest = replies[replies.length - 1];
          const text = (latest.text || "").toLowerCase().trim();

          // 승인/거부 텍스트 패턴 매칭
          const approvePatterns = ["승인", "확인", "진행", "ㅇㅇ", "ㄱㄱ", "ok", "yes", "approve", "approved", "lgtm", "go", "proceed"];
          const denyPatterns = ["거부", "거절", "중단", "취소", "ㄴㄴ", "no", "deny", "denied", "reject", "stop", "cancel", "abort"];

          const isApproved = approvePatterns.some((p) => text.includes(p));
          const isDenied = denyPatterns.some((p) => text.includes(p));

          if (isApproved || isDenied) {
            const emoji = isApproved ? "white_check_mark" : "x";
            await slack.reactions.add({ channel: ch, name: emoji, timestamp: approvalTs }).catch(() => {});

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ok: true,
                      approved: isApproved,
                      method: "text",
                      reply_text: latest.text,
                      user: latest.user,
                      reply_ts: latest.ts,
                      approval_ts: approvalTs,
                      message: isApproved ? "✅ 승인됨 (텍스트 응답)" : "❌ 거부됨 (텍스트 응답)",
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          // 선택지 응답 (숫자 또는 텍스트)
          if (options && options.length > 0) {
            const numMatch = text.match(/^(\d+)/);
            const selectedIdx = numMatch ? parseInt(numMatch[1], 10) - 1 : -1;
            const selectedOption = selectedIdx >= 0 && selectedIdx < options.length
              ? options[selectedIdx]
              : latest.text;

            await slack.reactions.add({ channel: ch, name: "white_check_mark", timestamp: approvalTs }).catch(() => {});

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ok: true,
                      approved: true,
                      method: "choice",
                      selected_option: selectedOption,
                      selected_index: selectedIdx >= 0 ? selectedIdx : null,
                      reply_text: latest.text,
                      user: latest.user,
                      reply_ts: latest.ts,
                      approval_ts: approvalTs,
                      message: `선택됨: ${selectedOption}`,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }
      } catch {
        // replies 조회 실패 시 다음 폴링으로
      }
    }

    // 타임아웃
    await slack.reactions.add({ channel: ch, name: "hourglass", timestamp: approvalTs }).catch(() => {});

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: false,
              approved: null,
              reason: "timeout",
              timeout_seconds,
              approval_ts: approvalTs,
              message: `⏰ ${timeout_seconds}초 동안 응답 없음. 작업을 중단하거나 다시 요청하세요.`,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── File Download/Upload Constants ─────────────────────────────

const DOWNLOAD_DIR = resolve(STATE_DIR, "downloads");
if (!existsSync(DOWNLOAD_DIR)) mkdirSync(DOWNLOAD_DIR, { recursive: true });

// ── Tool: slack_download_file ──────────────────────────────────

server.tool(
  "slack_download_file",
  "Slack에 업로드된 파일(이미지, 문서 등)을 로컬 파일시스템에 다운로드합니다. 메시지의 files 필드에서 file_id를 확인하세요.",
  {
    file_id: z.string().describe("Slack 파일 ID (메시지의 files[].id에서 가져옴)"),
    save_path: z
      .string()
      .optional()
      .describe("저장할 로컬 경로. 미지정 시 downloads/ 디렉토리에 원본 파일명으로 저장"),
  },
  async ({ file_id, save_path }) => {
    // 1. 파일 메타데이터 조회
    const fileInfo = await slack.files.info({ file: file_id });
    const file = (fileInfo as { file?: SlackFile & { url_private_download?: string; url_private?: string } }).file;
    if (!file) {
      throw new Error(`파일을 찾을 수 없습니다: ${file_id}`);
    }

    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) {
      throw new Error(`파일 다운로드 URL이 없습니다. 파일 타입을 확인하세요: ${file.name || file_id}`);
    }

    // 2. 저장 경로 결정
    const filename = file.name || `file-${file_id}${extname(file.name || ".bin")}`;
    const targetPath = save_path
      ? resolve(save_path)
      : resolve(DOWNLOAD_DIR, filename);
    const targetDir = dirname(targetPath);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

    // 3. 다운로드 (Bot token으로 인증)
    const response = await fetch(downloadUrl, {
      headers: {
        "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
      },
    });

    if (!response.ok) {
      throw new Error(`파일 다운로드 실패: HTTP ${response.status} ${response.statusText}`);
    }

    // 4. 파일로 저장
    const fileStream = createWriteStream(targetPath);
    // @ts-expect-error - Node.js fetch body is a ReadableStream
    await pipeline(response.body, fileStream);

    const stats = {
      file_id,
      name: file.name,
      mimetype: file.mimetype,
      size: file.size,
      filetype: file.filetype,
      saved_to: targetPath,
    };

    // 이미지인 경우 추가 안내
    const isImage = file.mimetype?.startsWith("image/");
    const hint = isImage
      ? "이미지 파일입니다. read_file이나 이미지 분석 도구로 내용을 확인하세요."
      : `${file.filetype || "unknown"} 타입 파일이 다운로드되었습니다.`;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              ...stats,
              hint,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: slack_upload_file ─────────────────────────────────────

server.tool(
  "slack_upload_file",
  "로컬 파일(이미지, 문서, 로그 등)을 Slack 채널에 업로드합니다. 작업 결과물, 스크린샷, 차트 등을 공유할 때 사용.",
  {
    file_path: z.string().describe("업로드할 로컬 파일의 절대 경로"),
    channel: z
      .string()
      .optional()
      .describe("업로드할 채널 ID (미지정 시 기본 채널)"),
    title: z
      .string()
      .optional()
      .describe("파일 제목 (Slack에 표시)"),
    message: z
      .string()
      .optional()
      .describe("파일과 함께 보낼 메시지"),
    thread_ts: z
      .string()
      .optional()
      .describe("스레드에 업로드할 경우 해당 ts"),
  },
  async ({ file_path, channel, title, message, thread_ts }) => {
    const ch = resolveChannel(channel);
    const absPath = resolve(file_path);

    if (!existsSync(absPath)) {
      throw new Error(`파일이 존재하지 않습니다: ${absPath}`);
    }

    const fileContent = readFileSync(absPath);
    const filename = basename(absPath);
    const fileTitle = title || filename;

    // filesUploadV2 사용
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args: any = {
      channel_id: ch,
      file: fileContent,
      filename,
      title: fileTitle,
    };
    if (thread_ts) args.thread_ts = thread_ts;
    if (message) args.initial_comment = message;

    const result = await slack.filesUploadV2(args);
    const uploadedFile = (result as { files?: Array<{ id?: string }> }).files?.[0];

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              file_id: uploadedFile?.id || "",
              filename,
              title: fileTitle,
              channel: ch,
              thread_ts: thread_ts || null,
              message: message || null,
              hint: "파일이 Slack에 업로드되었습니다.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: slack_cost_report ─────────────────────────────────────

/** ccusage JSON 응답 타입 */
interface CcusageModelBreakdown {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}
interface CcusageDailyEntry {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  modelsUsed: string[];
  modelBreakdowns: CcusageModelBreakdown[];
}
interface CcusageMonthlyEntry {
  month: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  modelsUsed: string[];
  modelBreakdowns: CcusageModelBreakdown[];
}
interface CcusageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
  totalTokens: number;
}
interface CcusageDailyResult { daily: CcusageDailyEntry[]; totals: CcusageTotals; }
interface CcusageMonthlyResult { monthly: CcusageMonthlyEntry[]; totals: CcusageTotals; }

function runCcusage(args: string[]): string {
  const cmd = `npx ccusage@latest ${args.join(" ")}`;
  return execSync(cmd, {
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  }).trim();
}

function formatTokenK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function costEmoji(usd: number): string {
  if (usd < 5) return "🟢";
  if (usd < 50) return "🟡";
  if (usd < 150) return "🟠";
  return "🔴";
}

function shortModel(name: string): string {
  if (name.includes("opus-4-6")) return "Opus 4.6";
  if (name.includes("opus-4-5")) return "Opus 4.5";
  if (name.includes("sonnet-4-5")) return "Sonnet 4.5";
  if (name.includes("haiku-4-5")) return "Haiku 4.5";
  return name.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

server.tool(
  "slack_cost_report",
  "ccusage를 사용하여 Claude Code 토큰 사용량/비용을 Slack에 보고합니다. 로컬 JSONL 로그에서 정확한 데이터를 읽어옵니다. report_type을 지정하여 일별/월별 리포트를 선택할 수 있습니다.",
  {
    report_type: z.enum(["daily", "monthly"]).default("daily").describe("리포트 유형: daily(일별) 또는 monthly(월별)"),
    since: z.string().optional().describe("시작일 (YYYYMMDD). 미지정시 전체"),
    until: z.string().optional().describe("종료일 (YYYYMMDD). 미지정시 오늘"),
    today_only: z.boolean().default(false).describe("오늘 데이터만 볼 때 true"),
    breakdown: z.boolean().default(true).describe("모델별 비용 분석 포함 여부"),
    task_summary: z.string().optional().describe("현재 수행 중인 작업 요약"),
    channel: z.string().optional().describe("보고할 채널 (미지정 시 메인 채널)"),
    team_id: z.string().optional().describe("팀 식별자 (팀 채널에도 보고 시)"),
    sender: z.string().optional().describe("보고하는 팀 멤버 ID"),
  },
  async ({ report_type, since, until, today_only, breakdown, task_summary, channel, team_id, sender }) => {
    const ch = channel || SLACK_DEFAULT_CHANNEL;
    if (!ch) throw new Error("채널이 지정되지 않았습니다.");

    // ccusage 실행 인자 구성
    const ccArgs = [report_type, "--json"];
    if (today_only) {
      const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      ccArgs.push("--since", todayStr, "--until", todayStr);
    } else {
      if (since) ccArgs.push("--since", since);
      if (until) ccArgs.push("--until", until);
    }

    let rawJson: string;
    try {
      rawJson = runCcusage(ccArgs);
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `ccusage 실행 실패: ${errMsg}` }) }],
      };
    }

    const data = JSON.parse(rawJson);
    const totals: CcusageTotals = data.totals;

    // ── 메시지 포맷 ──
    const emoji = costEmoji(totals.totalCost);
    const formatUsd = (n: number) => `$${n.toFixed(2)}`;

    const lines: string[] = [
      `${emoji} *Claude Code 비용 리포트* (ccusage)`,
      "",
      `💵 *총 비용:* ${formatUsd(totals.totalCost)}`,
      `📊 *총 토큰:* ${formatTokenK(totals.totalTokens)}`,
      "",
      `📥 입력: ${formatTokenK(totals.inputTokens)} | 📤 출력: ${formatTokenK(totals.outputTokens)}`,
      `📋 캐시 읽기: ${formatTokenK(totals.cacheReadTokens)} | 📝 캐시 쓰기: ${formatTokenK(totals.cacheCreationTokens)}`,
    ];

    // 기간 표시
    if (report_type === "daily") {
      const entries = (data as CcusageDailyResult).daily;
      if (entries.length > 0) {
        const first = entries[0].date;
        const last = entries[entries.length - 1].date;
        lines.splice(1, 0, `📅 ${first} ~ ${last} (${entries.length}일)`);
      }

      // 일별 내역 (최근 5일만 표시)
      if (entries.length > 1) {
        lines.push("");
        const recent = entries.slice(-5);
        for (const day of recent) {
          const dayEmoji = costEmoji(day.totalCost);
          lines.push(`  ${dayEmoji} ${day.date}: ${formatUsd(day.totalCost)} (${formatTokenK(day.totalTokens)})`);
        }
        if (entries.length > 5) {
          lines.push(`  _... 외 ${entries.length - 5}일_`);
        }
      }
    } else {
      const entries = (data as CcusageMonthlyResult).monthly;
      if (entries.length > 0) {
        lines.splice(1, 0, `📅 ${entries[0].month} ~ ${entries[entries.length - 1].month} (${entries.length}개월)`);
        if (entries.length > 1) {
          lines.push("");
          for (const mo of entries) {
            const moEmoji = costEmoji(mo.totalCost);
            lines.push(`  ${moEmoji} ${mo.month}: ${formatUsd(mo.totalCost)} (${formatTokenK(mo.totalTokens)})`);
          }
        }
      }
    }

    // 모델별 분석
    if (breakdown) {
      const entries = report_type === "daily"
        ? (data as CcusageDailyResult).daily
        : (data as CcusageMonthlyResult).monthly;

      // 모든 기간의 모델 비용 합산
      const modelCosts = new Map<string, { cost: number; tokens: number }>();
      for (const entry of entries) {
        for (const mb of entry.modelBreakdowns) {
          const existing = modelCosts.get(mb.modelName) || { cost: 0, tokens: 0 };
          existing.cost += mb.cost;
          existing.tokens += mb.inputTokens + mb.outputTokens + mb.cacheCreationTokens + mb.cacheReadTokens;
          modelCosts.set(mb.modelName, existing);
        }
      }

      if (modelCosts.size > 0) {
        lines.push("", "🤖 *모델별 비용:*");
        const sorted = [...modelCosts.entries()].sort((a, b) => b[1].cost - a[1].cost);
        for (const [model, info] of sorted) {
          const pct = totals.totalCost > 0 ? ((info.cost / totals.totalCost) * 100).toFixed(1) : "0";
          lines.push(`  • ${shortModel(model)}: ${formatUsd(info.cost)} (${pct}%)`);
        }
      }
    }

    if (task_summary) {
      lines.push("", `📋 *작업:* ${task_summary}`);
    }

    lines.push("", `_${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}_`);

    const text = lines.join("\n");

    // 메인 채널에 게시
    const mainMsg = await slack.chat.postMessage({
      channel: ch,
      text,
      mrkdwn: true,
    });

    // 팀 채널에도 게시 (선택)
    if (team_id && sender) {
      const team = teams.get(team_id);
      if (team) {
        const member = team.members.get(sender);
        const identity = member
          ? agentIdentity(sender, member)
          : { username: sender, icon_emoji: ":moneybag:" };

        await slack.chat.postMessage({
          channel: team.channelId,
          text: `${emoji} 비용: ${formatUsd(totals.totalCost)} | 토큰: ${formatTokenK(totals.totalTokens)}`,
          mrkdwn: true,
          username: identity.username,
          icon_emoji: identity.icon_emoji,
        });
      }
    }

    // 비용 상태를 SQLite에 기록
    saveCostReport({
      report_type,
      total_cost_usd: totals.totalCost,
      total_tokens: totals.totalTokens,
      input_tokens: totals.inputTokens,
      output_tokens: totals.outputTokens,
      cache_read: totals.cacheReadTokens,
      cache_write: totals.cacheCreationTokens,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              total_cost_usd: totals.totalCost,
              total_tokens: totals.totalTokens,
              input_tokens: totals.inputTokens,
              output_tokens: totals.outputTokens,
              cache_read_tokens: totals.cacheReadTokens,
              cache_creation_tokens: totals.cacheCreationTokens,
              channel: ch,
              ts: mainMsg.ts,
              message: `ccusage 비용 리포트 전송 완료: ${formatUsd(totals.totalCost)}`,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Utilities ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Start Server ───────────────────────────────────────────────

async function main() {
  // Bot user 확인
  await resolveBotUserId();
  if (botUserId) {
    console.error(`🤖 Slack Bot connected (user: ${botUserId})`);
  }

  // 저장된 팀 상태 복원
  restoreTeamsFromState();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🚀 Slack MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

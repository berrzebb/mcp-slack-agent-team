/**
 * Shared type definitions for the Slack MCP Server.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ── Paths & Constants ──────────────────────────────────────────

// Use __dirname-based resolution so paths are stable regardless of how the
// process is launched (direct, wrapper, different cwd, etc.).
// src/ lives inside the slack MCP server directory → dirname(__dirname) = slack root
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const STATE_DIR = resolve(__dirname, "..");          // .claude/mcp-servers/slack/
export const STATE_FILE = resolve(STATE_DIR, "state.json");
export const DB_FILE = resolve(STATE_DIR, "slack_mcp.db");
export const DOWNLOAD_DIR = resolve(STATE_DIR, "downloads");

// Slack message limits
export const SLACK_MSG_LIMIT = 3900;
export const SLACK_FILE_THRESHOLD = 8000;

// ── Configuration ──────────────────────────────────────────────

export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
export const SLACK_DEFAULT_CHANNEL = process.env.SLACK_DEFAULT_CHANNEL || "";

// ── Slack Types ────────────────────────────────────────────────

export interface SlackFile {
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

export interface SlackMessage {
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  files?: SlackFile[];
}

// ── State Types ────────────────────────────────────────────────

export interface LoopState {
  active: boolean;
  channel: string;
  last_ts: string;
  started_at: string;
  task_context?: string;
}

export interface PersistentState {
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

// ── Team Types ─────────────────────────────────────────────────

export interface TeamMember {
  role: string;
  agentType: string;
  track?: string;
  status: "active" | "idle" | "done";
  joinedAt: string;
}

export interface Team {
  id: string;
  name: string;
  channelId: string;
  channelName: string;
  rootThreadTs?: string;
  members: Map<string, TeamMember>;
  createdAt: string;
  status: "active" | "completed" | "archived";
}

// ── Team Context Types ──────────────────────────────────────────

export type TaskStatus = "pending" | "assigned" | "in-progress" | "blocked" | "review" | "done" | "cancelled";

export interface TeamTask {
  id: string;
  team_id: string;
  title: string;
  description: string;
  assigned_to: string;
  assigned_by: string;
  track?: string;
  dependencies: string[];     // task IDs
  status: TaskStatus;
  result_summary?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface AgentContext {
  agent_id: string;
  team_id: string;
  role: string;
  track?: string;
  current_task_id?: string;
  context_snapshot: Record<string, unknown>;  // structured JSON
  last_updated: string;
}

export interface TeamDecision {
  id?: number;
  team_id: string;
  decision_type: string;      // "approval", "design", "priority", "blocker"
  question: string;
  answer: string;
  decided_by: string;
  created_at?: string;
}

// ── Inbox Types ────────────────────────────────────────────────

export interface InboxRow {
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

// ── Cost Report Types ──────────────────────────────────────────

export interface CcusageModelBreakdown {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

export interface CcusageDailyEntry {
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

export interface CcusageMonthlyEntry {
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

export interface CcusageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
  totalTokens: number;
}

export interface CcusageDailyResult {
  daily: CcusageDailyEntry[];
  totals: CcusageTotals;
}

export interface CcusageMonthlyResult {
  monthly: CcusageMonthlyEntry[];
  totals: CcusageTotals;
}

// ── Language Extensions ────────────────────────────────────────

export const LANG_EXTENSIONS: Record<string, string> = {
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

// ── Role Icons ─────────────────────────────────────────────────

export const ROLE_ICONS: Record<string, string> = {
  lead: "👑",
  planner: "📋",
  "sub-leader": "🎯",
  implementer: "🔨",
  "test-writer": "🧪",
  validator: "✅",
  "code-reviewer": "🔍",
  "ux-reviewer": "🎨",
  debugger: "🐛",
  "db-specialist": "🗄️",
  refactorer: "♻️",
  researcher: "🔬",
};

export const ROLE_SLACK_EMOJI: Record<string, string> = {
  lead: ":crown:",
  planner: ":clipboard:",
  "sub-leader": ":dart:",
  implementer: ":hammer:",
  "test-writer": ":test_tube:",
  validator: ":white_check_mark:",
  "code-reviewer": ":mag:",
  "ux-reviewer": ":art:",
  debugger: ":bug:",
  "db-specialist": ":file_cabinet:",
  refactorer: ":recycle:",
  researcher: ":microscope:",
};

/**
 * Agent persona mapping — gives each agent role a unique display name
 * and personality for Slack. Used by agentIdentity() in state.ts.
 */
export interface AgentPersona {
  displayName: string;   // Slack username
  emoji: string;         // Slack icon_emoji
  title: string;         // Korean title for messages
}

export const AGENT_PERSONAS: Record<string, AgentPersona> = {
  lead:            { displayName: "Aria",    emoji: ":crown:",              title: "팀 리드" },
  planner:         { displayName: "Sage",    emoji: ":clipboard:",          title: "설계 분석가" },
  "sub-leader":    { displayName: "Nova",    emoji: ":dart:",               title: "트랙 서브리더" },
  implementer:     { displayName: "Forge",   emoji: ":hammer:",             title: "풀스택 엔지니어" },
  "db-specialist": { displayName: "Quinn",   emoji: ":file_cabinet:",       title: "DB 전문가" },
  "code-reviewer": { displayName: "Lens",    emoji: ":mag:",                title: "코드 리뷰어" },
  "ux-reviewer":   { displayName: "Pixel",   emoji: ":art:",                title: "UX 리뷰어" },
  debugger:        { displayName: "Trace",   emoji: ":bug:",                title: "디버거" },
  "test-writer":   { displayName: "Spec",    emoji: ":test_tube:",          title: "테스트 작성자" },
  refactorer:      { displayName: "Prism",   emoji: ":recycle:",            title: "리팩토러" },
  validator:       { displayName: "Gate",    emoji: ":white_check_mark:",   title: "검증자" },
  researcher:      { displayName: "Scout",   emoji: ":microscope:",         title: "리서처" },
};

/**
 * Reverse lookup: persona displayName (case-insensitive) → role key.
 * Used by @mention routing to resolve "@Sage" → "planner", etc.
 */
export const PERSONA_NAME_TO_ROLE: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_PERSONAS).map(([role, p]) => [p.displayName.toLowerCase(), role]),
);

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
 * Command Loop:
 *   - slack_command_loop:    사용자 명령 대기 루프 (채팅 대체 핵심)
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
 *   - slack_team_close:      팀 채널 아카이브
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

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

const slack = new WebClient(SLACK_BOT_TOKEN);

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
  const trackSuffix = member.track ? ` [${member.track}]` : "";
  return {
    username: `${senderId}${trackSuffix}`,
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

interface SlackMessage {
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
}

function formatMessages(messages: SlackMessage[]): string {
  if (messages.length === 0) return "(메시지 없음)";
  return messages
    .map((m) => {
      const thread = m.thread_ts ? ` [thread: ${m.thread_ts}]` : "";
      const replies = m.reply_count ? ` (${m.reply_count} replies)` : "";
      return `[${m.ts}] <${m.user}>${thread}${replies}: ${m.text}`;
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

// ── Tool: slack_command_loop (채팅 대체 핵심) ──────────────────

server.tool(
  "slack_command_loop",
  "Slack에서 사용자의 다음 명령을 대기합니다. Claude Code 채팅 인터페이스를 완전히 대체하는 핵심 도구입니다. 사용자가 명령을 입력할 때까지 polling하고, 명령을 수신하면 자동으로 👀 리액션 후 명령 내용을 반환합니다.",
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
      .describe("이 타임스탬프 이후의 메시지만 감지. 이전 명령의 ts를 넘기면 중복 방지."),
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
      await slack.chat.postMessage({
        channel: ch,
        text: greeting,
        mrkdwn: true,
      });
    }

    const baseTs = since_ts || String(Math.floor(Date.now() / 1000)) + ".000000";
    const deadline = Date.now() + timeout_seconds * 1000;
    const interval = poll_interval_seconds * 1000;

    while (Date.now() < deadline) {
      try {
        const result = await slack.conversations.history({
          channel: ch,
          oldest: baseTs,
          limit: 10,
        });

        const messages = (result.messages || []) as SlackMessage[];
        // 봇 자신의 메시지 제외, 최신 메시지 우선
        const userMessages = messages
          .filter((m) => m.user !== myUserId)
          .reverse();

        if (userMessages.length > 0) {
          const latest = userMessages[userMessages.length - 1];

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
                    message: latest.text,
                    user: latest.user,
                    ts: latest.ts,
                    thread_ts: latest.thread_ts,
                    channel: ch,
                    all_messages: userMessages.map((m) => ({
                      text: m.text,
                      user: m.user,
                      ts: m.ts,
                    })),
                    hint: "명령을 수행한 후, slack_send_message 또는 slack_reply_thread로 결과를 보고하고, slack_command_loop(since_ts=이 ts)로 다음 명령을 대기하세요.",
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
              hint: "타임아웃. slack_command_loop를 다시 호출하여 대기를 재개하세요.",
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
    await slack.reactions.add({
      channel: ch,
      name: reaction,
      timestamp,
    });

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
  "에이전트가 자신의 역할 이름으로 팀 채널에 메시지를 보냅니다.",
  {
    team_id: z.string().describe("팀 식별자"),
    sender: z.string().describe("보내는 멤버 ID (예: sub-leader-A, worker-A)"),
    message: z.string().describe("메시지 내용"),
    thread_ts: z
      .string()
      .optional()
      .describe("스레드에 답장할 경우 해당 ts. 미지정 시 채널에 직접 전송."),
    update_status: z
      .enum(["active", "idle", "done"])
      .optional()
      .describe("메시지 전송과 함께 멤버 상태 업데이트"),
  },
  async ({ team_id, sender, message, thread_ts, update_status }) => {
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

    const statusTag = update_status === "done" ? " ✅" : "";
    const identity = agentIdentity(sender, member);

    const result = await slack.chat.postMessage({
      channel: team.channelId,
      text: `${statusTag ? statusTag + " " : ""}${message}`,
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
            {
              ok: true,
              ts: result.ts,
              channel: team.channelId,
              sender,
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

/**
 * Message formatting utilities — plain text and rich Slack mrkdwn formatting.
 */

import type { SlackFile, SlackMessage } from "./types.js";
import { teams } from "./state.js";

// ── Plain Message Formatting ───────────────────────────────────

export function formatMessages(messages: SlackMessage[]): string {
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

// ── Mention & Workflow Helpers ──────────────────────────────────

/** 메시지 텍스트에서 @agent-name 멘션을 파싱합니다 */
export function parseMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  const mentions: string[] = [];
  const pattern = /@([a-zA-Z][a-zA-Z0-9_-]*)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    mentions.push(match[1]);
  }
  return mentions;
}

/** 현재 등록된 모든 팀 멤버 ID 목록 */
export function getAllTeamMemberIds(): string[] {
  const ids: string[] = [];
  for (const team of teams.values()) {
    for (const mid of team.members.keys()) {
      if (!ids.includes(mid)) ids.push(mid);
    }
  }
  return ids;
}

/** 메시지에서 팀 멤버 멘션만 필터링 */
export function findTeamMentions(text: string | null | undefined): string[] {
  const allMentions = parseMentions(text);
  const memberIds = getAllTeamMemberIds();
  return allMentions.filter((m) => memberIds.includes(m));
}

/** 메시지를 워크플로우 포맷으로 변환 (mentions, type, reply_to, files 포함) */
export function enrichMessage(
  msg: { text?: string | null; user?: string | null; ts: string; thread_ts?: string | null; files?: SlackFile[] },
  ch: string,
) {
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
export function getWorkflowInstructions(unreadCount: number, hasMentions: boolean): string[] {
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

// ── Rich Slack Formatting ──────────────────────────────────────

/**
 * 에이전트 응답을 보기 좋은 Slack mrkdwn 포맷으로 변환합니다.
 * - 헤더와 섹션 구분
 * - 상태 이모지 자동 추가
 * - 코드 블록 보존
 * - 리스트 아이템 포맷팅
 */
export function formatAgentResponse(options: {
  title?: string;
  status?: "success" | "error" | "info" | "warning" | "progress";
  sections?: Array<{ heading?: string; content: string }>;
  body?: string;
  footer?: string;
}): string {
  const lines: string[] = [];

  // Status emoji
  const statusEmoji: Record<string, string> = {
    success: "✅",
    error: "❌",
    info: "ℹ️",
    warning: "⚠️",
    progress: "🔄",
  };

  // Title
  if (options.title) {
    const emoji = options.status ? statusEmoji[options.status] + " " : "";
    lines.push(`${emoji}*${options.title}*`);
    lines.push("");
  }

  // Body (simple text)
  if (options.body) {
    lines.push(options.body);
    lines.push("");
  }

  // Sections
  if (options.sections) {
    for (const section of options.sections) {
      if (section.heading) {
        lines.push(`*${section.heading}*`);
      }
      lines.push(section.content);
      lines.push("");
    }
  }

  // Footer
  if (options.footer) {
    lines.push("───────────────────");
    lines.push(`_${options.footer}_`);
  }

  return lines.join("\n").trim();
}

/**
 * 작업 진행상황을 프로그레스 바 형태로 포맷합니다.
 */
export function formatProgressBar(current: number, total: number, width: number = 20): string {
  const ratio = Math.min(current / total, 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const pct = Math.round(ratio * 100);
  return `\`${bar}\` ${pct}% (${current}/${total})`;
}

/**
 * 키-값 쌍을 정렬된 테이블 형태로 포맷합니다.
 */
export function formatKeyValue(pairs: Array<[string, string | number | boolean]>): string {
  return pairs
    .map(([key, value]) => `• *${key}:* ${value}`)
    .join("\n");
}

/**
 * 에러 메시지를 보기 좋게 포맷합니다.
 */
export function formatError(title: string, error: string, hint?: string): string {
  const lines = [
    `❌ *${title}*`,
    "",
    `\`\`\`${error}\`\`\``,
  ];
  if (hint) {
    lines.push("", `💡 _${hint}_`);
  }
  return lines.join("\n");
}

/**
 * 요약 + 상세를 접을 수 있는 형태로 포맷합니다.
 * (Slack은 실제 collapsible을 지원하지 않으므로, 상세는 스레드에 보내도록 안내)
 */
export function formatSummaryDetail(summary: string, detailHint: string): string {
  return [
    summary,
    "",
    `_📎 ${detailHint}_`,
  ].join("\n");
}

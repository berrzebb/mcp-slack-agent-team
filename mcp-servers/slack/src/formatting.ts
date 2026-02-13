/**
 * Message formatting utilities — plain text and rich Slack mrkdwn formatting.
 */

import type { SlackFile, SlackMessage } from "./types.js";
import { AGENT_PERSONAS, PERSONA_NAME_TO_ROLE } from "./types.js";
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
      ? { method: "slack_respond" as const, thread_ts: msg.thread_ts!, channel: ch }
      : { method: "slack_respond" as const, channel: ch },
  };
}

/** command_loop/check_inbox 반환 시 포함할 워크플로우 지시사항 */
export function getWorkflowInstructions(unreadCount: number, hasMentions: boolean): string[] {
  const instructions: string[] = [];
  instructions.push(
    "[WORKFLOW]",
    "1. reply_to 필드를 slack_respond()에 그대로 전달 → 스레드/채널 자동 라우팅",
    "2. mentions 필드가 있으면 해당 팀원에게 slack_team_send(mention=[...])로 전달",
    "3. files 필드가 있으면 slack_download_file(file_id)로 다운로드 후 처리",
    "4. 작업 완료 후 slack_check_inbox(digest=true)로 인박스 확인 → 미읽 있으면 즉시 처리",
    "5. 미읽 없으면 slack_command_loop(timeout_seconds=60)으로 짧게 대기",
    "6. reply_mode: auto(기본)=thread_ts 유무로 자동결정, thread=강제 스레드, channel=강제 채널",
    "⚠️ [중요] 긴 작업 도중에도 5~10개 도구 호출마다 slack_command_loop(timeout_seconds=0) 또는 slack_check_inbox()를 호출하세요. 체크하지 않으면 사용자 명령을 놓칩니다.",
    "",
    "■ 리액션 활용 (능동적으로 사용하세요):",
    "  ▸ 메시지 확인 시: 👀 (eyes) → 작업 시작 시: 🚀 (rocket) → 완료 시: ✅ (white_check_mark)",
    "  ▸ 진행중: ⏳ (hourglass_flowing_sand) | 수정중: 🔧 (wrench) | 검토중: 📝 (memo)",
    "  ▸ 성공: 🎉 (tada) | 실패: ❌ (x) | 동의: 👍 (thumbsup) | 긴급: 🔥 (fire)",
    "  ▸ 상태 변경 시 이전 리액션을 slack_remove_reaction으로 정리 후 새 리액션 추가",
    "  ▸ 팀원 메시지, 사용자 질문, 보고 등에도 적절한 리액션으로 피드백하세요",
  );
  instructions.push(
    "",
    "■ MCP 장애 복구 (slack_* 도구 호출 실패 시):",
    "  ▸ MCP 서버가 크래시 후 자동 재시작됩니다 (최대 30초 소요)",
    "  ▸ 도구 호출 실패 시 10~30초 대기 후 재시도하세요 (최대 3회)",
    "  ▸ 3회 실패 시 작업을 계속 진행하되, 1~2분 후 다시 시도",
    "  ▸ 인박스 확인을 절대 포기하지 마세요 — MCP 복구 후 반드시 재개",
    "  ▸ 복구 후 slack_whoami()로 컨텍스트를 확인하세요",
  );
  if (hasMentions) {
    instructions.push("7. @멘션된 팀원에게 작업을 위임하거나 결과를 전달하세요");
  }
  return instructions;
}

/** 팀원 에이전트가 따라야 할 작업/보고 워크플로우 지시사항 */
export function getTeamWorkflowInstructions(context: {
  agentId: string;
  teamId: string;
  channelId: string;
  taskId?: string;
  taskTitle?: string;
  role?: string;
}): string[] {
  const { agentId, teamId, channelId, taskId, taskTitle, role } = context;

  // Resolve persona: try role → reverse lookup from agentId → null
  const persona = (role ? AGENT_PERSONAS[role] : null)
    || AGENT_PERSONAS[PERSONA_NAME_TO_ROLE[agentId.toLowerCase()] || ""]
    || AGENT_PERSONAS[agentId.toLowerCase()]
    || null;

  const lines: string[] = [
    "[TEAM WORKFLOW — 반드시 따르세요]",
    `팀: ${teamId} | 에이전트: ${agentId} | 채널: ${channelId}`,
  ];

  // ── Persona Identity Block (SOUL) ──
  if (persona) {
    const { soul } = persona;
    lines.push(
      "",
      `■ 🪪 당신의 SOUL — ${persona.emoji} ${persona.displayName} (${persona.title})`,
      `  정체성: ${soul.identity}`,
      `  말투: ${soul.tone}`,
      "",
      "  가치관:",
      ...soul.values.map(v => `    ▸ ${v}`),
      "",
      "  행동 패턴:",
      ...soul.behaviors.map(b => `    ▸ ${b}`),
      "",
      "  자주 쓰는 표현:",
      ...soul.catchphrases.map(c => `    ▸ "${c}"`),
      "",
      `  고유 특성: ${soul.quirk}`,
      "",
      "  ⚠️ SOUL 지침:",
      "  ▸ 위 성격과 말투를 팀 채팅에서 일관되게 유지하세요",
      "  ▸ 보고, 질문, 피드백 모두 당신의 페르소나에 맞는 어투로 작성",
      "  ▸ 자주 쓰는 표현을 자연스럽게 대화에 녹여내세요",
      "  ▸ 다른 팀원의 페르소나도 존중하며 자연스러운 대화를 만드세요",
    );

    // ── HEART (Core Directives & Ethics) ──
    const { heart } = persona;
    lines.push(
      "",
      `■ ❤️ 당신의 HEART — 절대 원칙과 윤리적 경계`,
      `  핵심 지침: ${heart.coreDirective}`,
      "",
      "  절대 원칙 (어기지 않는다):",
      ...heart.principles.map(p => `    🔒 ${p}`),
      "",
      "  금기 (절대 하지 않는다):",
      ...heart.boundaries.map(b => `    🚫 ${b}`),
      "",
      "  충돌 시 우선순위:",
      ...heart.priorities.map(p => `    ⚖️ ${p}`),
      "",
      "  팀 윤리:",
      ...heart.teamEthics.map(e => `    🤝 ${e}`),
      "",
      `  자기 조절: ${heart.selfRegulation}`,
      "",
      "  ⚠️ HEART 지침:",
      "  ▸ HEART는 SOUL보다 상위 — 성격이 어떻든 절대 원칙은 반드시 지킨다",
      "  ▸ 금기 항목을 위반하려는 상황이면 즉시 멈추고 리더에게 보고한다",
      "  ▸ 충돌 시 우선순위에 따라 판단하고, 판단 근거를 팀에 공유한다",
      "  ▸ 자기 조절 규칙을 따라 과부하/편향을 스스로 관리한다",
    );
  }

  lines.push(
    "",
    "■ 사용 가능한 주요 도구 (모든 팀원 공통):",
    "  ▸ slack_check_all_notifications — 멘션, 권한요청 결과, 팀 미읽 통합 확인 (0 API)",
    "  ▸ slack_mention_check — 나를 멘션한 메시지 확인",
    "  ▸ slack_team_read — 팀 채널 메시지 읽기 (인박스 우선, 0 API)",
    "  ▸ slack_team_send — 팀 채널에 메시지 보내기 + 멘션 (결과의 ts를 기억하세요!)",
    "  ▸ slack_team_wait — 팀 채널 새 메시지 대기 (timeout=0 논블로킹 가능)",
    "  ▸ slack_team_report — 메인+팀 채널에 진행 보고 (결과의 ts를 기억하세요!)",
    "  ▸ slack_team_thread — 스레드 읽기/답장",
    "  ▸ slack_team_update_message — 자신이 보낸 메시지 수정 (ts 필요). 상태 업데이트/결과 추가에 사용",
    "  ▸ slack_team_delete_message — 자신이 보낸 메시지 삭제 (잘못된/중복 메시지 정리)",
    "  ▸ slack_team_update_task — 태스크 상태 변경",
    "  ▸ slack_add_reaction — 메시지에 리액션 추가 (자유롭게 사용)",
    "  ▸ slack_remove_reaction — 메시지에서 리액션 제거 (상태 변경 시)",
    "  ▸ slack_team_request_permission — 위험한 작업만 리더에게 승인 요청 (메시지/읽기/보고는 권한 불필요!)",
    "  ▸ slack_heartbeat — 생존 신호 전송",
    "  ▸ slack_team_save_context — 작업 컨텍스트를 DB에 저장 (세션 종료 전, 압축 전에 반드시 호출)",
    "  ▸ slack_team_get_context — DB에서 컨텍스트 복구 (새 세션 시작 시 호출하여 이전 작업 이어받기)",
    "",
    "■ 리더/서브리더 전용 도구:",
    "  ▸ slack_resolve_permission — 팀원 권한 요청 승인/거부",
    "  ▸ slack_list_permissions — 대기 중인 권한 요청 목록",
    "  ▸ slack_team_assign_task — 팀원에게 태스크 할당",
    "  ▸ slack_team_broadcast — 팀 전체 공지",
    "  ▸ slack_progress_dashboard — 팀 대시보드 게시",
    "  ▸ slack_request_approval — 사용자에게 승인 요청",
    "",
    "■ 작업 시작 시:",
    `  slack_team_update_task(team_id="${teamId}", task_id="${taskId || "?"}", status="in-progress")`,
    `  slack_team_send(team_id="${teamId}", sender="${agentId}", message="작업 시작: ${taskTitle || "..."}")`,
    "",
    "■ 중간 진행 보고 (긴 작업 시 주기적으로):",
    `  slack_team_send(team_id="${teamId}", sender="${agentId}", message="진행 상황 요약...")`,
    "",
    "■ 작업 완료 시 (반드시):",
    `  slack_team_update_task(team_id="${teamId}", task_id="${taskId || "?"}", status="done", result_summary="결과 요약")`,
    `  slack_team_report(team_id="${teamId}", sender="${agentId}", summary="결과 요약", status="done")`,
    "",
    "■ 문제/차단 발생 시:",
    `  slack_team_update_task(team_id="${teamId}", task_id="${taskId || "?"}", status="blocked")`,
    `  slack_team_send(team_id="${teamId}", sender="${agentId}", message="차단: 이유 설명")`,
    "",
    "■ ⚠️ 주기적 알림 확인 (필수 — 5~10개 도구 호출마다):",
    `  slack_check_all_notifications(agent_id="${agentId}", team_id="${teamId}")`,
    `  또는: slack_team_wait(team_id="${teamId}", timeout_seconds=0)  ← 논블로킹, 즉시 반환`,
    "  → 체크하지 않으면 리더 지시, 멘션, 권한 결과를 놓칩니다!",
    "  → 긴 작업(빌드, 테스트, 다수 파일 편집) 중에도 반드시 주기적으로 호출하세요.",
    "",
    "⚠️ 팀 채널에 보고하지 않으면 다른 팀원과 사용자가 진행 상황을 알 수 없습니다.",
    "⚠️ 작업 완료 후 반드시 slack_team_report로 메인 채널에도 보고하세요.",
    "",
    "■ 리액션 활용 (능동적으로 사용 — 대화를 풍성하게):",
    "  ▸ 다른 팀원 메시지 확인 시 → 👀 (eyes) 또는 👍 (thumbsup)",
    "  ▸ 작업 시작 → 🚀 (rocket), 진행중 → ⏳ (hourglass_flowing_sand)",
    "  ▸ 완료 → ✅ (white_check_mark) + 🎉 (tada), 문제 → ❌ (x) + 🔥 (fire)",
    "  ▸ 상태 변경 시 slack_remove_reaction으로 이전 리액션 정리 → 새 리액션 추가",
    "  ▸ 팀 채널에서 자유롭게 의견/질문/피드백 대화를 해도 됩니다",
    "  ▸ 리더 메시지, 다른 팀원 보고 등에 적극적으로 리액션/답장하세요",
    "",
    "■ 팀원 멘션 방법 (slack_team_send의 mention 파라미터):",
    "  ▸ 페르소나 이름: ['@Aria'], ['@Sage'], ['@Nova'], ['@Forge'] 등",
    "  ▸ 역할명: ['lead'], ['planner'], ['sub-leader'], ['implementer'] 등",
    "  ▸ 여러 명: ['@Forge', '@Sage'] 또는 ['implementer', 'planner']",
    "  ▸ 팀원 목록: Aria(리드), Sage(설계), Nova(서브리더), Forge(엔지니어), Quinn(DB), Lens(리뷰), Pixel(UX), Trace(디버거), Spec(테스트), Prism(리팩토러), Gate(검증), Scout(리서처)",
    "",
    "■ 컨텍스트 관리 (작업 연속성 보장):",
    "  ▸ 세션 시작 시: slack_team_get_context → 이전 작업 내용 복구",
    "  ▸ 세션 종료 전/압축 전: slack_team_save_context → 현재 작업 상태 저장",
    "  ▸ 저장 내용: 진행 중인 파일, 변경 사항, 남은 작업, 주요 결정사항",
    "",
    "■ 메시지 수정/삭제 (대화 품질 관리):",
    "  ▸ 상태 업데이트: send 결과의 ts를 기억 → 나중에 update_message로 진행률 갱신",
    "  ▸ 예: '작업 시작: 빌드 점검' → '✅ 빌드 점검 완료 (2/3 에러 수정)'",
    "  ▸ 잘못된 메시지: delete_message로 즉시 삭제 → 올바른 내용으로 재전송",
    "  ▸ 진행 보고도 완료 시 update_message로 최종 결과를 반영하세요",
    "",
    "🚫 권한 요청 주의사항:",
    "  메시지 보내기/읽기/보고/멘션/하트비트 등 일반 Slack 작업은 권한이 필요 없습니다!",
    "  slack_team_send, slack_team_read, slack_team_report 등은 직접 호출하세요.",
    "  slack_team_request_permission은 DB 마이그레이션, 프로덕션 배포, 파일 삭제 등 위험한 작업에만 사용.",
    "",
    "■ MCP 장애 복구 (slack_* 도구 호출이 실패할 때):",
    "  ▸ MCP 서버는 크래시 후 자동 재시작됩니다 (1~30초 백오프)",
    "  ▸ 도구 실패 시 10~30초 대기 후 재시도하세요 (최대 3회)",
    "  ▸ 3회 연속 실패해도 코딩 작업은 멈추지 마세요 — 1~2분 후 다시 시도",
    "  ▸ 인박스/알림 확인을 절대 포기하지 마세요 — 복구 후 반드시 재개",
    "  ▸ 복구 후 slack_whoami()로 팀·태스크 컨텍스트를 즉시 확인",
  );

  return lines;
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

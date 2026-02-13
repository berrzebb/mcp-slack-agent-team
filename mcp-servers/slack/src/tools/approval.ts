/**
 * Approval tool: slack_request_approval
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SlackMessage } from "../types.js";
import { SLACK_DEFAULT_CHANNEL } from "../types.js";
import { teams } from "../state.js";
import { getRoleIcon } from "../state.js";
import { slack, resolveBotUserId, sleep } from "../slack-client.js";
import { logDecision } from "../db.js";

export function registerApprovalTools(server: McpServer): void {

  server.tool(
    "slack_request_approval",
    "사용자에게 승인을 요청하고 응답을 대기합니다. 문제 발생, 중요 결정, 위험한 작업 전에 사용자 확인이 필요할 때 호출합니다. 메인 채널에 승인 요청을 게시하고 사용자가 ✅(승인) 또는 ❌(거부) 리액션이나 텍스트로 응답할 때까지 대기합니다.",
    {
      title: z.string().describe("승인 요청 제목 (예: DB 마이그레이션 실행, 프로덕션 배포)"),
      description: z.string().describe("승인이 필요한 이유와 상세 설명"),
      team_id: z.string().optional().describe("팀 식별자 (팀 컨텍스트에서 요청 시)"),
      sender: z.string().optional().describe("요청하는 멤버 ID (팀 컨텍스트)"),
      options: z.array(z.string()).optional().describe("선택지 목록 (예: ['옵션A: 롤백', '옵션B: 계속 진행', '옵션C: 중단']). 미지정 시 승인/거부만."),
      channel: z.string().optional().describe("승인 요청을 보낼 채널 (미지정 시 메인 채널)"),
      timeout_seconds: z.number().min(30).max(600).default(300).describe("응답 대기 시간 (초). 기본 300초(5분)."),
      poll_interval_seconds: z.number().min(2).max(30).default(5).describe("폴링 간격 (초). 기본 5초."),
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

      // 폴링: 리액션 또는 스레드 답장 확인 (staggered — 1 API call/cycle instead of 2)
      const deadline = Date.now() + timeout_seconds * 1000;
      const interval = poll_interval_seconds * 1000;
      let approvalCycle = 0;

      while (Date.now() < deadline) {
        approvalCycle++;
        await sleep(interval);

        // 1) 리액션 확인 (odd cycles)
        if (approvalCycle % 2 === 1) try {
          const reactResult = await slack.reactions.get({
            channel: ch,
            timestamp: approvalTs,
            full: true,
          });

          const reactions = (reactResult.message as { reactions?: Array<{ name: string; users?: string[] }> })?.reactions || [];
          // Deny takes priority over approve for safety
          let hasApprove: { name: string; user: string } | null = null;
          for (const r of reactions) {
            const nonBotUsers = (r.users || []).filter((u) => u !== myUserId);
            if (nonBotUsers.length === 0) continue;

            if (["x", "-1", "no_entry", "thumbsdown", "no_entry_sign"].includes(r.name)) {
              await slack.reactions.add({ channel: ch, name: "x", timestamp: approvalTs }).catch(() => {});
              if (team_id) logDecision({ team_id, decision_type: "approval", question: title, answer: `거부됨 (리액션 :${r.name}:)`, decided_by: nonBotUsers[0] });
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    ok: true, approved: false, method: "reaction",
                    reaction: r.name, user: nonBotUsers[0],
                    approval_ts: approvalTs, message: `❌ 거부됨 (:${r.name}: 리액션)`,
                  }, null, 2),
                }],
              };
            }

            if (["white_check_mark", "+1", "heavy_check_mark", "thumbsup"].includes(r.name)) {
              hasApprove = { name: r.name, user: nonBotUsers[0] };
            }
          }
          if (hasApprove) {
            await slack.reactions.add({ channel: ch, name: "white_check_mark", timestamp: approvalTs }).catch(() => {});
            if (team_id) logDecision({ team_id, decision_type: "approval", question: title, answer: `승인됨 (리액션 :${hasApprove.name}:)`, decided_by: hasApprove.user });
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  ok: true, approved: true, method: "reaction",
                  reaction: hasApprove.name, user: hasApprove.user,
                  approval_ts: approvalTs, message: `✅ 승인됨 (:${hasApprove.name}: 리액션)`,
                }, null, 2),
              }],
            };
          }
        } catch {
          // reactions.get 실패 시 무시
        }

        // 2) 스레드 텍스트 답장 확인 (even cycles)
        if (approvalCycle % 2 === 0) try {
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

            // Use exact word matching to avoid false positives (e.g. "token" matching "ok")
            const approveExact = ["승인", "확인", "진행", "ㅇㅇ", "ㄱㄱ", "ok", "yes", "approve", "approved", "lgtm", "go", "proceed"];
            const denyExact = ["거부", "거절", "중단", "취소", "ㄴㄴ", "no", "deny", "denied", "reject", "stop", "cancel", "abort"];

            // Check deny first (deny takes priority when both match)
            const isDenied = denyExact.some((p) => text === p || text.startsWith(p + " ") || text.startsWith(p + "."));
            const isApproved = !isDenied && approveExact.some((p) => text === p || text.startsWith(p + " ") || text.startsWith(p + "."));

            if (isApproved || isDenied) {
              const emoji = isApproved ? "white_check_mark" : "x";
              await slack.reactions.add({ channel: ch, name: emoji, timestamp: approvalTs }).catch(() => {});
              if (team_id) logDecision({ team_id, decision_type: "approval", question: title, answer: isApproved ? `승인됨: ${latest.text}` : `거부됨: ${latest.text}`, decided_by: latest.user || "user" });
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    ok: true, approved: isApproved, method: "text",
                    reply_text: latest.text, user: latest.user,
                    reply_ts: latest.ts, approval_ts: approvalTs,
                    message: isApproved ? "✅ 승인됨 (텍스트 응답)" : "❌ 거부됨 (텍스트 응답)",
                  }, null, 2),
                }],
              };
            }

            // 선택지 응답
            if (options && options.length > 0) {
              const numMatch = text.match(/^(\d+)/);
              const selectedIdx = numMatch ? parseInt(numMatch[1], 10) - 1 : -1;
              const selectedOption = selectedIdx >= 0 && selectedIdx < options.length
                ? options[selectedIdx]
                : latest.text;

              await slack.reactions.add({ channel: ch, name: "white_check_mark", timestamp: approvalTs }).catch(() => {});
              if (team_id) logDecision({ team_id, decision_type: "approval", question: title, answer: `선택: ${selectedOption}`, decided_by: latest.user || "user" });
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    ok: true, approved: true, method: "choice",
                    selected_option: selectedOption,
                    selected_index: selectedIdx >= 0 ? selectedIdx : null,
                    reply_text: latest.text, user: latest.user,
                    reply_ts: latest.ts, approval_ts: approvalTs,
                    message: `선택됨: ${selectedOption}`,
                  }, null, 2),
                }],
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
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: false, approved: null, reason: "timeout",
            timeout_seconds, approval_ts: approvalTs,
            message: `⏰ ${timeout_seconds}초 동안 응답 없음. 작업을 중단하거나 다시 요청하세요.`,
          }, null, 2),
        }],
      };
    }
  );
}

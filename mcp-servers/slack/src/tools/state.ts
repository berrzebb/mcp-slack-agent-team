/**
 * State & cost tools: slack_save_state, slack_load_state, slack_cost_report
 */

import { z } from "zod";
import { execSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  LoopState, CcusageDailyResult, CcusageMonthlyResult, CcusageTotals,
} from "../types.js";
import { SLACK_DEFAULT_CHANNEL, DB_FILE } from "../types.js";
import { teams, loadState, saveState, saveTeamsToState, restoreTeamsFromState, agentIdentity } from "../state.js";
import { slack } from "../slack-client.js";
import { saveCostReport, getTeamTasks, getTeamContexts, getRecentDecisions } from "../db.js";

// ── ccusage helpers ────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────

export function registerStateTools(server: McpServer): void {

  // ── slack_save_state ─────────────────────────────────────────

  server.tool(
    "slack_save_state",
    "현재 Slack 루프 상태를 SQLite에 저장합니다. compact/재시작 후 복구에 사용. 중요한 시점마다 호출하세요.",
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
        content: [{
          type: "text",
          text: JSON.stringify(
            { ok: true, storage: "sqlite", db_file: DB_FILE, loop: loopState, teams_saved: teams.size },
            null, 2
          ),
        }],
      };
    }
  );

  // ── slack_load_state ─────────────────────────────────────────

  server.tool(
    "slack_load_state",
    "저장된 Slack 루프 상태를 복구합니다. compact 후 가장 먼저 호출하여 이전 상태를 복원하세요. 팀 컨텍스트가 있으면 SQLite에서 태스크/의사결정 요약도 함께 반환합니다.",
    {},
    async () => {
      const state = loadState();
      if (!state) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, message: "저장된 상태가 없습니다." }) }],
        };
      }

      restoreTeamsFromState();

      // Collect team context summaries from SQLite
      const teamContextSummaries: Record<string, unknown> = {};
      for (const [teamId] of teams) {
        const tasks = getTeamTasks(teamId);
        const contexts = getTeamContexts(teamId);
        const decisions = getRecentDecisions(teamId, 5);

        const tasksByStatus: Record<string, number> = {};
        for (const t of tasks) tasksByStatus[t.status] = (tasksByStatus[t.status] || 0) + 1;

        teamContextSummaries[teamId] = {
          tasks_total: tasks.length,
          tasks_by_status: tasksByStatus,
          agents_with_context: contexts.length,
          recent_decisions: decisions.length,
          hint: contexts.length > 0
            ? `slack_team_get_context(team_id='${teamId}', agent_id='YOUR_ID')로 상세 컨텍스트 복구 가능`
            : "컨텍스트 저장된 적 없음",
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            loop: state.loop,
            teams_restored: Object.keys(state.teams || {}).length,
            team_contexts: Object.keys(teamContextSummaries).length > 0 ? teamContextSummaries : undefined,
            updated_at: state.updated_at,
            hint: state.loop?.active
              ? `루프가 활성 상태였습니다. slack_command_loop(channel='${state.loop.channel}', since_ts='${state.loop.last_ts}')로 재개하세요.`
              : "루프가 비활성 상태였습니다.",
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_cost_report ────────────────────────────────────────

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

      if (report_type === "daily") {
        const entries = (data as CcusageDailyResult).daily;
        if (entries.length > 0) {
          const first = entries[0].date;
          const last = entries[entries.length - 1].date;
          lines.splice(1, 0, `📅 ${first} ~ ${last} (${entries.length}일)`);
        }
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

      if (breakdown) {
        const entries = report_type === "daily"
          ? (data as CcusageDailyResult).daily
          : (data as CcusageMonthlyResult).monthly;

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

      const mainMsg = await slack.chat.postMessage({
        channel: ch,
        text,
        mrkdwn: true,
      });

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
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            total_cost_usd: totals.totalCost,
            total_tokens: totals.totalTokens,
            input_tokens: totals.inputTokens,
            output_tokens: totals.outputTokens,
            cache_read_tokens: totals.cacheReadTokens,
            cache_creation_tokens: totals.cacheCreationTokens,
            channel: ch, ts: mainMsg.ts,
            message: `ccusage 비용 리포트 전송 완료: ${formatUsd(totals.totalCost)}`,
          }, null, 2),
        }],
      };
    }
  );
}

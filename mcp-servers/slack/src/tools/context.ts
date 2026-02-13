/**
 * Context management tools: assign_task, update_task, get_context, log_decision, list_tasks
 *
 * SQLite-based persistent team context store for massive token savings.
 * Replaces free-text Slack message parsing with structured DB queries.
 * Survives context compaction — agent resumes from structured state.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TaskStatus } from "../types.js";
import { AGENT_PERSONAS, PERSONA_NAME_TO_ROLE } from "../types.js";
import {
  upsertTask, updateTaskStatus, getTask, getTeamTasks,
  getAgentTasks, getPendingTasks,
  saveAgentContext, getAgentContext, getTeamContexts,
  logDecision, getTeamDecisions, getRecentDecisions,
} from "../db.js";
import { getTeam, getRoleIcon, teams, resolveTeamId, ensureTeamsLoaded } from "../state.js";
import { slack } from "../slack-client.js";
import { agentIdentity } from "../state.js";
import { getTeamWorkflowInstructions } from "../formatting.js";

export function registerContextTools(server: McpServer): void {

  // ── slack_team_assign_task ───────────────────────────────────

  server.tool(
    "slack_team_assign_task",
    "팀원에게 구조화된 태스크를 할당합니다. Slack 메시지 대신 SQLite에 저장되어 컨텍스트 압축 후에도 유지됩니다. 태스크 ID로 상태 추적, 의존성 관리, 결과 요약이 가능합니다.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      task_id: z.string().describe("태스크 고유 ID (예: T1, forge-1, spec-2)"),
      title: z.string().describe("태스크 제목 (간결하게)"),
      description: z.string().describe("태스크 상세 설명 — 목표, 범위, 기대 결과물"),
      assigned_to: z.string().describe("할당 대상 멤버 ID (예: Forge, Nova)"),
      assigned_by: z.string().describe("할당자 멤버 ID (예: Aria, Nova)"),
      track: z.string().optional().describe("담당 트랙 (예: A, B)"),
      dependencies: z.array(z.string()).default([]).describe("선행 태스크 ID 목록 (예: ['T1', 'T2']). 빈 배열이면 독립 태스크."),
      notify: z.boolean().default(true).describe("팀 채널에 할당 알림 메시지 전송 여부"),
    },
    async ({ team_id: rawTeamId, task_id, title, description, assigned_to, assigned_by, track, dependencies, notify }) => {
      const team_id = resolveTeamId(rawTeamId);
      const team = getTeam(team_id);

      // Check dependencies exist
      const missingDeps: string[] = [];
      for (const dep of dependencies) {
        if (!getTask(team_id, dep)) missingDeps.push(dep);
      }
      if (missingDeps.length > 0) {
        throw new Error(`선행 태스크를 찾을 수 없습니다: ${missingDeps.join(", ")}`);
      }

      // Check blocked by incomplete dependencies
      const blockedBy: string[] = [];
      for (const dep of dependencies) {
        const depTask = getTask(team_id, dep)!;
        if (depTask.status !== "done") blockedBy.push(`${dep} (${depTask.status})`);
      }

      const status: TaskStatus = blockedBy.length > 0 ? "pending" : "assigned";

      upsertTask({
        id: task_id,
        team_id,
        title,
        description,
        assigned_to,
        assigned_by,
        track,
        dependencies,
        status,
      });

      // Notify in team channel
      if (notify) {
        const member = team.members.get(assigned_by);
        const identity = member
          ? agentIdentity(assigned_by, member)
          : { username: assigned_by, icon_emoji: ":clipboard:" };

        const depsStr = dependencies.length > 0
          ? `\n📎 의존성: ${dependencies.join(", ")}`
          : "";
        const blockStr = blockedBy.length > 0
          ? `\n⏳ 대기 중: ${blockedBy.join(", ")}`
          : "";

        await slack.chat.postMessage({
          channel: team.channelId,
          text: [
            `📋 *[태스크 할당]* \`${task_id}\`: ${title}`,
            `→ *@${assigned_to}*${track ? ` [Track ${track}]` : ""}`,
            description.length > 200 ? description.substring(0, 200) + "..." : description,
            depsStr,
            blockStr,
          ].filter(Boolean).join("\n"),
          mrkdwn: true,
          username: identity.username,
          icon_emoji: identity.icon_emoji,
        });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            task_id,
            team_id,
            assigned_to,
            status,
            blocked_by: blockedBy.length > 0 ? blockedBy : undefined,
            message: blockedBy.length > 0
              ? `태스크 ${task_id} 생성됨 (선행 태스크 대기 중)`
              : `태스크 ${task_id}이(가) ${assigned_to}에게 할당됨`,
            workflow_for_assignee: getTeamWorkflowInstructions({
              agentId: assigned_to,
              teamId: team_id,
              channelId: team.channelId,
              taskId: task_id,
              taskTitle: title,
              role: team.members.get(assigned_to)?.role,
            }),
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_team_update_task ───────────────────────────────────

  server.tool(
    "slack_team_update_task",
    "태스크 상태를 업데이트합니다. 작업 시작, 완료, 차단, 결과 요약 기록에 사용. 완료 시 의존 태스크가 자동으로 unblock됩니다.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      task_id: z.string().describe("태스크 ID"),
      status: z.enum(["in-progress", "blocked", "review", "done", "cancelled"]).describe("새 상태"),
      result_summary: z.string().optional().describe("결과 요약 (done/review 시 기록). 압축 후 이 요약만으로 컨텍스트 복구 가능."),
      sender: z.string().optional().describe("상태 업데이트하는 멤버 ID (채널 알림용)"),
      notify: z.boolean().default(true).describe("팀 채널에 상태 변경 알림"),
    },
    async ({ team_id: rawTeamId, task_id, status, result_summary, sender, notify }) => {
      const team_id = resolveTeamId(rawTeamId);
      const task = getTask(team_id, task_id);
      if (!task) throw new Error(`태스크 '${task_id}'를 찾을 수 없습니다 (팀: ${team_id})`);

      updateTaskStatus(team_id, task_id, status as TaskStatus, result_summary);

      // Auto-unblock dependent tasks when this task completes
      const unblocked: string[] = [];
      if (status === "done") {
        const allTasks = getTeamTasks(team_id);
        for (const t of allTasks) {
          if (t.status === "pending" && t.dependencies.includes(task_id)) {
            // Check if ALL dependencies are now done
            const allDepsDone = t.dependencies.every((dep) => {
              if (dep === task_id) return true;
              const depTask = getTask(team_id, dep);
              return depTask?.status === "done";
            });
            if (allDepsDone) {
              updateTaskStatus(team_id, t.id, "assigned");
              unblocked.push(t.id);
            }
          }
        }
      }

      // Notify
      if (notify) {
        const team = getTeam(team_id);
        const statusEmoji: Record<string, string> = {
          "in-progress": "🔨", blocked: "🚫", review: "👀", done: "✅", cancelled: "❌",
        };
        const emoji = statusEmoji[status] || "📋";
        const unblockedStr = unblocked.length > 0
          ? `\n🔓 Unblocked: ${unblocked.join(", ")}`
          : "";

        const senderMember = sender ? team.members.get(sender) : undefined;
        const identity = senderMember
          ? agentIdentity(sender!, senderMember)
          : { username: sender || "system", icon_emoji: ":gear:" };

        await slack.chat.postMessage({
          channel: team.channelId,
          text: `${emoji} \`${task_id}\`: ${task.title} → *${status}*${result_summary ? `\n${result_summary.substring(0, 300)}` : ""}${unblockedStr}`,
          mrkdwn: true,
          username: identity.username,
          icon_emoji: identity.icon_emoji,
        });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            task_id,
            previous_status: task.status,
            new_status: status,
            result_summary: result_summary || null,
            unblocked: unblocked.length > 0 ? unblocked : undefined,
            message: `태스크 ${task_id} → ${status}`,
            next_action: status === "done"
              ? `⚠️ 작업 완료! 반드시 slack_team_report(team_id="${team_id}", sender="${sender || task.assigned_to}", summary="${(result_summary || "").substring(0, 50)}...", status="done")를 호출하여 메인 채널에 보고하세요.`
              : status === "blocked"
              ? `⚠️ 차단됨! slack_team_send로 리더에게 차단 사유를 알리세요.`
              : undefined,
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_team_list_tasks ────────────────────────────────────

  server.tool(
    "slack_team_list_tasks",
    "팀의 태스크 목록을 조회합니다. 특정 에이전트, 트랙, 상태로 필터링 가능. Slack 메시지 히스토리를 읽을 필요 없이 구조화된 태스크 정보를 반환합니다.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      assigned_to: z.string().optional().describe("특정 에이전트의 태스크만 (미지정 시 전체)"),
      pending_only: z.boolean().default(false).describe("미완료 태스크만 조회"),
      include_results: z.boolean().default(false).describe("완료된 태스크의 result_summary 포함"),
    },
    async ({ team_id: rawTeamId, assigned_to, pending_only, include_results }) => {
      const team_id = resolveTeamId(rawTeamId);
      let tasks;
      if (assigned_to) {
        tasks = getAgentTasks(team_id, assigned_to);
      } else if (pending_only) {
        tasks = getPendingTasks(team_id);
      } else {
        tasks = getTeamTasks(team_id);
      }

      const statusEmoji: Record<string, string> = {
        pending: "⏳", assigned: "📋", "in-progress": "🔨",
        blocked: "🚫", review: "👀", done: "✅", cancelled: "❌",
      };

      const compact = tasks.map((t) => {
        const e = statusEmoji[t.status] || "📋";
        const base: Record<string, unknown> = {
          id: t.id,
          status: `${e} ${t.status}`,
          title: t.title,
          assigned_to: t.assigned_to,
        };
        if (t.track) base.track = t.track;
        if (t.dependencies.length > 0) base.deps = t.dependencies;
        if (include_results && t.result_summary) base.result = t.result_summary;
        return base;
      });

      const summary = {
        team_id,
        total: tasks.length,
        by_status: {} as Record<string, number>,
        tasks: compact,
      };

      for (const t of tasks) {
        summary.by_status[t.status] = (summary.by_status[t.status] || 0) + 1;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  // ── slack_team_save_context ──────────────────────────────────

  server.tool(
    "slack_team_save_context",
    "에이전트의 현재 컨텍스트를 SQLite에 저장합니다. 컨텍스트 압축(compaction) 전에 반드시 호출하세요. 저장된 컨텍스트는 slack_team_get_context로 즉시 복구할 수 있어 Slack 히스토리 재읽기가 불필요합니다.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      agent_id: z.string().describe("에이전트/멤버 ID (예: Nova, Forge)"),
      current_task_id: z.string().optional().describe("현재 작업 중인 태스크 ID"),
      context: z.record(z.unknown()).describe("에이전트의 컨텍스트 데이터 (JSON). 예: { goal, progress, notes, blockers, next_steps }"),
    },
    async ({ team_id: rawTeamId, agent_id, current_task_id, context }) => {
      const team_id = resolveTeamId(rawTeamId);
      const team = getTeam(team_id);
      const member = team.members.get(agent_id);
      if (!member) throw new Error(`멤버 '${agent_id}'가 팀 '${team_id}'에 없습니다.`);

      saveAgentContext({
        agent_id,
        team_id,
        role: member.role,
        track: member.track,
        current_task_id,
        context_snapshot: { ...context, channelId: team.channelId },
        last_updated: new Date().toISOString(),
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            agent_id,
            team_id,
            current_task_id: current_task_id || null,
            context_keys: Object.keys(context),
            message: `컨텍스트 저장 완료 — 압축 후 slack_team_get_context로 복구하세요`,
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_team_get_context ───────────────────────────────────

  server.tool(
    "slack_team_get_context",
    "에이전트의 저장된 컨텍스트 + 할당 태스크 + 관련 의사결정을 한 번에 복구합니다. 컨텍스트 압축(compaction) 후 가장 먼저 호출하세요. Slack 메시지 히스토리를 읽지 않고 구조화된 데이터로 즉시 복구됩니다.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      agent_id: z.string().describe("복구할 에이전트 ID"),
      include_all_tasks: z.boolean().default(false).describe("true: 팀 전체 태스크 포함 (lead/sub-leader용). false: 자기 태스크만"),
      include_decisions: z.boolean().default(true).describe("관련 의사결정 이력 포함"),
    },
    async ({ team_id: rawTeamId, agent_id, include_all_tasks, include_decisions }) => {
      const team_id = resolveTeamId(rawTeamId);
      // 1. Agent context snapshot
      const ctx = getAgentContext(team_id, agent_id);

      // 2. Tasks
      const myTasks = getAgentTasks(team_id, agent_id);
      const allTasks = include_all_tasks ? getTeamTasks(team_id) : undefined;

      // 3. Decisions
      const decisions = include_decisions ? getRecentDecisions(team_id, 20) : [];

      // 4. Team overview (compact)
      const team = getTeam(team_id);
      const teamOverview = {
        id: team.id,
        name: team.name,
        channel_id: team.channelId,
        status: team.status,
        members: [...team.members.entries()].map(([id, m]) => {
          const p = AGENT_PERSONAS[m.role];
          return {
            id,
            role: m.role,
            persona: p ? `${p.displayName} — ${p.title}` : undefined,
            track: m.track,
            status: m.status,
          };
        }),
      };

      // Build compact recovery payload
      const recovery: Record<string, unknown> = {
        _hint: "이 데이터는 SQLite에서 복구됨. Slack 히스토리 재읽기 불필요.",
        team: teamOverview,
        agent: {
          id: agent_id,
          role: ctx?.role || "unknown",
          track: ctx?.track,
          current_task: ctx?.current_task_id,
          context: ctx?.context_snapshot || {},
          last_saved: ctx?.last_updated || "없음",
        },
        my_tasks: myTasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          deps: t.dependencies.length > 0 ? t.dependencies : undefined,
          result: t.result_summary || undefined,
          description: t.description,
        })),
      };

      if (allTasks) {
        recovery.all_tasks = allTasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          assigned_to: t.assigned_to,
          track: t.track,
          result: t.result_summary || undefined,
        }));
      }

      if (decisions.length > 0) {
        recovery.decisions = decisions.map((d) => ({
          type: d.decision_type,
          q: d.question,
          a: d.answer,
          by: d.decided_by,
          at: d.created_at,
        }));
      }

      // Find current or next pending task for instructions
      const currentTask = myTasks.find((t) => t.status === "in-progress")
        || myTasks.find((t) => t.status === "assigned")
        || myTasks.find((t) => t.status === "pending");

      recovery.workflow = getTeamWorkflowInstructions({
        agentId: agent_id,
        teamId: team_id,
        channelId: team.channelId,
        taskId: currentTask?.id,
        taskTitle: currentTask?.title,
        role: ctx?.role,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(recovery, null, 2) }],
      };
    }
  );

  // ── slack_team_log_decision ──────────────────────────────────

  server.tool(
    "slack_team_log_decision",
    "팀의 중요 의사결정을 기록합니다. 승인, 설계 결정, 우선순위 변경 등을 영구 저장하여 압축 후 재요청/재확인을 방지합니다.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      decision_type: z.enum(["approval", "design", "priority", "blocker", "scope", "other"]).describe("의사결정 유형"),
      question: z.string().describe("결정 사항 (질문/이슈)"),
      answer: z.string().describe("결정 내용 (답변/결론)"),
      decided_by: z.string().describe("결정자 (예: user, lead, team)"),
      notify: z.boolean().default(true).describe("팀 채널에 결정 알림"),
    },
    async ({ team_id: rawTeamId, decision_type, question, answer, decided_by, notify }) => {
      const team_id = resolveTeamId(rawTeamId);
      logDecision({ team_id, decision_type, question, answer, decided_by });

      if (notify) {
        const team = getTeam(team_id);
        const typeEmoji: Record<string, string> = {
          approval: "✅", design: "🏗️", priority: "🔢", blocker: "🚧", scope: "📐", other: "📌",
        };
        const emoji = typeEmoji[decision_type] || "📌";

        await slack.chat.postMessage({
          channel: team.channelId,
          text: `${emoji} *[결정]* ${decision_type}\n❓ ${question}\n✅ ${answer}\n결정자: *${decided_by}*`,
          mrkdwn: true,
        });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            team_id,
            decision_type,
            message: `의사결정 기록 완료: ${question.substring(0, 50)}...`,
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_team_decisions ─────────────────────────────────────

  server.tool(
    "slack_team_decisions",
    "팀의 의사결정 이력을 조회합니다. 압축 후 이전에 내린 결정을 확인하여 중복 질문/승인 요청을 방지합니다.",
    {
      team_id: z.string().optional().describe("팀 식별자 (활성 팀이 1개면 생략 가능)"),
      decision_type: z.string().optional().describe("특정 유형만 필터링 (예: approval, design)"),
      limit: z.number().min(1).max(50).default(20).describe("최대 조회 수"),
    },
    async ({ team_id: rawTeamId, decision_type, limit }) => {
      const team_id = resolveTeamId(rawTeamId);
      const decisions = decision_type
        ? getRecentDecisions(team_id, limit).filter((d) => d.decision_type === decision_type)
        : getRecentDecisions(team_id, limit);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            team_id,
            total: decisions.length,
            decisions: decisions.map((d) => ({
              type: d.decision_type,
              question: d.question,
              answer: d.answer,
              decided_by: d.decided_by,
              at: d.created_at,
            })),
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_whoami ─────────────────────────────────────────────

  server.tool(
    "slack_whoami",
    "🔑 compact/재시작 후 가장 먼저 호출하세요. 파라미터 없이 호출하면 모든 활성 팀, 에이전트 컨텍스트, 현재 태스크, 워크플로우 지시사항을 한 번에 반환합니다. team_id/agent_id를 모를 때도 사용 가능.",
    {
      agent_id: z.string().optional().describe("에이전트 ID (알면 입력, 모르면 비워두면 전체 반환)"),
    },
    async ({ agent_id }) => {
      // Always refresh teams from SQLite (other processes may have created teams)
      ensureTeamsLoaded();

      const result: Record<string, unknown> = {
        _hint: "compact 후 컨텍스트 복구 완료. 아래 정보로 작업을 재개하세요.",
        active_teams: [] as unknown[],
      };

      const activeTeams: unknown[] = [];

      for (const [teamId, team] of teams) {
        if (team.status === "archived" || team.status === "completed") continue;

        const contexts = getTeamContexts(teamId);
        const tasks = getTeamTasks(teamId);

        // Find agent in this team (by agent_id if provided)
        let myContext = agent_id
          ? contexts.find((c) => c.agent_id === agent_id)
          : undefined;
        let myTasks = agent_id
          ? tasks.filter((t) => t.assigned_to === agent_id)
          : [];
        const myMember = agent_id ? team.members.get(agent_id) : undefined;

        const teamInfo: Record<string, unknown> = {
          team_id: teamId,
          team_name: team.name,
          channel_id: team.channelId,
          channel_name: team.channelName,
          members: [...team.members.entries()].map(([id, m]) => {
            const p = AGENT_PERSONAS[m.role];
            return {
              id,
              role: m.role,
              persona: p ? `${p.emoji} ${p.displayName} — ${p.title}` : undefined,
              soul_identity: p?.soul.identity,
              soul_tone: p?.soul.tone,
              heart_directive: p?.heart.coreDirective,
              track: m.track,
              status: m.status,
            };
          }),
        };

        // If agent_id provided and found in this team, add detailed context
        if (agent_id && (myContext || myMember)) {
          const currentTask = myTasks.find((t) => t.status === "in-progress")
            || myTasks.find((t) => t.status === "assigned")
            || myTasks.find((t) => t.status === "pending");

          const myRole = myContext?.role || myMember?.role || "unknown";
          const myPersona = AGENT_PERSONAS[myRole];

          teamInfo.my_context = {
            agent_id,
            role: myRole,
            persona: myPersona ? `${myPersona.emoji} ${myPersona.displayName} (${myPersona.title})` : undefined,
            soul: myPersona?.soul ? {
              identity: myPersona.soul.identity,
              tone: myPersona.soul.tone,
              values: myPersona.soul.values,
              catchphrases: myPersona.soul.catchphrases,
              quirk: myPersona.soul.quirk,
            } : undefined,
            heart: myPersona?.heart ? {
              coreDirective: myPersona.heart.coreDirective,
              principles: myPersona.heart.principles,
              boundaries: myPersona.heart.boundaries,
              priorities: myPersona.heart.priorities,
              selfRegulation: myPersona.heart.selfRegulation,
            } : undefined,
            track: myContext?.track || myMember?.track,
            current_task: myContext?.current_task_id,
            snapshot: myContext?.context_snapshot || {},
            last_saved: myContext?.last_updated,
          };
          teamInfo.my_tasks = myTasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            description: t.description?.substring(0, 150),
          }));
          teamInfo.workflow = getTeamWorkflowInstructions({
            agentId: agent_id,
            teamId,
            channelId: team.channelId,
            taskId: currentTask?.id,
            taskTitle: currentTask?.title,
            role: myRole,
          });
        } else if (!agent_id) {
          // No agent_id — show all contexts summarily
          teamInfo.all_contexts = contexts.map((c) => ({
            agent_id: c.agent_id,
            role: c.role,
            track: c.track,
            current_task: c.current_task_id,
            last_saved: c.last_updated,
          }));
          teamInfo.tasks_summary = {
            total: tasks.length,
            by_status: tasks.reduce((acc, t) => {
              acc[t.status] = (acc[t.status] || 0) + 1;
              return acc;
            }, {} as Record<string, number>),
          };
        }

        activeTeams.push(teamInfo);
      }

      result.active_teams = activeTeams;

      if (activeTeams.length === 0) {
        result._hint = "활성 팀이 없습니다. slack_load_state로 루프 상태를 복원하거나 새 팀을 생성하세요.";
      } else if (agent_id) {
        const foundInTeam = activeTeams.find((t: any) => t.my_context);
        if (foundInTeam) {
          result._hint = `${agent_id}의 컨텍스트를 복구했습니다. workflow 지시사항에 따라 작업을 재개하세요. 태스크 상태가 있으면 slack_team_update_task로 in-progress 표시 후 작업 시작.`;
        } else {
          result._hint = `${agent_id}가 활성 팀에 등록되어 있지 않습니다. slack_team_register로 합류하거나 team_id를 확인하세요.`;
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

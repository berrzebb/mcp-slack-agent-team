/**
 * State persistence: SQLite-backed team registry management.
 * Replaces the old state.json approach — all state now lives in WAL-mode SQLite
 * for safe multi-process concurrency.
 */

import { readFileSync, existsSync, renameSync } from "fs";
import { resolve } from "path";
import { SLACK_DEFAULT_CHANNEL, ROLE_ICONS, ROLE_SLACK_EMOJI, AGENT_PERSONAS, STATE_DIR } from "./types.js";
import { dbSaveTeam, dbLoadAllTeams, dbLoadTeam, dbSaveAllTeams, dbSaveLoopState, dbLoadLoopState } from "./db.js";
import type { LoopState, PersistentState, Team, TeamMember } from "./types.js";

// ── In-Memory Team Store ───────────────────────────────────────

export const teams = new Map<string, Team>();

// ── SQLite-backed State I/O ────────────────────────────────────

/**
 * Load state from SQLite (loop state + teams summary).
 * Returns a PersistentState-shaped object for backward compatibility.
 */
export function loadState(): PersistentState | null {
  const loop = dbLoadLoopState();
  const dbTeams = dbLoadAllTeams();
  if (!loop && dbTeams.length === 0) return null;

  const teamsObj: PersistentState["teams"] = {};
  for (const { team, members } of dbTeams) {
    const membersObj: Record<string, TeamMember> = {};
    for (const m of members) {
      membersObj[m.member_id] = {
        role: m.role,
        agentType: m.agent_type,
        track: m.track || undefined,
        status: m.status as TeamMember["status"],
        joinedAt: m.joined_at,
      };
    }
    teamsObj[team.id] = {
      id: team.id,
      name: team.name,
      channelId: team.channel_id,
      channelName: team.channel_name,
      status: team.status,
      members: membersObj,
      createdAt: team.created_at,
    };
  }

  return {
    loop: loop || undefined,
    teams: teamsObj,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Save partial state to SQLite.
 * - loop → kv_store via dbSaveLoopState
 * - teams → handled by saveTeamsToState (separate call)
 */
export function saveState(state: Partial<PersistentState>): void {
  try {
    if (state.loop) {
      dbSaveLoopState(state.loop);
    }
    // teams are saved via saveTeamsToState() — no double-write needed
  } catch (err) {
    console.error("State save failed:", err);
  }
}

export function saveTeamsToState(): void {
  const teamList: Array<{
    team: { id: string; name: string; channelId: string; channelName: string; status: string; createdAt: string };
    members: Array<{ id: string } & TeamMember>;
  }> = [];

  for (const [, team] of teams) {
    const members: Array<{ id: string } & TeamMember> = [];
    for (const [mid, m] of team.members) {
      members.push({ id: mid, ...m });
    }
    teamList.push({
      team: {
        id: team.id,
        name: team.name,
        channelId: team.channelId,
        channelName: team.channelName,
        status: team.status,
        createdAt: team.createdAt,
      },
      members,
    });
  }

  try {
    dbSaveAllTeams(teamList);
  } catch (err) {
    console.error("Teams save failed:", err);
  }
}

/**
 * Save a SINGLE team to SQLite by ID.
 * Race-condition-safe: only touches the specified team's rows,
 * won't overwrite members added by other processes to other teams.
 * Prefer this over saveTeamsToState() after modifying a single team.
 */
export function saveTeamById(teamId: string): void {
  const team = teams.get(teamId);
  if (!team) return;

  const members: Array<{ id: string } & TeamMember> = [];
  for (const [mid, m] of team.members) {
    members.push({ id: mid, ...m });
  }

  try {
    dbSaveTeam(
      {
        id: team.id,
        name: team.name,
        channelId: team.channelId,
        channelName: team.channelName,
        status: team.status,
        createdAt: team.createdAt,
      },
      members,
    );
  } catch (err) {
    console.error(`Team '${teamId}' save failed:`, err);
  }
}

/**
 * Ensure all non-archived teams are loaded from SQLite into memory.
 * Safe to call frequently — skips teams already in memory to preserve
 * in-flight modifications. Adds NEW teams created by other processes.
 * Also refreshes members for existing teams (other processes may have registered new members).
 */
export function ensureTeamsLoaded(): void {
  const dbTeams = dbLoadAllTeams();
  for (const { team: t, members } of dbTeams) {
    if (t.status === "archived") continue;
    const existing = teams.get(t.id);
    if (existing) {
      // Merge new members from SQLite that aren't in memory yet
      for (const m of members) {
        if (!existing.members.has(m.member_id)) {
          existing.members.set(m.member_id, {
            role: m.role,
            agentType: m.agent_type,
            track: m.track || undefined,
            status: m.status as TeamMember["status"],
            joinedAt: m.joined_at,
          });
        }
      }
      continue;
    }
    const memberMap = new Map<string, TeamMember>();
    for (const m of members) {
      memberMap.set(m.member_id, {
        role: m.role,
        agentType: m.agent_type,
        track: m.track || undefined,
        status: m.status as TeamMember["status"],
        joinedAt: m.joined_at,
      });
    }
    teams.set(t.id, {
      id: t.id,
      name: t.name,
      channelId: t.channel_id,
      channelName: t.channel_name,
      members: memberMap,
      createdAt: t.created_at,
      status: t.status as Team["status"],
    });
  }
}

export function restoreTeamsFromState(): void {
  const dbTeams = dbLoadAllTeams();
  for (const { team: t, members } of dbTeams) {
    if (t.status === "archived") continue;
    const memberMap = new Map<string, TeamMember>();
    for (const m of members) {
      memberMap.set(m.member_id, {
        role: m.role,
        agentType: m.agent_type,
        track: m.track || undefined,
        status: m.status as TeamMember["status"],
        joinedAt: m.joined_at,
      });
    }
    teams.set(t.id, {
      id: t.id,
      name: t.name,
      channelId: t.channel_id,
      channelName: t.channel_name,
      members: memberMap,
      createdAt: t.created_at,
      status: t.status as Team["status"],
    });
  }
  if (teams.size > 0) console.error(`📋 Restored ${teams.size} team(s) from SQLite`);
}

// ── One-Time Migration from state.json ─────────────────────────

const LEGACY_STATE_FILE = resolve(STATE_DIR, "state.json");

export function migrateStateJsonToSqlite(): void {
  if (!existsSync(LEGACY_STATE_FILE)) return;
  try {
    const raw = readFileSync(LEGACY_STATE_FILE, "utf-8");
    const state: PersistentState = JSON.parse(raw);

    // Migrate loop state
    if (state.loop) {
      dbSaveLoopState(state.loop);
    }

    // Migrate teams
    if (state.teams) {
      for (const [id, t] of Object.entries(state.teams)) {
        const members: Array<{ id: string } & TeamMember> = [];
        for (const [mid, m] of Object.entries(t.members)) {
          members.push({ id: mid, ...m });
        }
        dbSaveTeam(
          { id, name: t.name, channelId: t.channelId, channelName: t.channelName, status: t.status, createdAt: t.createdAt },
          members,
        );
      }
    }

    // Rename old file so migration doesn't repeat
    const backupPath = resolve(STATE_DIR, "state.json.migrated");
    try {
      renameSync(LEGACY_STATE_FILE, backupPath);
    } catch {
      // If rename fails, just leave it — migration is idempotent
    }

    console.error(`📦 Migrated state.json → SQLite (${Object.keys(state.teams || {}).length} teams)`);
  } catch (err) {
    console.error("⚠️ state.json migration failed (non-fatal):", err);
  }
}

// ── Team Helpers ───────────────────────────────────────────────

export function getTeam(teamId: string): Team {
  let team = teams.get(teamId);
  if (!team) {
    // Team not in memory — re-read from SQLite (another process may have created it)
    const dbResult = dbLoadTeam(teamId);
    if (dbResult) {
      const { team: t, members } = dbResult;
      const memberMap = new Map<string, TeamMember>();
      for (const m of members) {
        memberMap.set(m.member_id, {
          role: m.role,
          agentType: m.agent_type,
          track: m.track || undefined,
          status: m.status as TeamMember["status"],
          joinedAt: m.joined_at,
        });
      }
      team = {
        id: t.id,
        name: t.name,
        channelId: t.channel_id,
        channelName: t.channel_name,
        members: memberMap,
        createdAt: t.created_at,
        status: t.status as Team["status"],
      };
      teams.set(teamId, team);
    }
  }
  if (!team) throw new Error(`팀 '${teamId}'를 찾을 수 없습니다. 등록된 팀: ${[...teams.keys()].join(", ") || "(없음)"}`);
  return team;
}

/**
 * Resolve team_id: if provided, use it. If omitted/empty, auto-detect.
 * - 활성 팀이 1개뿐이면 자동 선택
 * - 0개면 에러, 2개 이상이면 에러 (명시적 지정 필요)
 * - SQLite에서도 로드 시도
 */
export function resolveTeamId(teamId?: string): string {
  if (teamId) return teamId;

  // Always refresh from SQLite to catch teams created by other processes
  ensureTeamsLoaded();

  const active = [...teams.entries()].filter(([, t]) => t.status === "active");
  if (active.length === 1) return active[0][0];
  if (active.length === 0) throw new Error("활성 팀이 없습니다. team_id를 명시하거나 slack_team_create로 팀을 생성하세요.");
  throw new Error(`활성 팀이 ${active.length}개 있습니다. team_id를 명시하세요: ${active.map(([id]) => id).join(", ")}`);
}

export function getRoleIcon(role: string): string {
  if (ROLE_ICONS[role]) return ROLE_ICONS[role];
  for (const [key, icon] of Object.entries(ROLE_ICONS)) {
    if (role.startsWith(key)) return icon;
  }
  return "🤖";
}

export function getRoleSlackEmoji(role: string): string {
  if (ROLE_SLACK_EMOJI[role]) return ROLE_SLACK_EMOJI[role];
  for (const [key, emoji] of Object.entries(ROLE_SLACK_EMOJI)) {
    if (role.startsWith(key)) return emoji;
  }
  return ":robot_face:";
}

/**
 * Returns { username, icon_emoji } for chat.postMessage
 * so each agent appears as a distinct Slack "user" with a persona name.
 * Requires chat:write.customize bot scope.
 *
 * Persona lookup order:
 *   1. AGENT_PERSONAS[member.role]       (exact role match)
 *   2. AGENT_PERSONAS[member.agentType]  (agent_type fallback)
 *   3. AGENT_PERSONAS[senderId]          (id fallback)
 *   4. Generic fallback
 */
export function agentIdentity(senderId: string, member: TeamMember): { username: string; icon_emoji: string } {
  const persona =
    AGENT_PERSONAS[member.role] ||
    AGENT_PERSONAS[member.agentType] ||
    AGENT_PERSONAS[senderId] ||
    null;

  if (persona) {
    const trackSuffix = member.track ? ` [${member.track}]` : "";
    return {
      username: `${persona.displayName}${trackSuffix}`,
      icon_emoji: persona.emoji,
    };
  }

  // Fallback for unknown roles
  const trackSuffix = member.track ? `-${member.track}` : "";
  const username = `${senderId}${trackSuffix}`.replace(/[^a-zA-Z0-9._-]/g, "-");
  return {
    username,
    icon_emoji: getRoleSlackEmoji(member.role),
  };
}

export function formatTeamStatus(team: Team): string {
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

export function teamNameSafe(team: Team): string {
  return team.name.replace(/[*_~`]/g, "");
}

// ── Channel Helper ─────────────────────────────────────────────

export function resolveChannel(channel?: string): string {
  const ch = channel || SLACK_DEFAULT_CHANNEL;
  if (!ch) {
    throw new Error(
      "채널이 지정되지 않았습니다. channel 파라미터를 입력하거나 SLACK_DEFAULT_CHANNEL 환경변수를 설정하세요."
    );
  }
  return ch;
}

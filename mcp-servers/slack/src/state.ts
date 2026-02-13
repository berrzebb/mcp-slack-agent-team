/**
 * State persistence: JSON file + team registry management.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { STATE_FILE, SLACK_DEFAULT_CHANNEL, ROLE_ICONS, ROLE_SLACK_EMOJI, AGENT_PERSONAS } from "./types.js";
import type { LoopState, PersistentState, Team, TeamMember } from "./types.js";

// ── In-Memory Team Store ───────────────────────────────────────

export const teams = new Map<string, Team>();

// ── State File I/O ─────────────────────────────────────────────

export function loadState(): PersistentState | null {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {
    // corrupted state file — ignore
  }
  return null;
}

export function saveState(state: Partial<PersistentState>): void {
  try {
    const existing = loadState() || { teams: {}, updated_at: "" };
    const merged = { ...existing, ...state, updated_at: new Date().toISOString() };
    if (!existsSync(dirname(STATE_FILE))) mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(merged, null, 2));
  } catch (err) {
    console.error("State save failed:", err);
  }
}

export function saveTeamsToState(): void {
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

export function restoreTeamsFromState(): void {
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

// ── Team Helpers ───────────────────────────────────────────────

export function getTeam(teamId: string): Team {
  // Lazy restore: if teams Map is empty, try reloading from state.json
  if (teams.size === 0) {
    restoreTeamsFromState();
  }
  const team = teams.get(teamId);
  if (!team) throw new Error(`팀 '${teamId}'를 찾을 수 없습니다. 등록된 팀: ${[...teams.keys()].join(", ") || "(없음)"}`);
  return team;
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

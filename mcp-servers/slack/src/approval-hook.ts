#!/usr/bin/env node

/**
 * Slack Approval Hook for Claude Code — ALL tool types
 *
 * Works as both PreToolUse AND PermissionRequest hook.
 * Handles ALL tool permission requests, not just Bash.
 *
 * PreToolUse (Bash only, via settings.json matcher):
 *   - Intercepts ALL non-safe Bash commands
 *   - On approve: outputs permissionDecision="allow" (bypasses permission system)
 *   - On deny: outputs permissionDecision="deny" (blocks tool call)
 *
 * PermissionRequest (ALL tools, no matcher restriction):
 *   - Fires when ANY permission dialog is about to show
 *   - Sends approval to Slack, returns decision.behavior="allow"/"deny"
 *
 * Approval methods (checked in parallel):
 *   1. Emoji reaction: :white_check_mark: approve / :x: deny
 *   2. Thread reply: "y", "yes", "ok" / "n", "no", "deny"
 *
 * Timeout: auto-deny after APPROVAL_TIMEOUT seconds
 */

import { WebClient } from "@slack/web-api";

// -- Configuration --

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_DEFAULT_CHANNEL = process.env.SLACK_DEFAULT_CHANNEL;
const APPROVAL_TIMEOUT = parseInt(process.env.SLACK_APPROVAL_TIMEOUT || "120", 10);
const POLL_INTERVAL = 3000;

if (!SLACK_BOT_TOKEN || !SLACK_DEFAULT_CHANNEL) {
  console.error("[approval-hook] Missing SLACK_BOT_TOKEN or SLACK_DEFAULT_CHANNEL — cannot route to Slack");
  // Without Slack credentials, we can't route approvals.
  // Exit 0 = no decision = CLI will handle it (acceptable for initial setup only)
  process.exit(0);
}

const slack = new WebClient(SLACK_BOT_TOKEN);
const CH: string = SLACK_DEFAULT_CHANNEL;

let BOT_USER_ID = "";

// -- Dangerous command patterns (shown with :rotating_light: indicator) --

const DANGEROUS_PATTERNS = [
  /^git\s+push/,
  /^git\s+checkout/,
  /^git\s+reset/,
  /^git\s+rebase/,
  /^git\s+merge/,
  /^podman\s+stop/,
  /^podman\s+rm/,
  /^podman\s+restart/,
  /^docker\s+stop/,
  /^docker\s+restart/,
  /^rm\s+/,
  /^del\s+/,
  /^taskkill\s+/,
  /^Stop-Process\s/i,
  /^shutdown\s/,
  /^reboot/,
  /^format\s+/,
];

// -- Blacklist-only approach --
// Everything NOT in DANGEROUS_PATTERNS is auto-allowed.
// No whitelist needed — only dangerous commands require Slack approval.


const APPROVE_REACTIONS = ["white_check_mark", "+1", "thumbsup", "heavy_check_mark"];
const DENY_REACTIONS = ["x", "-1", "thumbsdown", "no_entry_sign", "octagonal_sign"];
const APPROVE_WORDS = ["y", "yes", "ok", "approve", "ㅇ", "ㅇㅇ", "허용", "승인"];
const DENY_WORDS = ["n", "no", "deny", "reject", "ㄴ", "ㄴㄴ", "거부", "거절"];

// -- Command chain detection --
// Quote-aware splitting to avoid false positives (e.g. `git commit -m "fix; cleanup"`).
// Also detects pipe-to-shell attacks and env-var prefixed commands.

/**
 * Quote-aware split by chain operators (&&, ||, ;).
 * Respects single/double quotes and backslash escapes.
 */
function splitByChainOps(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Backslash escape (not inside single quotes)
    if (ch === "\\" && !inSingle && i + 1 < input.length) {
      current += ch + input[i + 1];
      i += 2;
      continue;
    }

    // Quote toggling
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; i++; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; i++; continue; }

    // Outside quotes: check for chain operators
    if (!inSingle && !inDouble) {
      if (ch === ";") {
        parts.push(current); current = ""; i++; continue;
      }
      if (ch === "&" && input[i + 1] === "&") {
        parts.push(current); current = ""; i += 2; continue;
      }
      if (ch === "|" && input[i + 1] === "|") {
        parts.push(current); current = ""; i += 2; continue;
      }
    }

    current += ch;
    i++;
  }

  if (current) parts.push(current);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * Quote-aware split by single pipe | (not ||).
 * Used for safe-checking: ALL pipe segments must be safe.
 */
function splitByPipe(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === "\\" && !inSingle && i + 1 < input.length) {
      current += ch + input[i + 1]; i += 2; continue;
    }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; i++; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; i++; continue; }

    if (!inSingle && !inDouble) {
      // Skip || (chain operator, not pipe)
      if (ch === "|" && input[i + 1] === "|") {
        current += "||"; i += 2; continue;
      }
      // Single pipe
      if (ch === "|") {
        parts.push(current); current = ""; i++; continue;
      }
    }

    current += ch;
    i++;
  }

  if (current) parts.push(current);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Split a compound/multi-line command into sub-commands (chains only, no pipes) */
function splitCommandChains(cmd: string): string[] {
  const parts: string[] = [];
  for (const line of cmd.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    parts.push(...splitByChainOps(trimmed));
  }
  return parts;
}

/** Split into ALL independent segments: chains + pipes + newlines */
function splitAllSegments(cmd: string): string[] {
  const parts: string[] = [];
  for (const chainPart of splitCommandChains(cmd)) {
    parts.push(...splitByPipe(chainPart));
  }
  return parts;
}

/** Strip leading env-var assignments: `RUST_LOG=info cargo test` → `cargo test` */
function stripEnvVarPrefix(cmd: string): string {
  return cmd.replace(/^(\w+=\S*\s+)+/, "");
}

/** Detect pipe to shell interpreter: `| sh`, `| bash`, `| node -e`, etc. */
const PIPE_TO_SHELL = /\|\s*(sh|bash|zsh|dash|pwsh|powershell|node\s+-e|python[3]?\s+-c)\b/;

function containsPipeToShell(cmd: string): boolean {
  return PIPE_TO_SHELL.test(cmd);
}

/** Check for dangerous commands hidden inside $() or backtick substitutions */
function containsDangerousSubstitution(cmd: string): boolean {
  const subPatterns = [
    /\$\(([^)]+)\)/g,   // $(dangerous_cmd)
    /`([^`]+)`/g,        // `dangerous_cmd`
  ];
  for (const re of subPatterns) {
    let match;
    while ((match = re.exec(cmd)) !== null) {
      const inner = match[1].trim();
      if (DANGEROUS_PATTERNS.some((p) => p.test(inner))) return true;
      const innerParts = splitCommandChains(inner);
      if (innerParts.some((part) => DANGEROUS_PATTERNS.some((p) => p.test(part)))) return true;
    }
  }
  return false;
}

/** Check if a full command (possibly chained) contains any dangerous sub-command */
function isCommandDangerous(cmd: string): boolean {
  const parts = splitCommandChains(cmd);
  for (const part of parts) {
    if (DANGEROUS_PATTERNS.some((p) => p.test(part))) return true;
  }
  if (containsDangerousSubstitution(cmd)) return true;
  if (containsPipeToShell(cmd)) return true;
  return false;
}

/** Check if a full command (possibly chained) is NOT dangerous → safe to auto-allow */
function isCommandSafe(cmd: string): boolean {
  return !isCommandDangerous(cmd);
}

// -- Main --

/** Output JSON decision for PreToolUse hook and exit */
function outputPreToolUseDecision(
  decision: "allow" | "deny" | "ask",
  reason: string,
): never {
  const json = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
  process.stdout.write(json);
  process.exit(0);
}

/** Output JSON decision for PermissionRequest hook and exit */
function outputPermissionRequestDecision(
  behavior: "allow" | "deny",
  message?: string,
): never {
  const json = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior,
        ...(behavior === "deny" && message ? { message } : {}),
      },
    },
  });
  process.stdout.write(json);
  process.exit(0);
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let toolInfo: {
    hook_event_name?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
  };
  try {
    toolInfo = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const hookEvent = toolInfo.hook_event_name || "PreToolUse";
  const toolName = toolInfo.tool_name || "";
  const toolInput = toolInfo.tool_input || {};
  const isBash = toolName === "Bash" || toolName === "bash";
  const command = isBash ? String(toolInput.command || "") : "";

  // ────────────────────────────────────────────────────────────
  // PreToolUse vs PermissionRequest: different strategies
  //
  // PreToolUse (fires for ALL Bash commands):
  //   - DANGEROUS → send to Slack immediately (don't wait for permission system)
  //   - Otherwise  → exit(0) = no decision → let permission system decide
  //     • If command is in settings.json "allow" → auto-approved
  //     • If command is in "ask" → triggers PermissionRequest hook
  //
  // PermissionRequest (fires only when permission dialog would show):
  //   - SAFE tools/patterns → auto-allow
  //   - Everything else → send to Slack for approval
  // ────────────────────────────────────────────────────────────

  const isDangerous = isBash && isCommandDangerous(command);

  // -- PreToolUse: blacklist-only — block dangerous, allow everything else --
  if (hookEvent === "PreToolUse") {
    if (!isBash) {
      process.exit(0); // Non-bash → let permission system decide
    }
    if (!isDangerous) {
      outputPreToolUseDecision("allow", "Not dangerous — auto-approved");
    }
    // DANGEROUS falls through to Slack approval below
  }

  // -- PermissionRequest: blacklist-only — block dangerous, allow everything else --
  if (hookEvent === "PermissionRequest") {
    if (!isBash) {
      // All non-Bash tools → auto-allow (MCP tools, Read, Grep, etc.)
      outputPermissionRequestDecision("allow");
    }
    if (!isDangerous) {
      outputPermissionRequestDecision("allow");
    }
    // DANGEROUS falls through to Slack approval below
  }

  // Resolve bot user ID
  try {
    const auth = await slack.auth.test();
    BOT_USER_ID = auth.user_id || "";
  } catch (err) {
    // Can't reach Slack — deny by default instead of allowing through CLI
    console.error(`[approval-hook] Slack auth failed: ${err}`);
    if (hookEvent === "PermissionRequest") {
      outputPermissionRequestDecision("deny", "Slack 연결 실패 — 승인할 수 없습니다. Slack 서버 상태를 확인하세요.");
    }
    outputPreToolUseDecision("deny", "Slack 연결 실패 — 수동 승인 불가");
  }

  // -- Build approval message --

  const severity = isDangerous
    ? ":rotating_light: *DANGEROUS*"
    : ":warning: *Approval Required*";

  const detail = isBash
    ? "```" + (command.length > 500 ? command.slice(0, 500) + "..." : command) + "```"
    : formatToolInput(toolName, toolInput);

  try {
    const msg = await slack.chat.postMessage({
      channel: CH,
      text: [
        severity + (isBash ? "" : " — `" + toolName + "`"),
        "",
        detail,
        "",
        ":white_check_mark: react to approve  |  :x: react to deny",
        "(or reply *y* / *n* in thread)",
        "",
        ":hourglass_flowing_sand: auto-deny in " + APPROVAL_TIMEOUT + "s",
      ].join("\n"),
      mrkdwn: true,
    });

    const ts = msg.ts!;
    await slack.reactions.add({ channel: CH, name: "hourglass_flowing_sand", timestamp: ts });

    // -- Poll for reaction OR thread reply --

    const deadline = Date.now() + APPROVAL_TIMEOUT * 1000;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL);

      const decision = await checkReactions(ts);
      if (decision) {
        const approved = decision === "approve";
        await respond(ts, approved ? ":white_check_mark: Approved (reaction)" : ":x: Denied (reaction)");
        outputDecision(hookEvent, approved, `${approved ? "Approved" : "Denied"} via Slack reaction`);
      }

      const replyDecision = await checkThreadReplies(ts);
      if (replyDecision) {
        const approved = replyDecision === "approve";
        await respond(ts, approved ? ":white_check_mark: Approved (reply)" : ":x: Denied (reply)");
        outputDecision(hookEvent, approved, `${approved ? "Approved" : "Denied"} via Slack reply`);
      }
    }

    // Timeout
    await respond(ts, ":alarm_clock: Timeout (" + APPROVAL_TIMEOUT + "s) - auto denied");
    outputDecision(hookEvent, false, "Approval timeout — auto denied after " + APPROVAL_TIMEOUT + "s");
  } catch (err) {
    console.error("[approval-hook] Slack approval error:", err);
    // On error, deny instead of falling through to CLI
    if (hookEvent === "PermissionRequest") {
      outputPermissionRequestDecision("deny", "Slack 승인 요청 실패 — 작업이 거부되었습니다.");
    }
    outputPreToolUseDecision("deny", "Slack approval hook failed — denied for safety");
  }
}

async function checkReactions(ts: string): Promise<"approve" | "deny" | null> {
  try {
    const result = await slack.reactions.get({ channel: CH, timestamp: ts, full: true });
    const reactions = (result.message as { reactions?: Array<{ name: string; users?: string[] }> })?.reactions || [];

    let hasApprove = false;
    for (const r of reactions) {
      // Skip reactions added only by the bot itself
      const nonBotUsers = (r.users || []).filter((u) => u !== BOT_USER_ID);
      if (nonBotUsers.length === 0) continue;

      // Deny takes priority over approve for safety
      if (DENY_REACTIONS.includes(r.name)) return "deny";
      if (APPROVE_REACTIONS.includes(r.name)) hasApprove = true;
    }
    if (hasApprove) return "approve";
  } catch {
    // reactions.get failed, skip
  }
  return null;
}

async function checkThreadReplies(ts: string): Promise<"approve" | "deny" | null> {
  try {
    const replies = await slack.conversations.replies({ channel: CH, ts, limit: 10 });
    const messages = replies.messages || [];

    // Latest reply takes priority — iterate from newest to oldest
    for (const m of messages.slice(1).reverse()) {
      if (m.user === BOT_USER_ID) continue;
      const text = (m.text || "").trim().toLowerCase();
      if (APPROVE_WORDS.includes(text)) return "approve";
      if (DENY_WORDS.includes(text)) return "deny";
    }
  } catch {
    // replies failed, skip
  }
  return null;
}

async function respond(threadTs: string, text: string): Promise<void> {
  try {
    // Remove hourglass
    await slack.reactions.remove({ channel: CH, name: "hourglass_flowing_sand", timestamp: threadTs }).catch(() => {});
    await slack.chat.postMessage({ channel: CH, text, thread_ts: threadTs });
  } catch {
    // best effort
  }
}

// -- Helpers --

/** Unified decision output — routes to correct JSON format based on hook event */
function outputDecision(hookEvent: string, approved: boolean, reason: string): never {
  if (hookEvent === "PermissionRequest") {
    outputPermissionRequestDecision(approved ? "allow" : "deny", approved ? undefined : reason);
  }
  outputPreToolUseDecision(approved ? "allow" : "deny", reason);
}

/** Format non-Bash tool input into a readable Slack message */
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  const lines: string[] = [];

  // Well-known tool fields
  if (input.file_path) lines.push(`*File:* \`${input.file_path}\``);
  if (input.url) lines.push(`*URL:* ${input.url}`);
  if (input.query) lines.push(`*Query:* ${input.query}`);
  if (input.pattern) lines.push(`*Pattern:* \`${input.pattern}\``);
  if (input.prompt) lines.push(`*Prompt:* ${String(input.prompt).slice(0, 200)}...`);
  if (input.description) lines.push(`*Desc:* ${input.description}`);

  // For content/old_string/new_string show truncated preview
  if (input.content) {
    const c = String(input.content);
    lines.push("*Content:*\n```" + (c.length > 300 ? c.slice(0, 300) + "..." : c) + "```");
  }
  if (input.old_string) {
    const o = String(input.old_string);
    lines.push("*Replace:*\n```" + (o.length > 200 ? o.slice(0, 200) + "..." : o) + "```");
  }

  // Fallback: dump keys if nothing matched above
  if (lines.length === 0) {
    const summary = JSON.stringify(input, null, 2);
    lines.push("```" + (summary.length > 500 ? summary.slice(0, 500) + "..." : summary) + "```");
  }

  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();

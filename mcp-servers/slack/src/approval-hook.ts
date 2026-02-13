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
  /^rm\s+/,
  /^del\s+/,
  /^taskkill\s+/,
];

// -- Commands that are always safe (skip Slack approval entirely) --
// These match the allow-list in settings.json — no need to ask
const SAFE_PATTERNS = [
  /^cargo\s+/,
  /^npm\s+/,
  /^npx\s+/,
  /^git\s+status/,
  /^git\s+diff/,
  /^git\s+log/,
  /^git\s+branch/,
  /^git\s+stash/,
  /^git\s+add/,
  /^git\s+commit/,
  /^echo\s+/,
  /^cat\s+/,
  /^head\s+/,
  /^tail\s+/,
  /^ls\s+/,
  /^dir\s+/,
  /^cd\s+/,
  /^curl\s+/,
  /^grep\s+/,
  /^find\s+/,
  /^wc\s+/,
  /^sort\s+/,
  /^tree\s+/,
  /^mkdir\s+/,
];

const APPROVE_REACTIONS = ["white_check_mark", "+1", "thumbsup", "heavy_check_mark"];
const DENY_REACTIONS = ["x", "-1", "thumbsdown", "no_entry_sign", "octagonal_sign"];
const APPROVE_WORDS = ["y", "yes", "ok", "approve", "ㅇ", "ㅇㅇ", "허용", "승인"];
const DENY_WORDS = ["n", "no", "deny", "reject", "ㄴ", "ㄴㄴ", "거부", "거절"];

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

  // -- Bash-specific: safe command bypass --
  if (isBash) {
    const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
    if (isSafe) {
      if (hookEvent === "PermissionRequest") {
        outputPermissionRequestDecision("allow");
      }
      process.exit(0);
    }
  }

  const isDangerous = isBash && DANGEROUS_PATTERNS.some((p) => p.test(command));

  // Resolve bot user ID
  try {
    const auth = await slack.auth.test();
    BOT_USER_ID = auth.user_id || "";
  } catch {
    // Can't reach Slack — fall back to normal permission dialog
    process.exit(0);
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
    console.error("Slack approval error:", err);
    // On error, fall through to normal permission system
    if (hookEvent === "PermissionRequest") {
      process.exit(0);
    }
    outputPreToolUseDecision("ask", "Slack approval failed — please approve manually");
  }
}

async function checkReactions(ts: string): Promise<"approve" | "deny" | null> {
  try {
    const result = await slack.reactions.get({ channel: CH, timestamp: ts, full: true });
    const reactions = (result.message as { reactions?: Array<{ name: string; users?: string[] }> })?.reactions || [];

    for (const r of reactions) {
      // Skip reactions added only by the bot itself
      const nonBotUsers = (r.users || []).filter((u) => u !== BOT_USER_ID);
      if (nonBotUsers.length === 0) continue;

      if (APPROVE_REACTIONS.includes(r.name)) return "approve";
      if (DENY_REACTIONS.includes(r.name)) return "deny";
    }
  } catch {
    // reactions.get failed, skip
  }
  return null;
}

async function checkThreadReplies(ts: string): Promise<"approve" | "deny" | null> {
  try {
    const replies = await slack.conversations.replies({ channel: CH, ts, limit: 10 });
    const messages = replies.messages || [];

    for (const m of messages.slice(1)) {
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

#!/usr/bin/env node

/**
 * Slack Approval Hook for Claude Code
 *
 * PreToolUse hook - intercepts dangerous commands,
 * sends approval request to Slack, polls for user response.
 *
 * Two approval methods (checked in parallel):
 *   1. Emoji reaction on the message:
 *      - white_check_mark / +1 / thumbsup -> approve
 *      - x / -1 / thumbsdown -> deny
 *   2. Thread reply (fallback):
 *      - "y", "yes", "ok", "approve" -> approve
 *      - "n", "no", "deny", "reject" -> deny
 *
 * Timeout: auto-deny after APPROVAL_TIMEOUT seconds -> exit 2
 *
 * Receives tool use info as JSON on stdin from Claude Code.
 * Requires scopes: chat:write, reactions:write, reactions:read, channels:history
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

// -- Dangerous command patterns --

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

const APPROVE_REACTIONS = ["white_check_mark", "+1", "thumbsup", "heavy_check_mark"];
const DENY_REACTIONS = ["x", "-1", "thumbsdown", "no_entry_sign", "octagonal_sign"];
const APPROVE_WORDS = ["y", "yes", "ok", "approve", "ㅇ", "ㅇㅇ", "허용", "승인"];
const DENY_WORDS = ["n", "no", "deny", "reject", "ㄴ", "ㄴㄴ", "거부", "거절"];

// -- Main --

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let toolInfo: { tool_name?: string; tool_input?: { command?: string } };
  try {
    toolInfo = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const toolName = toolInfo.tool_name || "";
  const command = toolInfo.tool_input?.command || "";

  if (toolName !== "Bash" && toolName !== "bash") {
    process.exit(0);
  }

  const isDangerous = DANGEROUS_PATTERNS.some((p) => p.test(command));
  if (!isDangerous) {
    process.exit(0);
  }

  // Resolve bot user ID
  try {
    const auth = await slack.auth.test();
    BOT_USER_ID = auth.user_id || "";
  } catch {
    // proceed anyway
  }

  // -- Send approval request --

  const truncatedCmd = command.length > 500 ? command.slice(0, 500) + "..." : command;

  try {
    const msg = await slack.chat.postMessage({
      channel: CH,
      text: [
        ":warning: *Approval Required*",
        "",
        "```" + truncatedCmd + "```",
        "",
        ":white_check_mark: react to approve  |  :x: react to deny",
        "(or reply *y* / *n* in thread)",
        "",
        ":hourglass_flowing_sand: auto-deny in " + APPROVAL_TIMEOUT + "s",
      ].join("\n"),
      mrkdwn: true,
    });

    const ts = msg.ts!;

    // Add waiting indicator
    await slack.reactions.add({ channel: CH, name: "hourglass_flowing_sand", timestamp: ts });

    // -- Poll for reaction OR thread reply --

    const deadline = Date.now() + APPROVAL_TIMEOUT * 1000;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL);

      // Check reactions
      const decision = await checkReactions(ts);
      if (decision === "approve") {
        await respond(ts, ":white_check_mark: Approved (reaction)");
        process.exit(0);
      }
      if (decision === "deny") {
        await respond(ts, ":x: Denied (reaction)");
        process.exit(2);
      }

      // Check thread replies
      const replyDecision = await checkThreadReplies(ts);
      if (replyDecision === "approve") {
        await respond(ts, ":white_check_mark: Approved (reply)");
        process.exit(0);
      }
      if (replyDecision === "deny") {
        await respond(ts, ":x: Denied (reply)");
        process.exit(2);
      }
    }

    // Timeout
    await respond(ts, ":alarm_clock: Timeout (" + APPROVAL_TIMEOUT + "s) - auto denied");
    process.exit(2);
  } catch (err) {
    console.error("Slack approval error:", err);
    process.exit(2);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();

#!/usr/bin/env node

/**
 * Slack MCP Server — Entry Point
 *
 * Claude Code ↔ User 간 Slack 기반 커뮤니케이션을 위한 MCP 서버.
 * 모든 도구는 tools/ 하위 모듈에서 등록됩니다.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveBotUserId, getBotUserId } from "./slack-client.js";
import { restoreTeamsFromState, saveTeamsToState, saveState } from "./state.js";
import { startBackgroundPoller, stopBackgroundPoller } from "./background-poller.js";

// Tool registrations
import { registerBasicTools } from "./tools/basic.js";
import { registerContentTools } from "./tools/content.js";
import { registerLoopTools } from "./tools/loop.js";
import { registerTeamTools } from "./tools/team.js";
import { registerApprovalTools } from "./tools/approval.js";
import { registerFileTools } from "./tools/file.js";
import { registerStateTools } from "./tools/state.js";
import { registerContextTools } from "./tools/context.js";
import { registerDashboardTools } from "./tools/dashboard.js";

// ── Server ─────────────────────────────────────────────────────

const server = new McpServer({
  name: "slack-mcp-server",
  version: "2.0.0",
}, {
  capabilities: { tools: {} },
});

// ── Register all tools ─────────────────────────────────────────

registerBasicTools(server);
registerContentTools(server);
registerLoopTools(server);
registerTeamTools(server);
registerApprovalTools(server);
registerFileTools(server);
registerStateTools(server);
registerContextTools(server);
registerDashboardTools(server);

// ── Start ──────────────────────────────────────────────────────

async function main() {
  await resolveBotUserId();
  const botId = getBotUserId();
  if (botId) {
    console.error(`🤖 Slack Bot connected (user: ${botId})`);
  }

  restoreTeamsFromState();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🚀 Slack MCP Server running on stdio");

  // Start background message collector (runs independently of tool calls)
  startBackgroundPoller();

  // ── Graceful Shutdown ────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.error(`\n⚡ ${signal} received — graceful shutdown...`);

    // Stop background poller
    stopBackgroundPoller();

    // Save team state
    try {
      saveTeamsToState();
      saveState({ updated_at: new Date().toISOString() } as any);
      console.error("💾 State saved successfully");
    } catch (err) {
      console.error("⚠️ State save failed:", err);
    }

    // Send shutdown notification to Slack (best effort)
    try {
      const { SLACK_DEFAULT_CHANNEL } = await import("./types.js");
      if (SLACK_DEFAULT_CHANNEL) {
        const { slack } = await import("./slack-client.js");
        await slack.chat.postMessage({
          channel: SLACK_DEFAULT_CHANNEL,
          text: `🔄 *MCP 서버 재시작 중* (${signal})... 잠시 후 복귀합니다.`,
          mrkdwn: true,
        });
      }
    } catch {
      // Best effort — don't block shutdown
    }

    console.error("👋 Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

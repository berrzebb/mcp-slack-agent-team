#!/usr/bin/env node

/**
 * MCP Server Auto-Restart Wrapper
 *
 * Claude Code ←stdio→ wrapper ←pipe→ index.js
 *
 * - exit code 42 (slack_reload): 즉시 재시작
 * - 비정상 종료 (crash): 백오프 후 자동 재시작 (최대 MAX_CRASH_RESTARTS회)
 * - 정상 종료 (code 0): wrapper도 함께 종료
 * - 연속 크래시가 CRASH_WINDOW_MS 내에 MAX_CRASH_RESTARTS회 초과 시 wrapper 종료
 */

import { spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.join(__dirname, "index.js");
const RELOAD_EXIT_CODE = 42;

// Crash restart policy
const MAX_CRASH_RESTARTS = 5;          // max restarts within window
const CRASH_WINDOW_MS = 5 * 60_000;   // 5 minute window
const INITIAL_BACKOFF_MS = 1_000;      // 1s → 2s → 4s → 8s → 16s
const MAX_BACKOFF_MS = 30_000;         // cap at 30s

let child: ChildProcess | null = null;
let stdinForwarder: ((chunk: Buffer) => void) | null = null;

// Track crash timestamps for sliding window
const crashTimestamps: number[] = [];
let consecutiveCrashes = 0;

function startServer(): void {
  child = spawn(process.execPath, [SERVER_SCRIPT], {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
    cwd: path.resolve(__dirname, ".."),
  });

  // Forward: Claude Code stdin → child stdin
  stdinForwarder = (chunk: Buffer) => {
    if (child?.stdin?.writable) {
      child.stdin.write(chunk);
    }
  };
  process.stdin.on("data", stdinForwarder);

  // Forward: child stdout → Claude Code stdout
  child.stdout!.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
  });

  child.on("exit", (code) => {
    // Clean up old stdin forwarder
    if (stdinForwarder) {
      process.stdin.removeListener("data", stdinForwarder);
      stdinForwarder = null;
    }

    if (code === RELOAD_EXIT_CODE) {
      // Intentional reload — instant restart, reset crash counter
      console.error("🔄 MCP server reloading...");
      consecutiveCrashes = 0;
      startServer();
      return;
    }

    if (code === 0) {
      // Clean exit — wrapper also exits
      console.error("✅ MCP server exited cleanly");
      process.exit(0);
      return;
    }

    // Crash — check if we should restart
    const now = Date.now();
    crashTimestamps.push(now);
    consecutiveCrashes++;

    // Prune timestamps outside the sliding window
    while (crashTimestamps.length > 0 && crashTimestamps[0] < now - CRASH_WINDOW_MS) {
      crashTimestamps.shift();
    }

    if (crashTimestamps.length > MAX_CRASH_RESTARTS) {
      console.error(`⛔ MCP server crashed ${crashTimestamps.length} times in ${CRASH_WINDOW_MS / 1000}s — giving up`);
      process.exit(code ?? 1);
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
    const backoff = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, consecutiveCrashes - 1), MAX_BACKOFF_MS);
    console.error(`💥 MCP server crashed (exit ${code ?? "null"}) — restarting in ${backoff}ms (attempt ${crashTimestamps.length}/${MAX_CRASH_RESTARTS})`);

    setTimeout(() => {
      startServer();
    }, backoff);
  });

  child.on("error", (err) => {
    console.error("❌ Server process error:", err.message);
    // Treat spawn errors as crashes too
    const now = Date.now();
    crashTimestamps.push(now);
    consecutiveCrashes++;

    while (crashTimestamps.length > 0 && crashTimestamps[0] < now - CRASH_WINDOW_MS) {
      crashTimestamps.shift();
    }

    if (crashTimestamps.length > MAX_CRASH_RESTARTS) {
      process.exit(1);
      return;
    }

    const backoff = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, consecutiveCrashes - 1), MAX_BACKOFF_MS);
    console.error(`🔄 Retrying in ${backoff}ms...`);
    setTimeout(() => startServer(), backoff);
  });
}

// Forward signals to child
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    child?.kill(sig);
  });
}

// Keep wrapper alive even if stdin ends
process.stdin.resume();

startServer();

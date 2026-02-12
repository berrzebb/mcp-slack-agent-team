#!/usr/bin/env node

/**
 * MCP Server Auto-Restart Wrapper
 *
 * Claude Code ←stdio→ wrapper ←pipe→ index.js
 *
 * index.js가 exit code 42로 종료하면 (slack_reload 호출 시),
 * wrapper가 새 child를 spawn하여 Claude Code와의 연결을 유지합니다.
 * 다른 exit code는 wrapper도 함께 종료합니다.
 */

import { spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.join(__dirname, "index.js");
const RELOAD_EXIT_CODE = 42;

let child: ChildProcess | null = null;
let stdinForwarder: ((chunk: Buffer) => void) | null = null;

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
      console.error("🔄 MCP server reloading...");
      startServer();
    } else {
      console.error(`⛔ MCP server exited with code ${code ?? "null"}`);
      process.exit(code ?? 1);
    }
  });

  child.on("error", (err) => {
    console.error("❌ Server process error:", err.message);
    process.exit(1);
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

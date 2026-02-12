/**
 * Slack WebClient initialization + smart message sending utilities.
 */

import { WebClient } from "@slack/web-api";
import { SLACK_BOT_TOKEN, SLACK_MSG_LIMIT, SLACK_FILE_THRESHOLD } from "./types.js";

// ── Client Initialization ──────────────────────────────────────

if (!SLACK_BOT_TOKEN) {
  console.error("❌ SLACK_BOT_TOKEN environment variable is required");
  process.exit(1);
}

export const slack = new WebClient(SLACK_BOT_TOKEN, {
  headers: {
    "User-Agent": "slack-mcp-server/1.0.0",
  },
});

// Bot user ID (resolved on startup)
let botUserId: string | undefined;

export async function resolveBotUserId(): Promise<string> {
  if (botUserId) return botUserId;
  try {
    const auth = await slack.auth.test();
    botUserId = auth.user_id as string;
    return botUserId;
  } catch {
    return "";
  }
}

export function getBotUserId(): string | undefined {
  return botUserId;
}

// ── Smart Message Sending ──────────────────────────────────────

/**
 * 긴 메시지를 자동으로 처리:
 * - 3900자 이하: 그대로 전송
 * - 3900~8000자: 여러 메시지로 분할 전송
 * - 8000자 초과: 파일로 업로드
 */
export async function sendSmart(
  channel: string,
  text: string,
  options?: { thread_ts?: string; title?: string; filename?: string }
): Promise<{ ts: string; method: "message" | "chunked" | "file"; chunks?: number }> {
  const len = text.length;

  if (len <= SLACK_MSG_LIMIT) {
    const result = await slack.chat.postMessage({
      channel,
      text,
      thread_ts: options?.thread_ts,
      mrkdwn: true,
    });
    return { ts: result.ts || "", method: "message" };
  }

  if (len <= SLACK_FILE_THRESHOLD) {
    const chunks = splitMessage(text, SLACK_MSG_LIMIT);
    let firstTs = "";
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `_(${i + 1}/${chunks.length})_\n` : "";
      const result = await slack.chat.postMessage({
        channel,
        text: prefix + chunks[i],
        thread_ts: i === 0 ? options?.thread_ts : (firstTs || options?.thread_ts),
        mrkdwn: true,
      });
      if (i === 0) firstTs = result.ts || "";
    }
    return { ts: firstTs, method: "chunked", chunks: chunks.length };
  }

  const filename = options?.filename || `output-${Date.now()}.txt`;
  const title = options?.title || "📄 출력 결과";
  const uploadResult = await uploadContent(channel, text, {
    filename,
    title,
    thread_ts: options?.thread_ts,
  });
  return { ts: uploadResult.ts, method: "file" };
}

export function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    if (line.length > maxLen) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += maxLen) {
        chunks.push(line.slice(i, i + maxLen));
      }
      continue;
    }

    if (current.length + line.length + 1 > maxLen) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function uploadContent(
  channel: string,
  content: string,
  options: { filename: string; title: string; thread_ts?: string; filetype?: string }
): Promise<{ ts: string; fileId: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any = {
    channel_id: channel,
    content,
    filename: options.filename,
    title: options.title,
  };
  if (options.thread_ts) args.thread_ts = options.thread_ts;
  if (options.filetype) args.snippet_type = options.filetype;

  const result = await slack.filesUploadV2(args);

  const file = (result as { files?: Array<{ id?: string }> }).files?.[0];
  return {
    ts: options.thread_ts || "",
    fileId: file?.id || "",
  };
}

// ── Utility ────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

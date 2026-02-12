/**
 * Basic Slack tools: send_message, read_messages, reply_thread,
 * add_reaction, list_channels, get_thread.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SlackMessage } from "../types.js";
import { resolveChannel } from "../state.js";
import { slack, resolveBotUserId, sendSmart } from "../slack-client.js";
import { formatMessages } from "../formatting.js";
import { inboxIngest, inboxMarkAllRead, setChannelCursor } from "../db.js";

export function registerBasicTools(server: McpServer): void {

  // ── slack_send_message ───────────────────────────────────────

  server.tool(
    "slack_send_message",
    "Slack 채널에 메시지를 전송합니다. 긴 메시지는 자동 분할 또는 파일 업로드됩니다. 작업 결과 보고, 질문, 상태 업데이트 등에 사용.",
    {
      message: z.string().describe("전송할 메시지 텍스트 (Slack mrkdwn 포맷 지원). 길이 제한 없음 — 자동 처리됨."),
      channel: z.string().optional().describe("Slack 채널 ID (미지정 시 기본 채널 사용)"),
      thread_ts: z.string().optional().describe("스레드에 답장할 경우 ts 값"),
    },
    async ({ message, channel, thread_ts }) => {
      const ch = resolveChannel(channel);
      const result = await sendSmart(ch, message, { thread_ts });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            channel: ch,
            ts: result.ts,
            method: result.method,
            chunks: result.chunks,
            message: result.method === "file"
              ? "내용이 길어 파일로 업로드됨"
              : result.method === "chunked"
              ? `${result.chunks}개 메시지로 분할 전송됨`
              : "메시지 전송 완료",
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_read_messages ──────────────────────────────────────

  server.tool(
    "slack_read_messages",
    "Slack 채널의 최근 메시지를 읽어옵니다. 사용자의 명령이나 피드백을 확인할 때 사용.",
    {
      channel: z.string().optional().describe("Slack 채널 ID (미지정 시 기본 채널 사용)"),
      limit: z.number().min(1).max(100).default(10).describe("가져올 메시지 수 (기본: 10, 최대: 100)"),
      oldest: z.string().optional().describe("이 타임스탬프 이후의 메시지만 가져옴 (Slack ts 형식)"),
    },
    async ({ channel, limit, oldest }) => {
      const ch = resolveChannel(channel);
      const result = await slack.conversations.history({
        channel: ch,
        limit,
        ...(oldest ? { oldest } : {}),
      });
      const messages = (result.messages || []) as SlackMessage[];
      const sorted = [...messages].reverse();

      if (sorted.length > 0) {
        inboxIngest(ch, sorted);
        inboxMarkAllRead(ch, "read_messages");
        setChannelCursor(ch, sorted[sorted.length - 1].ts);
      }

      return {
        content: [{ type: "text", text: formatMessages(sorted) }],
      };
    }
  );

  // ── slack_reply_thread ───────────────────────────────────────

  server.tool(
    "slack_reply_thread",
    "특정 메시지의 스레드에 답장합니다. 사용자의 명령에 대한 결과를 해당 스레드에 회신할 때 사용.",
    {
      thread_ts: z.string().describe("답장할 원본 메시지의 타임스탬프 (ts 값)"),
      message: z.string().describe("답장 메시지 텍스트"),
      channel: z.string().optional().describe("Slack 채널 ID (미지정 시 기본 채널 사용)"),
    },
    async ({ thread_ts, message, channel }) => {
      const ch = resolveChannel(channel);
      const result = await sendSmart(ch, message, { thread_ts });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            channel: ch,
            ts: result.ts,
            thread_ts,
            method: result.method,
            message: "스레드 답장 완료",
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_add_reaction ───────────────────────────────────────

  server.tool(
    "slack_add_reaction",
    "메시지에 이모지 리액션을 추가합니다. 명령 수신 확인(👀), 작업 완료(✅) 등의 시그널에 사용.",
    {
      timestamp: z.string().describe("리액션을 달 메시지의 타임스탬프 (ts)"),
      reaction: z.string().default("eyes").describe("이모지 이름 (콜론 없이). 예: eyes, white_check_mark, rocket"),
      channel: z.string().optional().describe("Slack 채널 ID (미지정 시 기본 채널 사용)"),
    },
    async ({ timestamp, reaction, channel }) => {
      const ch = resolveChannel(channel);
      try {
        await slack.reactions.add({ channel: ch, name: reaction, timestamp });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("already_reacted")) {
          return {
            content: [{ type: "text", text: `✅ :${reaction}: 리액션 이미 존재 (ts: ${timestamp})` }],
          };
        }
        throw err;
      }

      return {
        content: [{ type: "text", text: `✅ :${reaction}: 리액션 추가 완료 (ts: ${timestamp})` }],
      };
    }
  );

  // ── slack_list_channels ──────────────────────────────────────

  server.tool(
    "slack_list_channels",
    "봇이 접근할 수 있는 Slack 채널 목록을 조회합니다.",
    {
      types: z.string().default("public_channel,private_channel").describe("조회할 채널 유형. 기본: public_channel,private_channel"),
      limit: z.number().min(1).max(200).default(50).describe("가져올 채널 수 (기본: 50)"),
    },
    async ({ types, limit }) => {
      const result = await slack.conversations.list({
        types,
        limit,
        exclude_archived: true,
      });

      const channels = (result.channels || []).map((ch) => ({
        id: ch.id,
        name: ch.name,
        is_member: ch.is_member,
        topic: (ch.topic as { value?: string })?.value || "",
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(channels, null, 2) }],
      };
    }
  );

  // ── slack_get_thread ─────────────────────────────────────────

  server.tool(
    "slack_get_thread",
    "특정 메시지의 전체 스레드를 읽어옵니다. 대화 맥락을 파악할 때 사용.",
    {
      thread_ts: z.string().describe("스레드 원본 메시지의 타임스탬프 (ts)"),
      channel: z.string().optional().describe("Slack 채널 ID (미지정 시 기본 채널 사용)"),
      limit: z.number().min(1).max(200).default(50).describe("가져올 메시지 수"),
    },
    async ({ thread_ts, channel, limit }) => {
      const ch = resolveChannel(channel);
      const result = await slack.conversations.replies({
        channel: ch,
        ts: thread_ts,
        limit,
      });

      const messages = (result.messages || []) as SlackMessage[];

      return {
        content: [{ type: "text", text: formatMessages(messages) }],
      };
    }
  );
}

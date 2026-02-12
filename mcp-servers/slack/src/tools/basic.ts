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
import { inboxIngest, inboxMarkAllRead, setChannelCursor, inboxGetUnread, inboxUnreadCount, getChannelCursor, getWatchedThreads, getWatchedThreadCount } from "../db.js";
import { fileURLToPath } from "url";
import path from "path";
import { execSync } from "child_process";

const RELOAD_EXIT_CODE = 42;
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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

  // ── slack_respond ────────────────────────────────────────────

  server.tool(
    "slack_respond",
    "사용자 명령에 응답합니다. thread_ts 유무에 따라 스레드 답장 또는 채널 메시지를 자동 라우팅합니다. command_loop/check_inbox의 reply_to 정보와 함께 사용하세요.",
    {
      message: z.string().describe("응답 메시지 텍스트 (Slack mrkdwn 지원, 자동 분할)"),
      channel: z.string().optional().describe("Slack 채널 ID (미지정 시 기본 채널)"),
      thread_ts: z.string().optional().describe("원본 메시지의 thread_ts. 있으면 스레드 답장, 없으면 채널 메시지."),
      reply_mode: z.enum(["auto", "thread", "channel"]).default("auto")
        .describe("auto: thread_ts 유무로 자동 결정 | thread: 강제 스레드 답장 | channel: 강제 채널 메시지"),
    },
    async ({ message, channel, thread_ts, reply_mode }) => {
      const ch = resolveChannel(channel);
      const useThread = reply_mode === "thread" ? true
                      : reply_mode === "channel" ? false
                      : !!thread_ts;
      const result = await sendSmart(ch, message, useThread && thread_ts ? { thread_ts } : undefined);
      const mode = useThread ? "thread_reply" : "channel_message";

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            channel: ch,
            ts: result.ts,
            ...(useThread ? { thread_ts } : {}),
            mode,
            method: result.method,
            chunks: result.chunks,
            message: mode === "thread_reply" ? "스레드 답장 완료" : "채널 메시지 전송 완료",
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_update_message ─────────────────────────────────────

  server.tool(
    "slack_update_message",
    "이전에 보낸 메시지를 수정합니다. 오타 수정, 진행 상태 업데이트, 결과 추가 등에 사용. 수정하려는 메시지의 ts 값이 필요합니다 (send/respond 결과에 포함됨).",
    {
      ts: z.string().describe("수정할 메시지의 타임스탬프 (ts). slack_send_message/slack_respond 결과에서 받은 값."),
      message: z.string().describe("새 메시지 텍스트 (기존 내용을 완전히 대체). Slack mrkdwn 포맷 지원."),
      channel: z.string().optional().describe("Slack 채널 ID (미지정 시 기본 채널)"),
    },
    async ({ ts, message, channel }) => {
      const ch = resolveChannel(channel);
      try {
        const result = await slack.chat.update({ channel: ch, ts, text: message });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              channel: ch,
              ts: result.ts,
              message: "메시지 수정 완료",
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: msg,
              hint: msg.includes("message_not_found")
                ? "해당 ts의 메시지를 찾을 수 없습니다. 봇이 보낸 메시지만 수정 가능합니다."
                : msg.includes("cant_update_message")
                ? "이 메시지는 수정할 수 없습니다. 봇 자신이 보낸 메시지만 수정할 수 있습니다."
                : "메시지 수정 실패",
            }, null, 2),
          }],
        };
      }
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

  // ── slack_reload ─────────────────────────────────────────────

  server.tool(
    "slack_reload",
    "MCP 서버를 리로드합니다. 코드 변경 후 TypeScript 빌드 + 서버 재시작을 자동 수행합니다. wrapper.js를 통해 실행 중이어야 동작합니다.",
    {
      build: z.boolean().default(true).describe("리로드 전에 npx tsc를 실행할지 여부. false면 기존 dist로 즉시 재시작."),
    },
    async ({ build }) => {
      if (build) {
        try {
          const output = execSync("npx tsc", {
            cwd: SERVER_ROOT,
            timeout: 30000,
            stdio: "pipe",
            encoding: "utf-8",
          });
          console.error("✅ TypeScript build succeeded");
        } catch (e: unknown) {
          const err = e as { stdout?: string; stderr?: string; message?: string };
          const errorOutput = err.stdout || err.stderr || err.message || "Unknown build error";
          return {
            content: [{ type: "text", text: `❌ 빌드 실패. 서버를 재시작하지 않습니다.\n\n${errorOutput}` }],
          };
        }
      }

      // Allow MCP response to flush before exiting
      setTimeout(() => process.exit(RELOAD_EXIT_CODE), 300);

      return {
        content: [{
          type: "text",
          text: build
            ? "🔄 빌드 성공. MCP 서버를 리로드합니다... (1-2초 소요)"
            : "🔄 MCP 서버를 리로드합니다... (1-2초 소요)",
        }],
      };
    }
  );

  // ── slack_inbox_status ───────────────────────────────────────

  server.tool(
    "slack_inbox_status",
    "인박스 시스템의 현재 상태를 진단합니다. 커서 위치, 미읽 건수, 감시 중인 스레드 목록, 최근 인박스 항목을 확인합니다.",
    {
      channel: z.string().optional().describe("채널 ID (미지정 시 기본 채널)"),
    },
    async ({ channel }) => {
      const ch = resolveChannel(channel);
      const cursor = getChannelCursor(ch);
      const unreadCount = inboxUnreadCount(ch);
      const unreadMessages = inboxGetUnread(ch);
      const watchedThreads = getWatchedThreads(ch);
      const watchedCount = getWatchedThreadCount(ch);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            channel: ch,
            cursor: cursor || "(not set — first read pending)",
            unread_count: unreadCount,
            watched_threads: {
              count: watchedCount,
              threads: watchedThreads.slice(0, 20).map((wt) => ({
                thread_ts: wt.thread_ts,
                context: wt.context,
              })),
            },
            recent_unread: unreadMessages.slice(0, 10).map((r) => ({
              ts: r.message_ts,
              thread_ts: r.thread_ts,
              user: r.user_id,
              text: (r.text || "").slice(0, 100),
              status: r.status,
            })),
            diagnostics: {
              cursor_set: !!cursor,
              has_unread: unreadCount > 0,
              threads_tracked: watchedCount > 0,
              health: cursor && watchedCount > 0 ? "OK" : cursor ? "WARN: no watched threads" : "WARN: cursor not set",
            },
          }, null, 2),
        }],
      };
    }
  );
}

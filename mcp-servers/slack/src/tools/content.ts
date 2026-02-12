/**
 * Content tools: upload_snippet, send_code.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LANG_EXTENSIONS } from "../types.js";
import { resolveChannel } from "../state.js";
import { slack, uploadContent } from "../slack-client.js";

export function registerContentTools(server: McpServer): void {

  // ── slack_upload_snippet ─────────────────────────────────────

  server.tool(
    "slack_upload_snippet",
    "코드, 빌드 로그, 에러 트레이스 등 긴 텍스트를 Slack 파일(snippet)로 업로드합니다. 40,000자 이상도 처리 가능.",
    {
      content: z.string().describe("업로드할 텍스트 내용 (길이 제한 없음)"),
      filename: z.string().default("output.txt").describe("파일명 (예: build.log, diff.patch, error.txt)"),
      title: z.string().optional().describe("파일 제목 (Slack에 표시됨)"),
      filetype: z.string().optional().describe("파일 타입 (예: rust, typescript, javascript, python, text, diff, shell). syntax highlight에 사용."),
      channel: z.string().optional().describe("Slack 채널 ID"),
      thread_ts: z.string().optional().describe("스레드에 첨부할 경우 ts"),
      comment: z.string().optional().describe("파일과 함께 보낼 코멘트 메시지"),
    },
    async ({ content, filename, title, filetype, channel, thread_ts, comment }) => {
      const ch = resolveChannel(channel);

      if (comment) {
        const msgResult = await slack.chat.postMessage({
          channel: ch,
          text: comment,
          thread_ts,
          mrkdwn: true,
        });
        thread_ts = thread_ts || msgResult.ts;
      }

      const result = await uploadContent(ch, content, {
        filename,
        title: title || filename,
        thread_ts,
        filetype,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            file_id: result.fileId,
            channel: ch,
            size: content.length,
            filename,
            message: `파일 업로드 완료 (${content.length.toLocaleString()}자)`,
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_send_code ──────────────────────────────────────────

  server.tool(
    "slack_send_code",
    "코드 블록을 보기 좋게 전송합니다. 짧은 코드는 인라인 코드 블록으로, 긴 코드는 파일로 자동 업로드.",
    {
      code: z.string().describe("코드 내용"),
      language: z.string().default("text").describe("프로그래밍 언어 (rust, typescript, python 등)"),
      title: z.string().optional().describe("코드 설명/제목"),
      channel: z.string().optional().describe("Slack 채널 ID"),
      thread_ts: z.string().optional().describe("스레드에 첨부할 경우 ts"),
    },
    async ({ code, language, title, channel, thread_ts }) => {
      const ch = resolveChannel(channel);
      const langExt = LANG_EXTENSIONS[language] || language;

      if (code.length <= 3500) {
        const prefix = title ? `*${title}*\n` : "";
        const formatted = `${prefix}\`\`\`${language}\n${code}\n\`\`\``;
        const result = await slack.chat.postMessage({
          channel: ch,
          text: formatted,
          thread_ts,
          mrkdwn: true,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              { ok: true, ts: result.ts, method: "code_block", size: code.length },
              null, 2
            ),
          }],
        };
      }

      const filename = title
        ? `${title.replace(/[^a-zA-Z0-9_-]/g, "_")}.${langExt}`
        : `code.${langExt}`;

      const result = await uploadContent(ch, code, {
        filename,
        title: title || `Code (${language})`,
        thread_ts,
        filetype: language,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            file_id: result.fileId,
            method: "file_upload",
            size: code.length,
            filename,
          }, null, 2),
        }],
      };
    }
  );
}

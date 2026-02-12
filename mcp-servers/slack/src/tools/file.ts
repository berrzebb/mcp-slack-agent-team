/**
 * File tools: slack_download_file, slack_upload_file
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve, basename, extname, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { SlackFile } from "../types.js";
import { SLACK_BOT_TOKEN, DOWNLOAD_DIR } from "../types.js";
import { resolveChannel } from "../state.js";
import { slack } from "../slack-client.js";

export function registerFileTools(server: McpServer): void {

  // ── slack_download_file ──────────────────────────────────────

  server.tool(
    "slack_download_file",
    "Slack에 업로드된 파일(이미지, 문서 등)을 로컬 파일시스템에 다운로드합니다. 메시지의 files 필드에서 file_id를 확인하세요.",
    {
      file_id: z.string().describe("Slack 파일 ID (메시지의 files[].id에서 가져옴)"),
      save_path: z.string().optional().describe("저장할 로컬 경로. 미지정 시 downloads/ 디렉토리에 원본 파일명으로 저장"),
    },
    async ({ file_id, save_path }) => {
      const fileInfo = await slack.files.info({ file: file_id });
      const file = (fileInfo as { file?: SlackFile & { url_private_download?: string; url_private?: string } }).file;
      if (!file) {
        throw new Error(`파일을 찾을 수 없습니다: ${file_id}`);
      }

      const downloadUrl = file.url_private_download || file.url_private;
      if (!downloadUrl) {
        throw new Error(`파일 다운로드 URL이 없습니다. 파일 타입을 확인하세요: ${file.name || file_id}`);
      }

      const filename = file.name || `file-${file_id}${extname(file.name || ".bin")}`;
      const targetPath = save_path ? resolve(save_path) : resolve(DOWNLOAD_DIR, filename);
      const targetDir = dirname(targetPath);
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

      const response = await fetch(downloadUrl, {
        headers: { "Authorization": `Bearer ${SLACK_BOT_TOKEN}` },
      });

      if (!response.ok) {
        throw new Error(`파일 다운로드 실패: HTTP ${response.status} ${response.statusText}`);
      }

      const fileStream = createWriteStream(targetPath);
      // @ts-expect-error - Node.js fetch body is a ReadableStream
      await pipeline(response.body, fileStream);

      const isImage = file.mimetype?.startsWith("image/");
      const hint = isImage
        ? "이미지 파일입니다. read_file이나 이미지 분석 도구로 내용을 확인하세요."
        : `${file.filetype || "unknown"} 타입 파일이 다운로드되었습니다.`;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true, file_id, name: file.name,
            mimetype: file.mimetype, size: file.size,
            filetype: file.filetype, saved_to: targetPath, hint,
          }, null, 2),
        }],
      };
    }
  );

  // ── slack_upload_file ────────────────────────────────────────

  server.tool(
    "slack_upload_file",
    "로컬 파일(이미지, 문서, 로그 등)을 Slack 채널에 업로드합니다. 작업 결과물, 스크린샷, 차트 등을 공유할 때 사용.",
    {
      file_path: z.string().describe("업로드할 로컬 파일의 절대 경로"),
      channel: z.string().optional().describe("업로드할 채널 ID (미지정 시 기본 채널)"),
      title: z.string().optional().describe("파일 제목 (Slack에 표시)"),
      message: z.string().optional().describe("파일과 함께 보낼 메시지"),
      thread_ts: z.string().optional().describe("스레드에 업로드할 경우 해당 ts"),
    },
    async ({ file_path, channel, title, message, thread_ts }) => {
      const ch = resolveChannel(channel);
      const absPath = resolve(file_path);

      if (!existsSync(absPath)) {
        throw new Error(`파일이 존재하지 않습니다: ${absPath}`);
      }

      const fileContent = readFileSync(absPath);
      const filename = basename(absPath);
      const fileTitle = title || filename;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = {
        channel_id: ch,
        file: fileContent,
        filename,
        title: fileTitle,
      };
      if (thread_ts) args.thread_ts = thread_ts;
      if (message) args.initial_comment = message;

      const result = await slack.filesUploadV2(args);
      const uploadedFile = (result as { files?: Array<{ id?: string }> }).files?.[0];

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true, file_id: uploadedFile?.id || "",
            filename, title: fileTitle, channel: ch,
            thread_ts: thread_ts || null, message: message || null,
            hint: "파일이 Slack에 업로드되었습니다.",
          }, null, 2),
        }],
      };
    }
  );
}

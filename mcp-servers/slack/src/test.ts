/**
 * Slack MCP 서버 연결 테스트
 * 
 * 1. Bot 인증 확인
 * 2. 채널 접근 확인
 * 3. 메시지 전송 테스트
 * 4. 메시지 읽기 테스트
 */

import { WebClient } from "@slack/web-api";
import { readFileSync } from "fs";
import { resolve } from "path";

// .env 파일에서 환경변수 로드
const envPath = resolve(import.meta.dirname || ".", "..", ".env");
const envContent = readFileSync(envPath, "utf-8");
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx > 0) {
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    process.env[key] = val;
  }
}

const token = process.env.SLACK_BOT_TOKEN;
const channel = process.env.SLACK_DEFAULT_CHANNEL;

if (!token || !channel) {
  console.error("❌ SLACK_BOT_TOKEN 또는 SLACK_DEFAULT_CHANNEL이 .env에 없습니다.");
  process.exit(1);
}

const slack = new WebClient(token);

async function test() {
  console.log("═══════════════════════════════════════");
  console.log("  Slack MCP Server - 연결 테스트");
  console.log("═══════════════════════════════════════\n");

  // 1. Bot 인증 확인
  console.log("1️⃣  Bot 인증 확인...");
  try {
    const auth = await slack.auth.test();
    console.log(`   ✅ 인증 성공`);
    console.log(`   Bot: ${auth.user} (${auth.user_id})`);
    console.log(`   Team: ${auth.team} (${auth.team_id})\n`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`   ❌ 인증 실패: ${msg}`);
    console.error("   → SLACK_BOT_TOKEN을 확인하세요.");
    process.exit(1);
  }

  // 2. 채널 접근 확인
  console.log(`2️⃣  채널 접근 확인 (${channel})...`);
  try {
    const info = await slack.conversations.info({ channel });
    const ch = info.channel as { name?: string; is_member?: boolean; is_private?: boolean };
    console.log(`   ✅ 채널: #${ch.name}`);
    console.log(`   Private: ${ch.is_private ? "예" : "아니오"}`);
    console.log(`   Bot 멤버: ${ch.is_member ? "예" : "❌ 아니오 — /invite @봇이름 필요"}\n`);
    
    if (!ch.is_member) {
      console.error("   ⚠️  봇이 채널에 참가하지 않았습니다. Slack에서 /invite @봇이름을 실행하세요.");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`   ❌ 채널 접근 실패: ${msg}`);
    console.error("   → SLACK_DEFAULT_CHANNEL ID를 확인하세요.");
    process.exit(1);
  }

  // 3. 메시지 전송 테스트
  console.log("3️⃣  메시지 전송 테스트...");
  try {
    const result = await slack.chat.postMessage({
      channel,
      text: "🔧 *Slack MCP 서버 테스트*\n\n연결 확인 메시지입니다. 이 메시지가 보이면 MCP 서버가 정상적으로 Slack에 접근할 수 있습니다.",
      mrkdwn: true,
    });
    console.log(`   ✅ 메시지 전송 성공 (ts: ${result.ts})\n`);

    // 4. 메시지 읽기 테스트
    console.log("4️⃣  메시지 읽기 테스트...");
    const history = await slack.conversations.history({
      channel,
      limit: 3,
    });
    const msgs = history.messages || [];
    console.log(`   ✅ 최근 ${msgs.length}개 메시지 읽기 성공`);
    for (const m of msgs.slice(0, 3)) {
      const text = ((m as { text?: string }).text || "").slice(0, 60);
      console.log(`      [${m.ts}] ${text}...`);
    }
    console.log();

    // 5. 리액션 테스트
    console.log("5️⃣  리액션 테스트...");
    await slack.reactions.add({
      channel,
      name: "white_check_mark",
      timestamp: result.ts!,
    });
    console.log("   ✅ ✅ 리액션 추가 성공\n");

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`   ❌ 실패: ${msg}`);
    
    if (msg.includes("not_in_channel")) {
      console.error("   → 봇이 채널에 참가하지 않았습니다. /invite @봇이름을 실행하세요.");
    } else if (msg.includes("channel_not_found")) {
      console.error("   → 채널 ID를 확인하세요.");
    } else if (msg.includes("missing_scope")) {
      console.error("   → Slack App에 필요한 권한(scope)을 추가하세요.");
      console.error("   필요 scopes: chat:write, channels:history, reactions:write");
    }
    process.exit(1);
  }

  console.log("═══════════════════════════════════════");
  console.log("  ✅ 모든 테스트 통과!");
  console.log("═══════════════════════════════════════");
  console.log("\n다음 단계:");
  console.log("  1. Claude Code를 재시작하여 MCP 서버 로드");
  console.log("  2. Agent에게: slack_send_message('안녕하세요!')");
  console.log("  3. 또는: slack_command_loop()로 명령 대기 모드 시작");
}

test();

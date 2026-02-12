# mcp-slack-agent-team

Slack 기반 Claude Code 원격 제어 및 멀티 에이전트 팀 관리 MCP 서버.

Slack 채널에서 Claude Code 에이전트에게 명령을 보내고, 결과를 받고, 멀티 에이전트 팀을 조율할 수 있습니다.

## 구성

```
commands/                          # Claude Code 슬래시 커맨드
├── slack-loop.md                  #   /slack-loop — Slack 명령 대기 루프
└── slack-team-resume.md           #   /slack-team-resume — 팀 세션 복구

mcp-servers/slack/                 # Slack MCP 서버
├── src/
│   ├── index.ts                   #   MCP 서버 (21개 도구)
│   ├── approval-hook.ts           #   위험 명령 Slack 승인 훅
│   ├── test.ts                    #   연결 테스트
│   └── check.ts                   #   간단한 연결 확인
├── package.json
├── tsconfig.json
└── .env.example
```

## 주요 기능

- **원격 제어** — Slack에서 명령 입력 → 에이전트 실행 → 결과를 스레드로 회신
- **명령 루프** — `slack_command_loop`로 채팅 인터페이스를 완전히 대체
- **멀티 에이전트 팀** — 전용 채널 생성, 역할별 이름/아이콘, 브로드캐스트, 아카이브
- **승인 훅** — `git push`, `rm` 등 위험 명령 실행 전 Slack에서 승인/거부
- **긴 메시지 자동 처리** — 분할 전송 또는 파일 업로드
- **세션 복구** — compact/재시작 후 상태 자동 복원

## 빠른 시작

```bash
# 1. 클론 & 설치
git clone https://github.com/berrzebb/mcp-slack-agent-team.git
cd mcp-slack-agent-team/mcp-servers/slack
npm install
npm run build

# 2. 연결 테스트
cp .env.example .env
# .env에 SLACK_BOT_TOKEN, SLACK_DEFAULT_CHANNEL 입력
npx tsx src/test.ts
```

### Claude Code에 등록

`.claude/settings.json` 또는 `~/.claude.json`:

```json
{
  "mcpServers": {
    "slack": {
      "command": "node",
      "args": ["path/to/mcp-slack-agent-team/mcp-servers/slack/dist/index.js"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-your-bot-token",
        "SLACK_DEFAULT_CHANNEL": "C채널ID"
      }
    }
  }
}
```

## 워크플로우

```
사용자 (Slack)             Agent (Claude Code)
    │                            │
    ├─── 명령 입력 ────────────→│  slack_command_loop
    │                            ├── 👀 수신 확인
    │                            ├── 작업 수행
    │                            ├── 결과 전송 (스레드)
    │←── 결과 수신 ────────────┤  ✅ 완료
    ├─── 피드백 ──────────────→│  slack_wait_for_reply
    │                            └── 다음 명령 대기
```

## 제공 도구 (21개)

| 카테고리 | 도구 |
|----------|------|
| **기본 통신** | `slack_send_message`, `slack_read_messages`, `slack_reply_thread`, `slack_wait_for_reply`, `slack_add_reaction`, `slack_list_channels`, `slack_get_thread` |
| **컨텐츠** | `slack_upload_snippet`, `slack_send_code` |
| **명령 루프** | `slack_command_loop` |
| **팀 관리** | `slack_team_create`, `slack_team_register`, `slack_team_send`, `slack_team_read`, `slack_team_wait`, `slack_team_thread`, `slack_team_status`, `slack_team_broadcast`, `slack_team_close` |
| **상태** | `slack_save_state`, `slack_load_state` |

## 필요한 Slack Bot Token Scopes

| Scope | 용도 |
|-------|------|
| `chat:write` | 메시지 전송 |
| `chat:write.customize` | 에이전트 역할별 이름/아이콘 표시 |
| `channels:history` | 채널 메시지 읽기 |
| `groups:history` | 비공개 채널 메시지 읽기 |
| `reactions:write` | 리액션 추가 |
| `reactions:read` | 리액션 읽기 (승인 훅) |
| `channels:read` / `groups:read` | 채널 목록 조회 |
| `channels:manage` | 팀 채널 생성/아카이브 |
| `channels:join` | 채널 자동 참가 |
| `users:read` | 봇 ID 자동 감지 |
| `files:write` | 파일 업로드 |

> 상세 설정 가이드: [mcp-servers/slack/README.md](mcp-servers/slack/README.md)

## 라이선스

MIT

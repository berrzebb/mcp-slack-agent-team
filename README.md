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
│   ├── index.ts                   #   엔트리포인트 (도구 등록 + 서버 시작)
│   ├── wrapper.ts                 #   자동 재시작 래퍼 (핫 리로드 지원)
│   ├── background-poller.ts       #   백그라운드 메시지 수집기 (10초 간격)
│   ├── types.ts                   #   인터페이스, 상수, 타입 정의
│   ├── db.ts                      #   SQLite 초기화 + 데이터 접근 헬퍼
│   ├── state.ts                   #   JSON 상태 관리 + 팀 레지스트리
│   ├── slack-client.ts            #   WebClient + sendSmart + 메시지 분할
│   ├── formatting.ts              #   메시지 포맷 + 리치 포맷팅 유틸리티
│   ├── approval-hook.ts           #   위험 명령 Slack 승인 훅
│   ├── test.ts                    #   연결 테스트
│   ├── check.ts                   #   간단한 연결 확인
│   └── tools/                     #   도구 모듈 (총 38개)
│       ├── basic.ts               #     기본 통신 + 응답 + 진단 (10개)
│       ├── content.ts             #     코드/스니펫 업로드 (2개)
│       ├── loop.ts                #     명령 루프 + 인박스 (3개)
│       ├── team.ts                #     팀 관리 (10개)
│       ├── context.ts             #     팀 컨텍스트 관리 (7개)
│       ├── approval.ts            #     승인 요청 (1개)
│       ├── file.ts                #     파일 다운로드/업로드 (2개)
│       └── state.ts               #     상태 저장/복원 + 비용 보고 (3개)
├── package.json
├── tsconfig.json
└── .env.example
```

## 주요 기능

- **원격 제어** — Slack에서 명령 입력 → 에이전트 실행 → 결과를 스레드로 회신
- **명령 루프** — `slack_command_loop`로 채팅 인터페이스를 완전히 대체
- **멀티 에이전트 팀** — 전용 채널 생성, 역할별 이름/아이콘, 브로드캐스트, 아카이브
- **백그라운드 수집** — 10초 간격 자동 메시지 폴링, 도구 호출 없이도 Slack 메시지 유실 방지
- **영구 컨텍스트 관리** — SQLite 기반 태스크/의사결정/에이전트 컨텍스트 저장, 컨텍스트 압축 후 즉시 복구
- **핫 리로드** — `slack_reload`로 코드 빌드 + 서버 재시작, `wrapper.js`로 Claude Code 연결 유지
- **승인 훅** — `git push`, `rm` 등 위험 명령 실행 전 Slack에서 승인/거부
- **파일 전송** — Slack 파일 다운로드/업로드 (이미지, 문서, 로그 등)
- **긴 메시지 자동 처리** — 분할 전송 또는 파일 업로드
- **비용 보고** — ccusage 연동으로 Claude Code 토큰/비용 Slack 보고
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
      "args": ["path/to/mcp-slack-agent-team/mcp-servers/slack/dist/wrapper.js"],
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

## 제공 도구 (38개)

| 카테고리 | 도구 |
|----------|------|
| **기본 통신 + 응답** (10) | `slack_send_message`, `slack_respond`, `slack_update_message`, `slack_read_messages`, `slack_reply_thread`, `slack_add_reaction`, `slack_list_channels`, `slack_get_thread`, `slack_reload`, `slack_inbox_status` |
| **컨텐츠** (2) | `slack_upload_snippet`, `slack_send_code` |
| **명령 루프 + 인박스** (3) | `slack_command_loop`, `slack_check_inbox`, `slack_wait_for_reply` |
| **팀 관리** (10) | `slack_team_create`, `slack_team_register`, `slack_team_send`, `slack_team_read`, `slack_team_wait`, `slack_team_thread`, `slack_team_status`, `slack_team_broadcast`, `slack_team_report`, `slack_team_close` |
| **팀 컨텍스트** (7) | `slack_team_assign_task`, `slack_team_update_task`, `slack_team_list_tasks`, `slack_team_save_context`, `slack_team_get_context`, `slack_team_log_decision`, `slack_team_decisions` |
| **승인** (1) | `slack_request_approval` |
| **파일** (2) | `slack_download_file`, `slack_upload_file` |
| **상태 + 비용** (3) | `slack_save_state`, `slack_load_state`, `slack_cost_report` |

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
| `files:read` | 파일 다운로드 |

> 상세 설정 가이드: [mcp-servers/slack/README.md](mcp-servers/slack/README.md)

## 라이선스

MIT

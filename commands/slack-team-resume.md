Compact 또는 재시작 후 에이전트 팀 조율을 복구합니다.

## 복구 절차

1. **slack_load_state** 호출 → 팀 레지스트리 복원 (팀 ID, 채널, 멤버 목록)
2. 복원된 각 활성 팀에 대해:
   a. **slack_team_status**(team_id, post_to_channel=false) → 현재 멤버 상태 확인
   b. **slack_read_messages**(channel=팀채널ID, limit=20) → 최근 활동 파악
   c. 각 멤버의 마지막 메시지를 분석하여 어디까지 진행되었는지 파악
3. 팀 채널에 복구 알림:
   - slack_team_broadcast(team_id, sender="lead", message="🔄 세션 복구. 현황을 확인 중입니다.")
4. 중단된 작업이 있으면:
   - 해당 sub-leader/worker에게 slack_team_send로 현황 확인 요청
   - 또는 직접 Slack 채널 메시지를 읽어 진행 상태 추적
5. 복구 완료 후 정상 팀 운영 재개

## 핵심 원칙

- 팀 채널의 Slack 메시지 히스토리가 **진실의 원천(source of truth)**
- state.json은 팀 ID, 채널 ID, 멤버 목록만 제공 (빠른 복구용)
- 실제 진행 상태는 Slack 채널 메시지를 읽어서 파악
- sub-agent 프로세스가 여전히 실행 중일 수 있으므로, 채널에서 최근 활동 확인 후 판단

## 주의사항

- sub-agent가 compact 전에 작업 중이었다면, 해당 프로세스는 독립적으로 계속 실행됨
- lead가 compact되어 잊었더라도, sub-agent의 메시지가 Slack 채널에 계속 올라옴
- 따라서 채널 메시지를 읽으면 현재 진행 상태를 파악할 수 있음
- 필요 시 새 sub-agent를 생성하거나, 기존 sub-agent의 완료를 대기

$ARGUMENTS가 있으면 특정 팀 ID만 복구합니다. 없으면 모든 활성 팀을 복구합니다.

Slack 채널에서 사용자 명령을 대기하는 루프 모드에 진입합니다.

## Compact 복구

가장 먼저 slack_load_state를 호출하세요.
- 이전 루프 상태가 있으면 해당 channel과 since_ts로 이어서 대기
- 없으면 새로 시작

## 순서

1. slack_load_state로 이전 상태 확인
2. 이전 상태가 있고 loop.active=true이면:
   - 해당 channel, since_ts=loop.last_ts로 slack_command_loop 재개
   - slack_send_message("🔄 세션 복구 완료. 명령 대기를 재개합니다.")
3. 새 시작이면:
   - slack_send_message("🤖 명령 대기 모드 시작. Slack에 명령을 입력하세요.")
4. slack_command_loop로 명령 대기 (5분 타임아웃)
5. 명령 수신 시:
   a. 명령 내용을 파악하여 수행
   b. 결과를 slack_reply_thread로 해당 메시지 스레드에 회신
   c. slack_add_reaction(ts, "white_check_mark")으로 완료 표시
   d. slack_save_state(last_ts=방금 ts, task_context="방금 한 일 요약")
   e. 다시 slack_command_loop(since_ts=방금 ts)로 다음 명령 대기
6. 타임아웃 시 slack_command_loop를 다시 호출하여 대기 재개
7. 사용자가 "종료", "exit", "quit", "stop" 명령을 보내면:
   - slack_save_state(loop_active=false)
   - 루프 종료

## 규칙

- 모든 결과는 slack_reply_thread로 원본 명령의 스레드에 답장
- 긴 출력(빌드 로그, 코드 등)은 slack_upload_snippet 또는 slack_send_code 사용
- 에러 발생 시에도 Slack에 에러 내용 보고 후 대기 재개
- 수신 확인은 slack_command_loop가 자동으로 👀 리액션 추가
- 작업 완료 시 ✅ 리액션 추가
- 중요한 시점마다 slack_save_state 호출 (compact 대비)

$ARGUMENTS가 있으면 첫 번째 메시지로 해당 내용을 전송합니다.

# UX11-AI-DIRECT — 첨부 문제는 문맥, 답변 대상은 실제 질문

## 요구·설계

- 문제에서 AI 질문하기를 눌러도 자동 전체 해설 생성으로 처리하지 않는다. 문제는 참고 문맥, 실제 사용자가 입력한 최신 질문이 직접 답변 대상이다. 특정 보기·용어·문장·근거를 물으면 그 범위부터 답하고 모든 보기를 순회하거나 전체 풀이를 자동 덧붙이지 않는다. 사용자가 전체 해설을 명시적으로 요청하면 기존 disclosure 권한 안에서만 제공한다.
- hint/full 서버 경계·제출 전 정답/해설 비포함 DTO·근거 출처·개인 대화 격리·worker/SSE/idempotency를 유지한다. 관련 문제라는 이유로 question stem을 사용자 질문처럼 중복 전송하지 않는다. 검색 query 확장과 prompt context를 구분한다.
- 전송 버튼/Enter에서 전송할 text를 snapshot으로 잡고 입력창은 네트워크 await 전에 즉시 비운다. 진행 상태·보낸 질문은 UI에서 확인할 수 있어야 한다. 중복 클릭/Enter로 같은 메시지를 두 번 보내지 않는다.
- 에러 처리 사용자 확정: 새 입력이 없으면 실패 질문을 입력칸에 복구하고 새 입력은 보존한다. 적용: API가 수락하기 전 실패하고 이후 새 입력이 없으면 snapshot 복구, 새 draft는 덮지 않음. API 수락 후 stream 실패는 기존 메시지 재시도 경로를 사용해 중복 질문을 만들지 않음. 실패한 내용은 버리지 않는다. 이때 전송 실패와 서버 수락 후 답변 생성 실패를 구분하고 기존 retry 흐름을 보존한다.

- 복구 snapshot은 메모리에만 보관하고 Workspace·대화별로 구분한다. 서버의 `getVerifiedUser` (`getClaims`)로 확인한 주체만 소유하며, HttpOnly cookie 때문에 `/api/auth/identity`에서 검증된 ID만 `private, no-store`로 반환한다. 로그아웃·계정 변경은 기존 요청 세대를 폐기한다. 인증 확인의 일시적인 네트워크·서버 오류는 로그아웃으로 간주하지 않으며, 복구 내용을 숨긴 채 메모리와 새 draft를 보존하고 같은 사용자 재확인 후 다시 보인다.

## 구현·검증

기존 ASK prompt/worker payload builder·renderer·ask-panel/use-ask-state/client를 실제 소스에서 확인한다. UX10-AI가 소유한 ask-panel 변경은 인계 후 작업한다. 질문 text/첨부 context가 구분되는 계약·prompt 정책 회귀를 테스트한다. 특정 보기 질문, 단어 질문, 전체 해설 명시 요청, hint 모드, 빠른 중복 전송, HTTP 거절·네트워크 실패·stream 실패·전송 중 새 입력·IME Enter를 검증한다. fake adapter로 결정적 검사, 실제 LLM 품질을 검사하지 않았으면 검사했다고 보고하지 않는다.

AC: UX11-AI-DIRECT-AC01 직접 질문 우선·전체 해설 자동 생성 금지; AC02 전송 즉시 입력 비움·보낸 내용 유지; AC03 실패 복구/새 draft 보존·중복 방지; AC04 disclosure·권한·기존 streaming/retry 회귀 없음. RED 단계에 docs/screens 전용 명세와 실제 테스트 경로·phase를 등록한다. touched lint/typecheck/unit/contract/E2E 후 독립 리뷰·커밋·보고.

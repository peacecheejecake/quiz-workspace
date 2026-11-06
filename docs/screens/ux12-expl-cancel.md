# UX12-EXPLCANCEL — AI 해설 만들기 취소

**E2E:** `tests/e2e/quality/ux12-expl-cancel.spec.ts`

**Phase:** `UX12-EXPLCANCEL.0`

**상태:** UX12 EXPL-3 신규 2026-11-06 (사용자 피드백 "AI 해설 만들기(다시 만들기 포함) 실행 취소 필요"). **연계:** [AIEXPL-01](ai-explanations.md), [UX12-EXPL](ux12-explanations.md), [UX12 계획](../implementation/ux12/index.md) §4.5.

## 규칙

- 만드는 중에는 "작성중..." 옆에 `취소` 버튼이 있다. 제목은 그대로 일반 글자다.
- `취소`는 요청한 사람과 활성 Workspace의 owner/editor에게만 보인다. 나머지는 만드는 과정만 본다.
- 취소하면 다시 만들기는 기존 해설로 돌아가고, 새로 만들기는 해설 영역이 사라져 도구 줄의 `AI 해설` 버튼만 남는다. 실패가 아니므로 alert는 없고 status가 "취소했습니다"를 알린다. 초점은 기존 해설의 제목 또는 `AI 해설` 버튼으로 옮긴다.
- 같은 문제를 보던 다른 사람도 같은 화면으로 돌아간다.
- 취소한 실행도 일일 한도와 재생성 한도에 계산한다. 이미 쓴 LLM 사용량은 `stopped`로 기록한다.

## API

- `POST /questions/{id}/ai-explanation/cancel`, `POST /mock-exam-questions/{id}/ai-explanation/cancel`. Body는 만들기와 같은 gate에 `explanation_id`를 더한다. 그래서 늦게 누른 취소가 더 새로운 실행을 멈추지 않는다. 응답은 200과 취소 후 state다.
- State에 `can_cancel`이 있다. 만드는 중이고 활성 Workspace이며 호출자가 요청자이거나 owner/editor일 때 true다.
- 다른 사용자(viewer)는 403 `insufficient-role`, 보관된 Workspace는 403 `workspace-archived`, 다른 문제의 id·모르는 id·비회원은 404다.
- 끝난 해설에 보내면 아무것도 바꾸지 않고 현재 state를 200으로 답한다. 두 번 보내도 같다.
- 저장값은 `status='failed'`, `error_code='cancelled'`다. `quiz_api`에는 이 전이만 허용하는 update 권한과 policy가 필요해 migration `20261106120000_ai_explanation_cancel.sql`을 추가했다 (계획 초안의 "migration 불필요"는 check 제약만 본 판단이었고, `quiz_api`에는 update 권한이 없었다).
- 취소된 행은 state에서 없는 것으로 읽는다. 진행 중이던 SSE는 `error {code: "cancelled"}`로 끝나고, 화면은 이를 실패로 보이지 않는다.
- Worker는 streaming 중 상태를 throttle해서 확인하고 provider call마다 먼저 확인한다. 취소를 보면 provider stream을 닫고 사용량을 기록한 뒤 멈춘다.
- **취소한 호출의 사용량은 추정값이 섞여 있다.** 닫은 stream에는 `TextStreamEnd`가 없다. 입력 토큰은 provider가 시작할 때 보고한 값을 쓰고(`TextStreamUsage`), 그 값이 없으면 프롬프트 글자 수 ÷ 2로 추정한다. 출력 토큰은 받은 글자 수 ÷ 2로 추정한다. 한국어 기준으로 크게 잡은 값이며, 월간 토큰 한도가 비용이 든 호출을 놓치지 않게 하려는 것이다. 받지 못한 출력과 thinking 토큰은 포함되지 않고 `cost_usd`는 계산하지 않는다.

## 수용 기준

### UX12-EXPLCANCEL-AC01
**새로 만들기 취소:** 만드는 동안 "작성중..." 옆에 `취소`가 보이고, 누르면 해설 영역이 사라지고 `AI 해설` 버튼에 초점이 간다. status는 "취소했습니다"이고 alert는 없다. 다시 열어도 해설은 없고, LLM이 뒤늦게 답해도 저장되지 않으며, 다시 만들 수 있다.

### UX12-EXPLCANCEL-AC02
**다시 만들기 취소:** 다시 만드는 동안 `취소`를 누르면 기존 해설이 그대로 돌아오고 버전이 늘지 않으며 `다시 만들기`를 다시 쓸 수 있다.

### UX12-EXPLCANCEL-AC03
**권한과 동시 시청:** 요청자가 아니고 편집 권한도 없는 멤버는 만드는 과정을 보지만 `취소`가 없다. 요청자가 취소하면 그 멤버의 화면도 alert 없이 돌아간다.

### UX12-EXPLCANCEL-AC04
**키보드:** `취소`는 초점을 받을 수 있고 Enter로 실행되며, 실행 뒤 초점을 잃지 않는다.

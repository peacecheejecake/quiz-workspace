# RETRY-01 — `다시 풀기`는 마지막 채점 결과가 정답인 문제에만

**상태:** 확정 화면 요구사항 v1.0 · RETRY-CORRECT 신규 2026-11-04 (사용자 요청 "다시풀기 버튼은 정답을 맞춘 문제에만 보이도록", 사용자 결정 2026-11-04 (1)~(3), implementation-plan §7)
**Route:** 별도 route 없음 — `다시 풀기` toggle(`RetryToggle`)을 그리는 모든 곳: 풀이 panel(`practice`)과 범위 풀이(`sequence(bank)`) header. QPLAY-01·QOV-01·QVIEW-01(phase M5.0·QVIEW.0, CI에서 GREEN)의 `다시 풀기` 동작을 바꾸는 새 규칙을 따로 추적한다.
**테스트:** `tests/e2e/questions/retry-correct.spec.ts` (API·DB 규칙은 `tests/integration/questions/test_retry_correct_api_contract.py`, `supabase/tests/21_retry_correct.test.sql`, Vitest)
**Phase:** RETRY.0 (RED) → RETRY-CORRECT (구현 Task가 CI `E2E_PHASES`에 넣는다)
**연계:** [questions.md](../questions.md) §2.1·§16, [QPLAY-01](questions-practice.md), [QOV-01](questions-overview.md), [QVIEW-01](question-viewer.md) C06·C08, [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

```yaml
id: RETRY-01
route: (풀이 panel · 범위 풀이)
actor: workspace_member
permission: practice
status: confirmed
components: [RetryToggle, StudyToggles, QuestionViewer]
linked_tests: [RETRY-01-AC01 … RETRY-01-AC04]
```

## 규칙 (questions.md §16)

- **판정:** 문제의 **마지막 채점 확정 결과가 정답**일 때만 `다시 풀기`를 켤 수 있고 toggle이 보인다. Heatmap의 `정답` 상태(마지막 채점 결과 correct)와 같은 판정이며, 중복 정리로 합쳐진 문제는 합친 상태(questions.md §10.2)로 판정한다. 안 푼 문제·본 문제·틀린 문제·채점 대기만 있는 문제에는 toggle이 없다. 가장 최근 제출이 채점 대기(pending)이면 이전 결과가 정답이어도 자격이 없다 — toggle은 채점될 때까지 숨겨지고(사용자 결정 2026-11-04 D1), 정답으로 채점되면 다시 보이며 오답으로 채점되면 숨겨진 채 플래그가 꺼진다.
- **보이지 않음:** toggle은 비활성이 아니라 **렌더링하지 않는다**(`즐겨찾기` toggle은 그대로). 풀이 panel에서는 정답 제출 직후 나타나고, 이후 제출이 오답이면 사라진다.
- **자동 해제:** 앞으로의 새 채점 결과가 오답이면 `다시 풀기` 플래그가 꺼진다(합쳐진 중복 행 포함). **기존 플래그는 끄지 않는다**(사용자 결정 2026-11-04 변경): 정답이 아닌 문제에 이미 켜진 플래그는 Heatmap `retry` 표시와 `다시 풀기` 필터에 그대로 나오고 toggle만 보이지 않으며, 정답으로 맞힌 뒤에야 toggle로 끌 수 있다. 정답 채점은 플래그를 바꾸지 않는다(questions.md §2.1의 "정답을 맞혔다고 자동 해제하지 않음"은 그대로).
- **API:** `PATCH /questions/{id}/my-state`가 마지막 채점 결과가 정답이 아닌 문제의 `needs_retry: true`를 거절한다 — 409 `retry-requires-correct`. 끄기(`false`)는 늘 허용한다.
- **오래된 화면의 409 (사용자 결정 2026-11-04 D2):** 오래된 화면에서 toggle을 눌러 409 `retry-requires-correct`를 받으면 기존 toggle 실패 알림(error 알림)에 전용 문구 "정답을 맞힌 문제만 다시 풀기로 표시할 수 있습니다."를 보이고, 켠 값은 되돌리며, 문제 상태를 다시 읽어 toggle을 숨긴다(풀이 panel은 overview 조회, 범위 풀이는 위치의 `flags` 다시 읽기).
- `sequence(mock)`·`read-only`·보관 Workspace에는 원래 toggle이 없다.

## 수용 기준

### RETRY-01-AC01

- **Given:** 풀이 panel(`practice`)에서 안 푼 문제를 연 상태
- **When:** 정답을 제출한다
- **Then:** 제출 전에는 `즐겨찾기` toggle만 있고 `다시 풀기` toggle은 DOM에 없다. 정답 제출 직후 `다시 풀기 표시`(`data-state="off"`)가 나타나고 누르면 켜진다(Heatmap marker `retry`). 오답으로 끝난 문제를 열었을 때도 `다시 풀기` toggle은 없다.

### RETRY-01-AC02

- **Given:** 정답으로 끝났고 `다시 풀기`가 켜진 문제를 풀이 panel에서 연 상태
- **When:** `한 번 더 풀기`로 오답을 제출한다
- **Then:** `다시 풀기` toggle이 사라지고, Heatmap marker는 `retry`가 아니라 `incorrect`이며, 서버의 `needs_retry`는 false다. 이어서 정답을 제출하면 toggle이 다시 나타나되 꺼진 상태다.

### RETRY-01-AC03

- **Given:** 범위 풀이(`sequence(bank)`)의 안 푼 문제 위치
- **When:** 정답을 제출한 뒤 `다시 풀기`를 켜고, 다음 문제(안 푼 문제)로 간다
- **Then:** 정답을 제출하기 전에는 toggle이 없고, 제출 직후 나타난다. 켠 값은 서버(`needs_retry`)에 저장되며, 아직 풀지 않은 다음 문제에는 toggle이 없다.

### RETRY-01-AC04

- **Given:** 마지막 채점 결과가 정답이 아닌 문제(안 푼 문제)에 `다시 풀기` 플래그가 이미 켜져 있는 상태(이 규칙 이전 데이터)
- **When:** Heatmap과 `다시 풀기` 필터를 보고 풀이 panel을 열고, 정답을 제출한다
- **Then:** marker는 `retry`로 남고 필터 결과에도 나오지만, 풀이 panel에는 정답 제출 전까지 `다시 풀기` toggle이 없다. 정답 제출 직후 toggle이 켜진 상태(`다시 풀기 해제`)로 나타나 끌 수 있다.

## 계약 (pytest · pgTAP · Vitest)

| ID | 내용 |
|---|---|
| RETRY-01-C01 | **API 거절:** 마지막 채점 결과가 정답이 아니거나 가장 최근 제출이 채점 대기인 문제의 `needs_retry: true` → 409 `retry-requires-correct`(problem type `urn:quiz-workspace:problem:retry-requires-correct`)이고 같은 요청의 다른 flag도 쓰이지 않는다. 요청한 켜기를 판정하므로 이미 켜져 있는 기존 플래그(마지막 결과 정답 아님)도 `{needs_retry: true, …}` 요청은 409다. 정답 뒤에는 200. 끄기는 어떤 상태에서도 200. 보관 Workspace는 그대로 403 `workspace-archived`가 먼저다. |
| RETRY-01-C02 | **자동 해제:** 자동 채점 오답·직접 채점 `incorrect`가 `needs_retry`를 끄고(합쳐진 중복 행 포함, 다른 사용자·다른 문제는 그대로), 정답 채점과 채점 대기 제출은 플래그를 바꾸지 않는다. API가 아닌 어떤 쓰기 경로로 오답을 기록해도 같다(pgTAP trigger). |
| RETRY-01-C03 | **migration은 기존 데이터를 바꾸지 않는다:** `20261104220000_retry_correct_only.sql`은 함수와 trigger만 더하고 기존 `question_user_states` 행을 하나도 바꾸지 않는다(정답이 아닌 문제의 기존 `needs_retry`도 그대로). |
| RETRY-01-C04 | **컴포넌트(Vitest):** `StudyToggles`는 `retryAvailable=false`이면 `RetryToggle`을 렌더링하지 않고, 풀이 panel(`PracticeViewer`)과 범위 풀이는 마지막 채점 결과가 `correct`이고 가장 최근 제출이 채점 대기가 아닐 때만 `retryAvailable`이다. 범위 풀이의 첫 `flags` 조회 응답이 늦게 와도 그 사이 이 panel에서 한 채점을 되돌리지 않는다. 낙관적 상태(`gradedPatch`)는 오답이면 `needs_retry`를 끈다. 409 `retry-requires-correct`는 실패 kind `retryNotAllowed`와 위 전용 문구로 분류되고, 풀이 panel·범위 풀이 모두 그 문구를 알리고 상태를 다시 읽어 toggle을 숨긴다. |

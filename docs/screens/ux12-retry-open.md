# UX12-RETRYOPEN — `다시 풀기` 문제는 풀이 화면부터 열기

**Route:** `/workspaces/:workspaceId?question=<id>`

**Phase:** UX12-RETRYOPEN.0
**테스트:** `tests/e2e/questions/ux12-retry-open.spec.ts`, `tests/integration/questions/test_practice_open.py`, `apps/api/tests/test_practice_open_unit.py`

```yaml
id: UX12-RETRYOPEN
linked_tests: [UX12-RETRYOPEN-AC01 … UX12-RETRYOPEN-AC09]
```

**명세:** [UX12 MOCKUX-5](../implementation/ux12/index.md) (사용자 요청 2026-11-06), [UX12-OPEN](ux12-question-open.md), [QPLAY-01](questions-practice.md), [RETRY-01](retry-correct.md), [questions.md](../questions.md) §4·§17

`다시 풀기` 상태(`needs_retry = true`, 합쳐진 중복까지 합친 상태)인 문제는 이미 풀었더라도 열 때 이전 결과·내 답·정답·해설 없이 풀이 화면부터 보인다.

## 결정

- **서버가 정한다.** `POST /questions/{id}/practice-open`은 플래그가 켜진 문제에 `result`와 `submitted_answer`를 싣지 않고 새 session(또는 재사용 조건에 맞는 캐시 session)을 `session`에 담는다. client가 결과를 숨기지 않는다. 응답 모양은 그대로다.
- **채점 대기는 예외.** 가장 최근 제출이 채점 대기(`pending`)이면 그 제출의 결과와 `맞음`/`틀림`을 그대로 보인다. 지난 결과가 아니라 아직 끝나지 않은 풀이이고, 달리 끝낼 곳이 없다(AC08).
- **같은 열기의 재시도.** 같은 `Idempotency-Key`의 session이 이미 제출됐으면 플래그와 상관없이 그 결과를 준다(UX12-OPEN-AC04). 그 열기에서 사용자가 직접 제출한 결과이기 때문이다.
- **제출 뒤는 그대로.** 제출하면 결과·해설이 평소처럼 보인다. 플래그 규칙은 questions.md §17 그대로다: 정답은 플래그를 두고, 오답은 끈다. 그래서 정답 뒤에 다시 열면 또 풀이 화면이고, 오답 뒤에 다시 열면 결과가 보인다.
- **toggle과 footer.** 깨끗하게 열린 panel의 header toggle은 Heatmap 상태를 읽으므로(`lastGradedResult`) 켜진 채 보이고 바로 끌 수 있다. footer의 `다시 풀기`(`AnotherTryButton`)는 답하는 동안과 같이 사유와 함께 비활성이다. `초기화`는 기록이 있으므로 그대로 보인다. 패널이 열린 채 toggle을 바꿔도 화면은 바뀌지 않고, 다음 열기부터 적용된다.
- **다음 열기에서 바로 적용.** 열기는 그 문제의 toggle 저장이 끝난 뒤에 나간다(`FlagSync.settled`). 저장은 server action 대기열을 지나고 `practice-open`은 지나지 않아, 기다리지 않으면 순서가 뒤바뀔 수 있다. 서버는 캐시 재사용보다 이 열기가 보일 것을 먼저 정한다: 결과를 보일 문제면 캐시 session을 쓰지 않는다. 예외는 `다시 풀기`(`force_new`)로 연 session이다. client가 `cached_another_try`로 알리면 결과보다 앞선다. 그래서 켜진 채 연 깨끗한 session은 플래그를 끄면 버려지고, 한 번 더 풀기는 닫았다 열어도 이어진다.
- **이전 결과를 보는 길.** 풀이 panel은 이전 결과로 가는 링크를 새로 두지 않는다. 지난 결과는 `이력`의 `풀이` 항목(결과 badge)에 남아 있고, attempt는 바뀌지 않는다. `이력` 항목의 문제 링크도 같은 panel을 열기 때문에 풀이 화면이다. toggle을 끄고 다시 열면 최신 결과가 보인다. `문제 정보`/`문제 관리` 메뉴의 `정답·해설 보기`는 사용자가 직접 고르는 별도 dialog로 그대로 둔다.
- **범위 풀이의 기록.** 범위 풀이·모의고사의 위치는 그 run의 기록이다. 제출하지 않은 위치는 원래 풀이 화면이고, 제출한 위치와 끝난 run의 결과 화면은 플래그와 상관없이 제출 결과를 읽기 전용으로 보인다. 모의고사 문제에는 플래그가 없다.
- **`practice-recent`.** web이 쓰지 않는 호환용 조회라 바꾸지 않는다(UX12-OPEN). `GET /practice-sessions/{id}`도 본인이 제출한 session을 읽는 것이라 그대로다.

## 여는 경로

| 경로 | 이전 | 이후 |
|---|---|---|
| Heatmap 셀, `?question=` 링크, 이전/다음 | 최신 결과·해설 | 풀이 화면 |
| `이력`의 풀이 항목 링크 | 최신 결과·해설 | 풀이 화면(목록의 결과 badge는 그대로) |
| 정리 노트 각주 | 최신 결과·해설 | 풀이 화면 |
| 돌아가기 막대 | 최신 결과·해설 | 풀이 화면 |
| 범위 풀이, 제출 안 한 위치 | 풀이 화면 | 그대로 |
| 범위 풀이, 제출한 위치·끝난 run | 제출 결과(읽기 전용) | 그대로 |
| 모의고사 | 플래그 없음 | 그대로 |
| 공유 보기, 문제 상세 | 정답·해설 표시(풀이 아님) | 그대로 |

## 수용 기준

### UX12-RETRYOPEN-AC01

- **Given:** 정답으로 푼 뒤 `다시 풀기`를 켠 문제
- **When:** Heatmap 셀로 연다
- **Then:** 응답에 `result`가 없고 보기는 아무것도 선택되지 않았으며 결과·해설이 없다. `제출`은 답을 고르기 전까지 비활성이고, toggle은 켜진 채(`다시 풀기 해제`) 보이며 footer의 `다시 풀기`는 `aria-disabled`다.

### UX12-RETRYOPEN-AC02

- **Given:** AC01처럼 열린 panel
- **When:** 정답을 제출하고 닫았다가 다시 연다
- **Then:** 제출 직후 결과와 해설이 보인다. 플래그는 그대로이고(Heatmap `retry`) attempt는 2건이며, 다시 열면 또 풀이 화면이다.

### UX12-RETRYOPEN-AC03

- **Given:** AC01처럼 열린 panel
- **When:** 오답을 제출하고 닫았다가 다시 연다
- **Then:** 플래그가 꺼지고(§17) 다시 열면 오답 결과와 해설이 보인다.

### UX12-RETRYOPEN-AC04

- **Given:** AC01처럼 열린 panel, 그리고 `다시 풀기`가 꺼진 푼 문제
- **When:** toggle을 끄고 곧바로 닫았다가 새로 고침 없이 다시 열고, 꺼진 문제를 연다
- **Then:** 두 문제 모두 지금까지처럼 최신 결과와 해설이 보인다.

### UX12-RETRYOPEN-AC05

- **Given:** `이력`에 풀이 항목이 있는 `다시 풀기` 문제
- **When:** `이력`을 열고 그 항목의 문제 링크를 누른다
- **Then:** 목록에는 이전 결과 badge가 보이고, 열린 panel은 풀이 화면이다.

### UX12-RETRYOPEN-AC06

- **Given:** 정리 노트 각주가 가리키는 `다시 풀기` 문제
- **When:** 각주를 누른다
- **Then:** 노트 위에 열린 panel은 풀이 화면이고 결과·해설이 없다.

### UX12-RETRYOPEN-AC07

- **Given:** `다시 풀기` 문제가 들어 있는 범위 풀이
- **When:** 그 위치를 풀고 다음 문제로 갔다가 `이전 문제`로 돌아온다
- **Then:** 처음에는 풀이 화면이고, 제출 뒤 돌아온 위치는 플래그가 켜져 있어도 제출 결과를 읽기 전용으로 보인다.

### UX12-RETRYOPEN-AC08

- **Given:** `다시 풀기`가 켜진 서술형 문제에 새 답을 제출해 채점 대기인 상태
- **When:** panel을 닫았다가 다시 연다
- **Then:** 채점 대기 결과와 `맞음`/`틀림`이 보인다. `맞음`으로 채점하고 다시 열면 풀이 화면이다.

### UX12-RETRYOPEN-AC09

**API 계약(pytest):** 플래그가 켜진 문제의 `practice-open` 응답은 `result`·`submitted_answer`가 없고 정답·해설 필드도 없으며 새 session을 연다(열람 기록 포함). 플래그가 켜져 있고 재사용 조건이 맞으면 그 session을 재사용한다. 플래그를 끈 뒤에는 캐시 session을 보내도 결과를 준다. `force_new`로 연 session은 `cached_another_try`와 함께 보낼 때만 결과보다 앞선다. 다른 사용자의 플래그는 영향을 주지 않는다. 합쳐진 중복에 켜진 플래그는 남길 문제에도 적용된다. 이미 제출한 열기의 key를 다시 보내면 그 결과를 준다. 채점 대기는 결과를 준다. attempt 행은 바뀌지 않는다. DB 왕복은 UX12-OPEN의 예산을 넘지 않는다.

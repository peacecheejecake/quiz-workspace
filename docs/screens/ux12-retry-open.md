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

- **MOCKUX-11 개정.** 이 동작은 모든 푼 문제로 넓어졌고([UX12-SOLVEDOPEN](ux12-solved-open.md)), 표시는 더 이상 열기를 정하지 않는다. 아래는 표시가 켜진 문제에서 지금도 맞는 내용이다.
- **채점 대기는 예외.** 가장 최근 제출이 채점 대기(`pending`)이면 그 제출의 결과와 `맞음`/`틀림`을 그대로 보인다(AC08).
- **제출 뒤는 그대로.** 제출하면 결과·해설이 평소처럼 보인다. 플래그 규칙은 questions.md §17 그대로다: 정답은 플래그를 두고, 오답은 끈다. 어느 쪽이든 다시 열면 풀이 화면이다.
- **toggle과 footer.** 깨끗하게 열린 panel의 header toggle은 Heatmap 상태를 읽으므로(`lastGradedResult`) 켜진 채 보이고 바로 끌 수 있다. footer의 `다시 풀기`(`AnotherTryButton`)는 답하는 동안과 같이 사유와 함께 비활성이다. `초기화`는 기록이 있으므로 그대로 보인다.
- **범위 풀이의 기록.** 범위 풀이·모의고사의 위치는 그 run의 기록이다. 제출하지 않은 위치는 원래 풀이 화면이고, 제출한 위치와 끝난 run의 결과 화면은 플래그와 상관없이 제출 결과를 읽기 전용으로 보인다. 모의고사 문제에는 플래그가 없다.

## 여는 경로

| 경로 | 이전 | 이후 |
|---|---|---|
| Heatmap 셀, `?question=` 링크 | 최신 결과·해설 | 풀이 화면 |
| 이전/다음 | 최신 결과·해설 | 풀이 화면(이번 열기에서 풀거나 본 문제는 결과, UX12-SOLVEDOPEN-AC07) |
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
- **Then:** 플래그가 꺼지고(§17) 다시 열면 풀이 화면이며, 오답 결과와 해설은 `해설 보기`로 보인다.

### UX12-RETRYOPEN-AC04

- **Given:** AC01처럼 열린 panel
- **When:** toggle을 끄고 닫았다가 다시 연다
- **Then:** 표시를 꺼도 풀이 화면이고, 결과와 해설은 `해설 보기`로 보인다.

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

**API 계약(pytest):** `practice-open`의 응답은 표시가 켜져 있든 꺼져 있든 같다: `result`·정답·해설 없이 session을 준다. 표시를 바꿔도 달라지지 않는다.

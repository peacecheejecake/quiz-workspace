# UX12-SOLVEDOPEN — 푼 문제도 문제부터, `해설 보기`로 이전 결과

**Route:** `/workspaces/:workspaceId?question=<id>`

**Phase:** UX12-SOLVEDOPEN.0
**테스트:** `tests/e2e/questions/ux12-solved-open.spec.ts`, `tests/integration/questions/test_practice_open.py`, `apps/api/tests/test_practice_open_unit.py`, `apps/web/test/practice-cache.test.tsx`

```yaml
id: UX12-SOLVEDOPEN
linked_tests: [UX12-SOLVEDOPEN-AC01 … UX12-SOLVEDOPEN-AC09]
```

**명세:** [UX12 MOCKUX-11](../implementation/ux12/index.md) (사용자 요청 2026-11-06), [UX12-RETRYOPEN](ux12-retry-open.md)(범위를 모든 푼 문제로 넓힘), [UX12-OPEN](ux12-question-open.md), [QPLAY-01](questions-practice.md), [questions.md](../questions.md) §4

이전에 푼 문제는 `다시 풀기` 표시와 상관없이 문제부터 보인다. 이전 결과·내 답·정답·해설은 여는 응답에 없고, 하단의 `해설 보기`를 눌러야 서버에서 받는다.

## 결정

- **열기.** `POST /questions/{id}/practice-open`은 푼 문제에도 새 session(또는 재사용 조건에 맞는 캐시 session)을 주고 `result`·`submitted_answer`를 싣지 않는다. 푼 문제의 열기는 안 푼 문제처럼 열람을 기록하고 session을 만든다. `force_new`는 지웠다: 열기가 늘 새 풀이이므로 필요가 없다.
- **채점 대기는 예외.** 가장 최근 제출이 채점 대기(`pending`)이면 그 결과와 `맞음`/`틀림`을 그대로 준다. 달리 끝낼 곳이 없기 때문이다(MOCKUX-5와 같다).
- **`해설 보기` 표시.** 응답의 `latest_attempt_id`가 있고 `previous_revision`이 아닐 때만 보인다. 안 푼 문제에는 없고, 지난 revision에서만 푼 문제도 없다(기존 "이전 풀이 이력 보기" 안내). 합쳐진 중복의 제출은 지금처럼 그 문제의 session 기준이다.
- **`해설 보기`는 읽기가 아니라 쓰기다.** `practice-recent`는 session을 닫을 수 없어 쓰지 않는다. `POST /questions/{id}/practice-reveal`(권한 `practice`, 보기 권한 포함, 보관 Workspace 403)이 한 트랜잭션에서 최신 제출을 돌려주고 본인의 열린 session을 닫는다. 이 revision에 제출이 없으면 404이고 아무것도 닫지 않는다. 다시 불러도 결과는 같다.
- **본 답으로 채점되지 않게.** 공개되면 본인의 그 문제 열린 session(범위 풀이 session 제외)은 모두 닫힌다. 닫힌 session에 제출하면 409 `practice-session-reset`이다. 새 상태 값은 migration이 필요하므로 만들지 않고 `reset_epoch`를 어떤 epoch에도 속하지 않는 값(-1)으로 바꾼다. `다시 풀기`나 다음 열기는 새 session을 연다. 그 뒤의 풀이는 답을 본 사용자의 일반 attempt이고, attempt는 바뀌지 않는다. 구성원은 원래 `정답·해설 보기`로 답을 읽을 수 있으므로(QPLAY-01-AC09) 이것은 공개 경로 하나를 막는 규칙이지 답을 완전히 숨기는 규칙이 아니다. `GET practice-recent`도 그대로 남아 있다.
- **누른 뒤의 화면.** 기존 결과 화면(읽기 전용)으로 바뀌고 focus는 결과로 간다. 답하던 화면으로 돌아가는 길은 없고, footer의 `다시 풀기`가 새 session을 연다.
- **쓰던 답.** 답을 고르거나 쓴 뒤 누르면 확인 dialog가 먼저 뜬다. 취소하면 답이 그대로이고, 확인하면 답은 제출되지 않고 사라진다. 답이 없으면 바로 연다.
- **같은 열기 안의 이전/다음.** 패널을 한 번 연 동안 화면에 보인 것은 client가 메모리에 둔다(`OpeningViews`): 문제 내용과, 이번 열기에서 제출했거나 `해설 보기`로 본 결과. 이전/다음으로 돌아오면 불러오는 표시 없이 바로 그것을 그린다. 패널을 닫으면 모두 잊고, 브라우저 저장소에는 쓰지 않는다. 이 열기가 이미 보인 결과만 들어 있으므로 새로 드러나는 답은 없다. 결과는 요청 없이 그대로 보인다. 다른 탭의 제출은 이 패널을 닫을 때까지 반영되지 않는다. 안 푼 문제는 session을 조용히 확인한다(`practice-open`, 재사용이면 쓰는 것 없음). 확인 전에도 답을 고를 수 있지만 `제출`은 확인 뒤에만 된다. 확인 결과 session이 다르면(다른 곳의 제출·수정) 그 session으로 바뀌고 고른 답은 비워진다. `다시 풀기`를 누르거나, 초기화하거나, 문제가 수정되면 그 문제는 빠진다.
- **같은 재시도(key).** 이미 제출된 session의 `Idempotency-Key`가 다시 오면 409 `practice-session-submitted`다. 열기 응답에는 결과를 싣지 않으므로 UX12-OPEN의 "결과를 준다"를 바꾼다.
- **`다시 풀기` 표시.** 열기를 정하지 않는다. 필터와 Heatmap 표시의 뜻은 그대로다. MOCKUX-5의 `flagsSettled`·`cached_another_try`와 `latest_outcome`의 `needs_retry`는 지웠다.
- **범위 풀이·모의고사.** 각자의 기록대로이고 바뀌지 않는다. `해설 보기`는 풀이 panel(`practice`)에만 있다.

## 여는 경로

| 경로 | 이전 | 이후 |
|---|---|---|
| Heatmap 셀, `?question=` 링크 | 최신 결과·해설 | 문제부터, `해설 보기` |
| 이전/다음, 이번 열기에서 풀거나 본 문제 | 최신 결과·해설 | 결과·해설 |
| 이전/다음, 그 밖의 푼 문제 | 최신 결과·해설 | 문제부터, `해설 보기` |
| `이력`의 풀이 항목 링크 | 최신 결과·해설 | 문제부터, `해설 보기`(목록의 결과 badge는 그대로) |
| 정리 노트 각주 | 최신 결과·해설 | 문제부터, `해설 보기` |
| 돌아가기 막대 | 최신 결과·해설 | 문제부터, `해설 보기` |
| 채점 대기인 문제 | 채점 대기 결과 | 그대로 |
| 안 푼 문제 | 풀이 화면 | 그대로(`해설 보기` 없음) |
| 범위 풀이·모의고사 | 각자의 기록 | 그대로 |
| 공유 보기, 문제 상세 | 정답·해설 표시(풀이 아님) | 그대로 |

## 수용 기준

### UX12-SOLVEDOPEN-AC01

- **Given:** 정답으로 푼 문제와 오답으로 푼 문제(`다시 풀기` 표시 없음)
- **When:** Heatmap 셀로 연다
- **Then:** `practice-open` 응답에 `result`·`submitted_answer`·해설이 없고, 보기는 선택되지 않았으며 결과·해설이 없다. 하단에 `해설 보기`가 있고 footer의 `다시 풀기`는 `aria-disabled`다.

### UX12-SOLVEDOPEN-AC02

- **Given:** 한 번도 풀지 않은 문제
- **When:** 연다
- **Then:** `해설 보기`가 없다.

### UX12-SOLVEDOPEN-AC03

- **Given:** 오답으로 푼 문제를 연 panel
- **When:** `해설 보기`를 누르고, 이어서 `다시 풀기`로 풀어 제출한다
- **Then:** 이전 결과·해설·내 답이 읽기 전용으로 보이고 `제출`과 `해설 보기`가 없으며 attempt는 그대로다. `다시 풀기`는 빈 풀이 화면을 열고, 제출하면 attempt가 하나 는다.

### UX12-SOLVEDOPEN-AC04

- **Given:** 푼 문제를 연 panel에서 답을 고른 상태
- **When:** `해설 보기`를 누르고 취소한 뒤, 다시 눌러 확인한다
- **Then:** 취소하면 고른 답이 그대로이고 해설이 없다. 확인하면 이전 결과가 보이고 고른 답은 제출되지 않는다.

### UX12-SOLVEDOPEN-AC05

- **Given:** 푼 문제를 연 panel의 session
- **When:** `해설 보기`를 누른 뒤 그 session으로 제출을 보낸다
- **Then:** 409이고 attempt가 늘지 않는다.

### UX12-SOLVEDOPEN-AC06

- **Given:** `다시 풀기` 표시 없는 푼 문제
- **When:** `이력`의 풀이 항목 링크로 열고, 돌아가기 막대로 다시 연다
- **Then:** `이력` 목록에는 결과 badge가 보이고, 두 경로 모두 문제부터 보이며 `해설 보기`가 있다.

### UX12-SOLVEDOPEN-AC07

- **Given:** 문제 3개, 3번은 전에 풀었다
- **When:** 같은 panel에서 1번을 풀고 다음으로 갔다가 이전으로 돌아오고, 3번을 `해설 보기`로 보고 2번에 갔다가 돌아온 뒤, 패널을 닫고 1번과 3번을 다시 연다
- **Then:** 돌아온 1번과 3번은 결과와 해설부터 보이고, 안 푼 2번은 풀이 화면이다. 닫은 뒤 새로 열면 둘 다 문제부터 보인다.

### UX12-SOLVEDOPEN-AC09

- **Given:** 같은 panel에서 안 푼 1번을 보고, 2번을 풀고, 3번까지 간 상태. 서버의 열기 응답이 늦다
- **When:** 이전으로 2번, 1번에 돌아온다
- **Then:** 2번은 결과·해설이, 1번은 문제와 보기가 바로 보이고 불러오는 표시(글자, `aria-busy`)가 없다. 응답이 오면 1번을 그대로 풀어 제출할 수 있다.

### UX12-SOLVEDOPEN-AC08

**API 계약(pytest):** 푼 문제의 `practice-open` 응답에는 결과가 맞든 틀리든 답 필드가 없고 새 session을 열며 attempt가 바뀌지 않는다. 캐시 session은 재사용한다. 채점 대기는 결과를 준다. 제출된 key는 409다. `practice-reveal`은 최신 제출을 돌려주고 본인의 열린 session을 닫으며(이후 제출 409, 재사용 안 됨) 범위 풀이 session은 건드리지 않는다. 제출 없는 사용자·지난 revision만 있는 문제는 404이고 아무것도 닫지 않는다. 다른 Workspace 사용자는 404, 보관 Workspace는 403이다. 다른 사용자의 결과는 읽을 수 없다. DB 왕복은 UX12-OPEN 예산 안이다.

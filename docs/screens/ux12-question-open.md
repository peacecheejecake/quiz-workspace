# UX12-OPEN — 문제 열기 속도

**Route:** `/workspaces/:workspaceId?question=<id>`

**Phase:** UX12-OPEN.0
**테스트:** `tests/e2e/questions/ux12-question-open.spec.ts`, `tests/integration/questions/test_practice_open.py`

```yaml
id: UX12-OPEN
linked_tests: [UX12-OPEN-AC01 … UX12-OPEN-AC08]
```

**명세:** [UX12 VIEW-5](../implementation/ux12/index.md), [UX10-QVIEW](../implementation/ux10/qview.md)(캐시 정합성 결정을 개정), [QPLAY-01](questions-practice.md)

## 원인과 결정

문제 패널을 열 때마다 server action 두 개가 직렬로 돌았다. `practice-recent`로 reset epoch·최신 결과를 확인하고, 이어서 `practice-sessions`로 session을 열었다. 둘 다 proxy와 Next의 server action 대기열을 지나고, 두 번째 요청이 인가·잠금·epoch 조회를 처음부터 되풀이했다.

**결정:** `POST /api/v1/questions/{id}/practice-open` 하나로 합친다. 한 트랜잭션에서 epoch를 잠그고, 최신 결과를 확인하고, 캐시된 session을 재사용하거나 새 session을 연다. web은 이 호출을 route handler `/api/questions/{id}/practice-open`으로 보내 server action 대기열을 지나지 않는다. 다른 server action이 진행 중이어도 문제 열기가 줄을 서지 않는다.

UX10의 "서버 metadata를 먼저 확인한다"는 보장은 그대로이며, 확인과 열기가 한 호출 안으로 들어온다. 캐시된 session도 응답을 받기 전에는 답을 입력할 수 없다.

- **재사용 조건(서버 판정):** `cached_session_id`가 본인의 이 문제 session이고, 범위 풀이 session이 아니며, `open` 상태이고, 현재 epoch·현재 revision이며, `baseline_attempt_id`가 최신 attempt와 같을 때만 재사용한다. 이 조건 중 하나라도 어긋나면 UX10과 같은 순서로 판단한다. 결과가 있으면 결과를, 없으면 새 session을 준다.
- **응답 분리:** 미제출 session은 `session`(`PracticeSession`, 답 필드 없음), 제출한 결과는 `result`(`PracticeSessionDetail`)에 담는다. 정답·해설은 `result.outcome`에만 있다.
- **멱등성:** `Idempotency-Key`는 새 session을 열 때만 저장한다. 같은 key가 다시 오면 그 session이 아직 `open`일 때 응답을 재생한다. 이미 제출됐으면 결과를 준다. 같은 사용자·문제의 reset 잠금이 요청을 직렬화하므로 별도 key 잠금은 두지 않는다.
- **`practice-recent`·`expected_reset_epoch`:** web은 더 쓰지 않는다. epoch를 읽는 시점과 여는 시점 사이의 틈이 없어졌기 때문이다. 다른 탭의 reset이 먼저 커밋되고 그 뒤에 도착한 열기는 새 열기로 처리된다. 잠금을 기다리던 열기는 지금처럼 409 `practice-session-reset`이다. API endpoint 자체는 호환을 위해 유지한다.
- **Server-Timing:** 이 route들의 응답에 `db`(시간, statement 수)와 `app`이 붙는다. BFF는 `bff`를 더해 그대로 전달한다. client는 `practice-open` performance measure를 남긴다. 어느 쪽에도 id나 내용은 없다.

## 측정

**DB 왕복(결정적, `tests/integration/questions/test_round_trips.py`가 고정):**

| 경우 | 개선 전 | 개선 후 |
|---|---:|---:|
| 처음 여는 문제 | 19 (`practice-recent` 9 + `practice-sessions` 10) | 10 |
| 안 풀고 다시 여는 문제(캐시) | 9 | 8 |
| 풀었던 문제 | 9 | 7 |
| 열기당 POST | 2 | 1 |

**체감 시간(client `practice-open` measure, ms):** Playwright Chromium, `next start`, 문제 8개의 median, 같은 Mac. RTT 10 ms는 TCP 지연 proxy로 넣었다.

| 경우 | 전 RTT 0 | 전 RTT 10 ms | 후 RTT 0 | 후 RTT 10 ms |
|---|---:|---:|---:|---:|
| 처음 여는 문제 | 49 | 258 | 63 | 235 |
| 캐시 재사용 | 33 | 109 | 45 | 173 |
| 풀었던 문제 | 30 | 132 | 52 | 156 |

**이 표로 전후를 비교하면 안 된다.** "후"는 다른 Task가 병렬로 돌아 load average 37 이상일 때 쟀다. 코드가 바뀌지 않은 `submit`의 API median도 같은 시점에 RTT 0에서 11 → 37 ms, RTT 10 ms에서 86 → 102 ms로 늘었다. "후"는 결과 조회를 한 statement로 합치기 전 측정이기도 하다. 조용한 환경에서 두 build를 번갈아 다시 재야 하며, 아직 하지 못했다(UX12-OPEN 후속).

"전" 측정에서 RTT 0과 10 ms의 차이가 왕복 수에 비례하므로 병목은 DB 왕복 수다. 개선 효과의 근거는 현재 위 왕복 수이며, 체감 시간 단축은 아직 확인되지 않았다.

**알려진 동작 변화:** 예전에는 `practice-recent`가 도는 동안 panel을 닫으면 session이 열리지 않았다. 이제 요청이 나간 뒤에는 서버가 열람을 기록한다. 응답은 client가 버린다. reset이 panel을 닫는 경우는 client가 다시 열기를 보내지 않는다(UX10-QVIEW-AC04). 이전/다음 이동은 약 150 ms 뒤에 요청을 보내므로 빠르게 지나간 문제는 열람으로 남지 않는다(UX12-OPEN-AC08).

## 수용 기준

### UX12-OPEN-AC01

Heatmap에서 처음 여는 문제는 `POST /api/questions/{id}/practice-open` 한 번으로 열린다. 페이지로 가는 server action POST도, `practice-sessions` 호출도 없다. 보기는 원본 순서이고, 응답에는 정답·해설 필드가 없으며, Heatmap은 열람 상태가 된다.

### UX12-OPEN-AC02

제출한 문제를 다시 열면 같은 한 번의 호출로 본인의 결과·정답·해설이 보이고 새 session이 생기지 않는다. `다시 풀기`는 호출 한 번으로 새 미제출 session을 연다.

### UX12-OPEN-AC03

안 풀고 닫은 문제를 다시 열면 호출은 한 번이고 같은 session을 재사용한다. 그 사이 다른 곳에서 제출했으면 캐시를 쓰지 않고 그 결과를 보인다(UX10 "metadata first").

### UX12-OPEN-AC04

`practice-open`은 멱등이다. 같은 `Idempotency-Key`의 재전송과 동시 요청은 session 하나만 연다. key가 다시 와도 제출된 session을 미제출로 되살리지 않는다. 그 사이 문제가 수정되어 보여 줄 결과가 없으면 새 session을 열지 않고 409 `practice-session-submitted`를 돌려준다(새 key로 다시 연다). 재사용 조건이 하나라도 어긋난 `cached_session_id`(남의 session, 지난 revision, 제출됨, 범위 풀이, 새 attempt가 생김)는 재사용되지 않는다.

### UX12-OPEN-AC05

미제출 응답에는 어떤 위치에도 정답·해설·채점 기준 필드가 없고 OpenAPI schema의 `session`도 그렇다. 남의 session id를 보내도 내용이 나오지 않는다. 다른 Workspace 사용자는 404, 보관 Workspace는 403이다.

### UX12-OPEN-AC06

`practice-open`은 reset·submit과 같은 잠금으로 직렬화된다. reset 뒤에 캐시된 session은 재사용되지 않고 새 epoch의 session이 열린다. reset 잠금을 기다린 열기는 409 `practice-session-reset`이고 Heatmap을 되살리지 않는다. 이전 session의 제출은 reset 뒤에 거절된다(UX10-QVIEW-AC05).

### UX12-OPEN-AC07

DB 왕복 상한은 처음 열기 10, 캐시 재사용 8, 결과 다시 열기 7이다. 이전에는 각각 19, 9, 9였다. 응답의 `Server-Timing`에는 `db`와 `app` 시간만 있다.

### UX12-OPEN-AC08

이전/다음으로 도착한 문제는 약 150 ms 머문 뒤에 `practice-open`을 보낸다. 그 안에 다시 이동하거나 panel을 닫으면 요청을 보내지 않으므로 지나간 문제는 열람으로 남지 않는다. Heatmap이나 deep link로 직접 여는 경우, 다시 풀기, 다시 시도는 기다리지 않는다.

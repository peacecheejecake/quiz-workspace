# UX12-RETRYINPLACE — 풀이 패널의 제자리 `다시 풀기`

**Route:** `/workspaces/:workspaceId?practice=<run>&i=<k>`, `?panel=mock-exams&practice=<run>&i=<k>`

**Phase:** UX12-RETRYINPLACE.0
**테스트:** `tests/e2e/questions/ux12-retry-in-place.spec.ts`, `tests/integration/questions/practice_runs/test_practice_runs_contract.py`, `apps/web/test/ux12-retry-in-place.test.tsx`, `apps/api/tests/test_practice_runs_unit.py`, `supabase/tests/37_run_position_retry.test.sql`

```yaml
id: UX12-RETRYINPLACE
linked_tests: [UX12-RETRYINPLACE-AC01 … UX12-RETRYINPLACE-AC06]
```

**명세:** [UX12 MOCKUX-15](../implementation/ux12/index.md) (사용자 요청 2026-11-06), [QVIEW-01](question-viewer.md), [UX12-RESUME](ux12-run-resume.md), [UX12-MOCKSHUFFLE](ux12-mock-shuffle.md), [UX11-RETURN](ux11-return.md)

범위 풀이 패널의 `다시 풀기`는 새 패널을 열지 않는다. 지금 위치가 같은 패널에서 풀이 상태로 바뀐다. QVIEW-01의 "한 묶음에서 문제마다 제출은 한 번"과 UX11-RETURN-AC01·AC02의 별도 연습을 이 문서가 바꾼다. 요청은 모의고사 풀이를 말했지만 footer를 함께 쓰므로 `sequence(bank)`와 `sequence(mock)`에 같이 적용한다. Heatmap 셀로 연 풀이 panel(`practice`)은 그대로다.

## 결정

- **제자리 풀이.** 결과가 확정된 위치에서 `다시 풀기`를 누르면 그 위치의 문제와 보기가 선택 없이 보이고 결과, 정답, 해설은 보이지 않는다. `제출`이 채점한다. focus는 패널 제목으로 간다. URL과 위치는 그대로다.
- **서버 상태.** 끝나지 않은 묶음은 서버가 위치를 되돌린다. `POST /practice-runs/{id}/items/{position}/reopen`이 이전 session에 `superseded_at`을 찍고, 그 위치를 여는 다음 요청이 새 session을 만든다. session의 묶음 연결은 바뀌지 않는다(`*_run_immutable`). 위치마다 살아 있는 session은 하나다. 그래서 새로 고침, `이전 문제`로 돌아오기, 다른 기기에서 열기 모두 풀이 상태를 보인다.
- **응답.** `reopen`은 204이고 본문이 없다. 그다음 위치 읽기와 session 열기는 제출 전 위치와 같아서 정답, 해설, 이전 답이 없다.
- **보기 순서.** `보기 섞기` 묶음은 다시 풀 때마다 새 seed를 뽑는다(UX12-MOCKSHUFFLE의 `다시 풀기` 규칙). 처음 여는 위치는 묶음 seed 그대로다. 채점은 언제나 보기 id로 한다.
- **기록.** 이전 시도는 그대로 남는다. `question_attempts`, `mock_exam_attempts`는 고치지 않고, 묶음의 위치와 집계만 살아 있는 session을 본다. 모의고사 문제의 시도는 `question_attempts`와 `question_user_states`에 닿지 않는다.
- **집계.** 위치의 결과는 살아 있는 session의 결과다. 다시 제출하면 마지막 제출이 그 위치의 결과를 대신한다. 눌러 놓고 제출하지 않은 위치는 안 푼 위치로 돌아간다. 진행 수에서 빠지고, `이어 풀기`는 그 위치부터 열며, `결과 보기`까지 제출하지 않으면 `건너뜀`이다.
- **언제 못 하나.** 결과가 확정되기 전(`채점 대기` 포함)에는 지금처럼 비활성이고 서버는 `채점 대기`에 409 `already-submitted`다. 확정된 session이 없는 위치는 아무것도 바꾸지 않아 다시 불러도 안전하다.
- **끝난 묶음.** `finished_at`이 있는 묶음의 기록은 바뀌지 않는다. 묶음을 다시 열지 않고 요약도 그대로다. `다시 풀기`는 같은 패널에서 묶음에 연결되지 않은 연습 session으로 풀게 하고(기존 `retry-session`, 건너뛴 위치 포함), 채점 결과는 그 자리에만 보인다. 묶음에 남지 않으므로 새로 고침하면 묶음 기록으로 돌아온다.
- **닫기.** 끝나지 않은 묶음에서 `다시 풀기`를 누르면 위치가 다시 열리므로 [UX12-RUNCLOSE](ux12-run-close.md)의 확인을 묻는다.

## API

| Method | Path | 내용 |
|---|---|---|
| POST | `/practice-runs/{id}/items/{position}/reopen` | 묶음 주인. 끝나지 않은 묶음의 확정된 위치를 되돌린다. 204. `채점 대기`는 409 `already-submitted`, 초기화된 session은 409 `practice-session-reset`, 끝난 묶음은 409 `practice-run-finished`, 남의 묶음은 404, 보관된 Workspace는 403 |
| POST | `/practice-runs/{id}/items/{position}/retry-session` | 그대로다. 끝난 묶음의 `다시 풀기`가 쓴다 |

| ID | 계약 |
|---|---|
| UX12-RETRYINPLACE-C01 | 끝나지 않은 묶음의 확정 위치를 되돌리면 `answered`가 하나 줄고, item의 `attempt`가 null이며 응답에 정답이 없다. 다시 제출하면 결과가 위치에 들어가고 이전 attempt는 그대로 남는다 |
| UX12-RETRYINPLACE-C02 | 끝난 묶음의 `reopen`은 409이고 `finished_at`, `summary`, 위치의 결과는 그대로다 |
| UX12-RETRYINPLACE-C03 | 모의고사 묶음의 다시 풀기는 `mock_exam_attempts`만 늘리고 `question_attempts`는 그대로다 |
| UX12-RETRYINPLACE-C04 | `superseded_at`은 묶음에 연결되고 `graded`인 session에만 한 번 찍히며 되돌릴 수 없다. 위치마다 `superseded_at`이 없는 session은 하나뿐이다(pgTAP) |

## 수용 기준

### UX12-RETRYINPLACE-AC01

- **Given:** 끝나지 않은 모의고사 풀이에서 2번 위치를 제출해 결과가 보인다
- **When:** `다시 풀기`를 누른다
- **Then:** 새 dialog 없이 같은 패널의 같은 위치에 문제와 보기가 선택 없이 보이고 결과와 해설은 없다. focus는 패널 제목이다.

### UX12-RETRYINPLACE-AC02

- **Given:** AC01의 위치
- **When:** 다른 보기를 골라 `제출`하고 `결과 보기`로 간다
- **Then:** 위치의 결과와 요약이 새 제출을 따른다. 이전 시도는 기록에 남고 `question_attempts`는 늘지 않는다.

### UX12-RETRYINPLACE-AC03

- **Given:** AC01의 위치
- **When:** 새로 고침한다. `다음 문제`로 갔다가 `이전 문제`로 돌아온다
- **Then:** 두 경우 모두 풀이 상태이며 이전 결과는 보이지 않는다.

### UX12-RETRYINPLACE-AC04

- **Given:** 원본 풀이에서 `다시 풀기`를 누르고 제출하지 않은 채 닫기 확인의 `닫기`를 눌렀다
- **When:** 모의고사 목록을 연다
- **Then:** 진행 수는 그 위치를 빼고, `이어 풀기`는 그 위치를 연다.

### UX12-RETRYINPLACE-AC05

- **Given:** `보기 섞기` 모의고사 풀이의 제출한 위치
- **When:** `다시 풀기`를 여러 번 되풀이한다
- **Then:** 보기 순서가 새로 뽑히고, 제출은 표시 순서가 아니라 보기 id로 채점된다.

### UX12-RETRYINPLACE-AC06

- **Given:** `결과 보기`로 끝난 묶음의 위치
- **When:** `다시 풀기`를 눌러 제출한다
- **Then:** 같은 패널에서 풀고 결과를 보지만 `풀이 결과`의 요약과 위치의 결과는 그대로다. 새로 고침하면 묶음 기록이 보인다.

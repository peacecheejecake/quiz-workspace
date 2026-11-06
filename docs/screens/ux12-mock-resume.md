# UX12-MOCKRESUME — 저장된 모의고사 이어 풀기

**Route:** `/workspaces/:workspaceId?panel=mock-exams[&mock=<id>]` → `...&practice=<run>&i=<k>`

**Phase:** UX12-MOCKRESUME.0
**테스트:** `tests/e2e/questions/ux12-mock-resume.spec.ts`, `tests/integration/questions/practice_runs/test_practice_runs_contract.py`, `apps/web/test/ux12-mock-resume.test.tsx`, `apps/api/tests/test_practice_runs_unit.py`

```yaml
id: UX12-MOCKRESUME
linked_tests: [UX12-MOCKRESUME-AC01 … UX12-MOCKRESUME-AC08]
```

**명세:** [UX12 MOCKUX-12](../implementation/ux12/index.md) (사용자 요청 2026-11-06), [UX12-RESUME](ux12-run-resume.md), [MOCK-01](mock-exams.md), [UX12-MOCKNAV](ux12-mock-nav.md), [UX12-MOCKSHUFFLE](ux12-mock-shuffle.md), [QVIEW-01](question-viewer.md)

[UX12-RESUME](ux12-run-resume.md)는 원본 풀이만 다룬다. 저장된 모의고사를 풀다가 닫으면 이제 그 모의고사의 행과 상세에서 `이어 풀기`로 다음 미제출 문제부터 계속한다.

## 결정

- **어떤 풀이.** 호출자 본인의, 그 모의고사의 지금 회차(`current_generation_id`)로 시작한, 끝나지 않은 풀이 가운데 마지막으로 만진 것 하나다. 끝나지 않았다는 말은 `finished_at`이 없고 지우지 않았으며 이어 풀 위치가 남았다는 뜻이다. 마지막으로 만진 시각은 UX12-RESUME과 같다.
- **이어 풀 위치.** 묶음 순서에서 가장 앞의, 모의고사에서 빠지지 않았고(`removed_at`) 제출하지 않은 위치다. 진행 `3/10`의 앞 수는 빠지지 않은 위치의 제출 수, 뒤 수는 묶음 위치 수(풀이 패널의 분모)다. 모의고사 풀이에는 초기화가 없다.
- **다시 만들기.** 회차가 바뀌면 이전 회차의 풀이는 `이어 풀기`로 보이지 않는다. 지금 보이는 문제와 다른 문제를 이어 푸는 일이 없도록 한 결정이다. 그 풀이는 시작할 때의 문제로 남아 URL로 열린다(decision n). 새 회차가 준비되어 `current_generation_id`가 바뀌기 전까지는 이전 풀이를 그대로 이어 풀 수 있다.
- **빠진 문제.** 그 위치만 건너뛴다(QVIEW-01-C07의 건너뜀). 남은 위치가 없으면 `이어 풀기`도 없다. 삭제된 모의고사는 행도 상세도 없으므로 아무것도 보이지 않는다.
- **버튼 배치.** MOCKUX-2 규칙대로 보이는 버튼은 하나다. 이어 풀 풀이가 있으면 목록 행과 상세 모두 `이어 풀기 3/10`이 primary이고, `풀기`는 행 메뉴와 `더보기`의 첫 항목으로 간다. 없으면 지금과 같이 `풀기`가 보인다. 목록과 상세가 같은 규칙이라 행이 깔끔하고 진행은 버튼 안에 있어 줄이 늘지 않는다. `풀기`는 지금처럼 범위 고르기부터 새 풀이를 시작하며 이전 풀이를 바꾸지 않는다.
- **메뉴는 권한과 별개.** 이어 풀 풀이가 있으면 보기 권한자에게도 행 메뉴와 `더보기`가 보인다. 항목은 `풀기`, `이어 풀기 지우기`뿐이다. 편집 권한자에게는 그 아래에 기존 항목이 그대로 이어진다. 이어 풀 풀이가 없으면 UX12-MOCKNAV 그대로다(보기 권한자에게 `더보기` 없음).
- **`이어 풀기 지우기`를 둔다.** `풀기`로 새 풀이를 시작해도 그 풀이를 끝내면 앞서 멈춘 풀이가 다시 나타난다. 그래서 새 풀이만으로는 버릴 수 없다. UX12-RESUME과 같은 `POST /practice-runs/{id}/dismiss`(`resume_dismissed_at`)를 쓴다. 이름은 같은 메뉴의 `삭제`와 헷갈리지 않게 `지우기`로 줄이지 않는다. 묶음·session·`mock_exam_attempts`는 그대로이고 URL로 열린다. 더 오래된 끝나지 않은 풀이가 있으면 그 풀이가 대신 보인다.
- **열기.** `?panel=mock-exams[&mock=<id>]&practice=<run>&i=<k>`를 새 항목으로 연다. `mock`은 대화 상자의 화면으로 그대로 남아, 닫으면 연 곳(목록 또는 상세)으로 돌아온다. 보기 순서는 묶음 안에서 같다(UX12-MOCKSHUFFLE).
- **새로 읽기.** 풀이 패널이 닫히면 목록과 상세를 다시 읽는다. 모의고사를 고쳐도(이름 바꾸기) 진행은 사라지지 않는다.
- **권한.** `풀기` 규칙을 따른다. 모든 구성원이 자기 풀이를 보고, 보관된 Workspace에서는 열 수 있지만 제출은 막힌다(QVIEW-01-AC07). 풀이 기록은 `mock_exam_attempts`에만 쌓인다.

## API

`MockExam`에 `unfinished_run: {id, total, answered, next_position} | null`(선택 field)을 더한다. 호출자별 값이다. `GET /workspaces/{id}/mock-exams`와 `GET /mock-exams/{id}`, `PATCH /mock-exams/{id}`가 채운다. 목록은 모의고사 수와 상관없이 query 하나를 더 쓴다(N+1 없음). migration은 없다.

`POST /practice-runs/{id}/dismiss`는 이제 `source=mock` 묶음도 받는다.

## 수용 기준

### UX12-MOCKRESUME-AC01

- **Given:** 10문제 모의고사를 3문제 제출하고 닫았다
- **When:** 모의고사 목록을 연다
- **Then:** 그 행의 보이는 동작은 primary `이어 풀기 3/10`과 행 메뉴다. 행 메뉴의 첫 항목 `풀기`는 범위 고르기를 열고, 시작하면 새 풀이가 된다. 풀이가 없는 다른 모의고사의 행에는 `풀기`가 그대로 보인다. `이어 풀기` 묶음에는 이 풀이가 없다.

### UX12-MOCKRESUME-AC02

- **Given:** AC01의 모의고사
- **When:** 상세를 연다
- **Then:** 보이는 버튼은 primary `이어 풀기 3/10`과 `더보기`다. `더보기`의 앞 두 항목은 `풀기`, `이어 풀기 지우기`이고 편집 권한자에게는 기존 네 항목이 이어진다.

### UX12-MOCKRESUME-AC03

- **Given:** AC01의 행 또는 상세
- **When:** `이어 풀기`를 누르고 한 문제를 더 제출한 뒤 닫는다
- **Then:** 다음 미제출 위치 `practice=<run>&i=4`가 열린다. 닫으면 연 곳(목록, 또는 `mock=<id>` 상세)으로 돌아오고 새로 고침 없이 `이어 풀기 4/10`이다.

### UX12-MOCKRESUME-AC04

- **Given:** 보기 섞기 모의고사의 풀이에서 2번 위치를 열어 보기 순서를 보고 닫았다
- **When:** `이어 풀기`로 다시 연다
- **Then:** 2번 위치의 보기 순서가 같다.

### UX12-MOCKRESUME-AC05

- **Given:** 끝나지 않은 풀이가 있는 모의고사
- **When:** 다음 위치의 문제를 빼거나, 남은 문제를 모두 빼거나, 다시 만들거나, 모의고사를 삭제한다
- **Then:** 문제를 빼면 그 위치를 건너뛴다. 남은 위치가 없으면 `풀기`만 보인다. 다시 만들면 `풀기`만 보이고 이전 풀이는 URL로 열린다. 삭제하면 행이 없다. 어느 경우도 오류가 없다.

### UX12-MOCKRESUME-AC06

- **Given:** 끝나지 않은 풀이 두 개가 있는 모의고사
- **When:** 마지막으로 만진 풀이를 `결과 보기`까지 끝낸다
- **Then:** 다른 풀이가 `이어 풀기`로 보인다. 그 풀이도 모든 위치를 제출하면 `풀기`만 보인다.

### UX12-MOCKRESUME-AC07

- **Given:** 끝나지 않은 풀이가 있는 모의고사
- **When:** 행 메뉴의 `이어 풀기 지우기`를 고른다
- **Then:** `풀기`만 보이고 새로 고쳐도 그렇다. 제출한 attempt는 그대로이고 묶음은 URL로 열리며 끝나지 않은 채다.

### UX12-MOCKRESUME-AC08

- **Given:** A의 끝나지 않은 풀이가 있는 모의고사
- **When:** 같은 Workspace의 B, 보기 권한자인 본인, 보관된 Workspace의 본인이 목록을 연다
- **Then:** B에게는 `풀기`만 보이고 응답에 A의 풀이가 없다. 보기 권한자와 보관된 Workspace의 본인에게는 자기 `이어 풀기`가 보인다. 비구성원은 404다. 풀이는 `mock_exam_attempts`에만 쌓이고 `question_attempts`는 그대로다.

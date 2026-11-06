# UX12-RESUME — 모의고사 목록의 이어 풀기

**Route:** `/workspaces/:workspaceId?panel=mock-exams` → `?panel=mock-exams&practice=<run>&i=<k>`

**Phase:** UX12-RESUME.0
**테스트:** `tests/e2e/questions/ux12-run-resume.spec.ts`, `tests/integration/questions/practice_runs/test_practice_runs_contract.py`, `apps/web/test/ux12-run-resume.test.tsx`, `apps/api/tests/test_practice_runs_unit.py`, `supabase/tests/34_practice_run_resume.test.sql`

```yaml
id: UX12-RESUME
linked_tests: [UX12-RESUME-AC01 … UX12-RESUME-AC09]
```

**명세:** [UX12 MOCKUX-7](../implementation/ux12/index.md) (사용자 결정 2026-11-06), [MOCK-01](mock-exams.md), [QVIEW-01](question-viewer.md), [UX12-MOCKNAV](ux12-mock-nav.md)

모의고사 목록에서 변형 없이 `추가`로 시작한 풀이는 저장된 모의고사가 아니라 범위 풀이(`practice_run`, `source=bank`)다. 도중에 닫으면 목록에 아무것도 남지 않았다. 이제 목록이 내가 끝내지 않은 원본 풀이를 모의고사와 같은 하나의 목록(`모의고사 목록`)에 행으로 보인다(별도 `이어 풀기` 묶음과 제목은 사용자 피드백 2026-11-07, MOCKLIST로 없앴다). 홈의 챕터별 `풀기`는 MOCKUX-11에서 지웠지만, 그 버튼으로 시작한 풀이는 원본 풀이이므로 여기서 그대로 이어 풀 수 있다.

## 결정

- **대상.** 호출자 본인의 `source=bank` 묶음 가운데 이 Workspace의 것만. 저장된 모의고사의 풀이(`source=mock`)는 이 묶음이 아니라 그 모의고사 행의 `이어 풀기`로 보인다([UX12-MOCKRESUME](ux12-mock-resume.md)).
- **끝난 풀이.** `결과 보기`로 `finished_at`이 정해졌거나 모든 위치가 끝나 이어 풀 위치가 없으면 목록에서 사라진다.
- **이어 풀 위치.** 묶음 순서에서 가장 앞의, 문제가 살아 있고(`eligible_question`) 제출하지 않은 위치다. 그 위치의 session이 초기화로 무효가 됐으면 그 위치는 묶음 안에서 다시 열 수 없어 건너뛴다(QVIEW-01의 `초기화됨`). 그런 위치가 하나도 없으면 행도 없다. 그래서 문제가 모두 지워진 묶음은 오류 없이 보이지 않는다.
- **행.** 이름, 진행 `3/10`(제출한 위치 수/묶음 위치 수, 풀이 패널의 분모와 같다), 마지막으로 만진 시각(그 묶음 session의 열기·제출·채점 중 가장 늦은 시각, 없으면 만든 시각), 버튼은 없고 이름(제목)을 누르면 이어 풀기다(진행은 `3/10 · 날짜` 줄에 있다). 행 메뉴 `삭제`(빨간 글자). 행은 `모의고사` 라벨이 없어 모의고사 행과 구분된다. 목록 순서는 원본 풀이 행의 마지막으로 만진 시각과 모의고사 행의 만든 시각을 합쳐 최신순이고, 같으면 id 순이다(클라이언트 정렬, API 변경 없음). 이름은 살아 있는 문제가 모두 한 챕터에 있으면 그 챕터 제목, 아니면 `원본 풀이`다. 발문·보기·정답은 응답에 없다.
- **순서와 한도.** 마지막으로 만진 시각이 늦은 순서로 20개까지. 응답 크기와 읽는 양을 묶어 두려고 지우지 않은 끝나지 않은 묶음 중 최근 100개만 살핀다.
- **`삭제`는 목록에서만 뺀다**(메뉴 이름은 사용자 피드백 2026-11-07로 `지우기`에서 `삭제`가 됐다. 동작은 그대로 기록을 남기는 dismiss라 확인 dialog도 없다). `practice_runs.resume_dismissed_at`(nullable, 추가만 하는 column)을 정한다. 묶음의 `item_ids`, session, attempt, 이력은 그대로다. `finish`를 쓰지 않는 이유: 끝내면 안 푼 위치가 `건너뜀`으로 고정되고 URL로 이어 풀 수 없게 되어 "목록에서만"이 아니다. 지운 묶음은 URL과 이력으로는 그대로 열리고 이어서 풀 수 있지만 목록에는 돌아오지 않는다. 확인 dialog는 없다.
- **열기.** `풀기`는 `?panel=mock-exams&practice=<run>&i=<k>`를 새 항목으로 연다. 패널은 기존 범위 풀이 패널이므로 Back, 닫기, 결과, `처음부터 다시`가 같다. 닫으면 모의고사 mock run과 같이 목록으로 돌아온다.
- **새로 읽기.** 목록은 열 때마다, 그리고 그 위에서 풀이 패널이 닫힐 때마다 다시 읽는다. 생성 진행 polling은 이 목록을 읽지 않는다.
- **집계.** 홈과 목록의 "모의고사 n개"는 저장된 모의고사만 센다. 이어 풀 행이 있으면 빈 상태 글자는 보이지 않는다.
- **권한.** 본인 묶음이므로 보기 권한자도, 보관된 Workspace에서도 보인다(보관 Workspace에서 제출이 막히는 것은 QVIEW-01-AC07 그대로다). 공유 링크 세션에는 사용자 JWT가 없어 401이고, Fork는 묶음을 복제하지 않는다.
- **읽기 실패.** 이 묶음을 읽지 못해도 모의고사 목록은 그대로 보이고, 그 자리에 오류와 `다시 시도`가 보인다.

## API

| Method | Path | 내용 |
|---|---|---|
| GET | `/api/v1/workspaces/{id}/practice-runs/unfinished` | 구성원. 호출자의 끝나지 않은 bank 묶음 `{items: UnfinishedRun[]}`. 비구성원·삭제된 Workspace는 404 |
| POST | `/api/v1/practice-runs/{id}/dismiss` | 묶음 주인. 목록에서 뺀다. 204, 다시 불러도 204. 남의 묶음·모르는 id는 404. `source=mock` 묶음도 받는다([UX12-MOCKRESUME](ux12-mock-resume.md)) |

`UnfinishedRun`: `id`, `total`, `answered`, `next_position`, `chapter_title`, `created_at`, `last_touched_at`.

## 수용 기준

### UX12-RESUME-AC01

- **Given:** 편집 권한자가 모의고사 목록의 `추가`에서 변형 없이 3문제 풀이를 시작해 1문제를 제출했다
- **When:** 패널을 닫고 모의고사 목록을 다시 연다
- **Then:** 목록에 원본 풀이 행 하나가 있다. 행에는 `원본 풀이`, `1/3`, 시각이 있고 `풀기` 버튼은 없으며 발문·보기·정답은 없다. "모의고사 n개"의 n은 저장된 모의고사 수 그대로다.

### UX12-RESUME-AC02

- **Given:** AC01의 행
- **When:** 행 이름(제목)을 누른다
- **Then:** 다음 미제출 위치 `?panel=mock-exams&practice=<run>&i=2`로 풀이 패널이 열린다. 앞 위치로 Back이 되고, 닫으면 모의고사 목록이 다시 보인다.

### UX12-RESUME-AC03

- **Given:** AC02에서 2번을 제출했다
- **When:** 풀이 패널을 닫는다
- **Then:** 새로 고침 없이 목록의 행이 `2/3`이다. 다시 이어 풀어 마지막 문제를 제출하고 `결과 보기`까지 간 뒤 닫으면 행이 사라진다.

### UX12-RESUME-AC04

- **Given:** 한 챕터의 문제로만 시작한 풀이를 도중에 닫았다
- **When:** 모의고사 목록을 연다
- **Then:** 행의 이름이 그 챕터 제목이고 이름을 눌러 다음 미제출 위치가 열린다.

### UX12-RESUME-AC05

- **Given:** 모의고사가 없고 끝나지 않은 풀이가 하나 있다
- **When:** 모의고사 목록을 연다
- **Then:** 빈 상태 글자 "아직 모의고사가 없습니다."는 보이지 않고 "모의고사 0개"와 이어 풀 행이 보인다. 그 행을 지우면 빈 상태가 보인다.

### UX12-RESUME-AC06

- **Given:** 이어 풀 행
- **When:** 행 메뉴의 `삭제`를 고른다
- **Then:** 행이 사라지고 다시 열거나 새로 고쳐도 없다. 제출한 attempt는 그대로이고 그 묶음은 URL로 그대로 열리며 끝나지 않은 채다.

### UX12-RESUME-AC07

- **Given:** A의 끝나지 않은 풀이가 있는 Workspace
- **When:** 같은 Workspace의 B, A의 다른 Workspace, 보기 권한자·보관된 Workspace의 본인이 각각 목록을 연다
- **Then:** B와 다른 Workspace에는 A의 행이 없다. 보기 권한자와 보관된 Workspace의 본인에게는 자기 행이 보인다. 비구성원의 목록 요청과 남의 묶음 `dismiss`는 404, 공유 세션은 401이다.

### UX12-RESUME-AC08

- **Given:** 저장된 모의고사의 풀이를 도중에 닫았다
- **When:** 모의고사 목록을 연다
- **Then:** 원본 풀이 행으로는 보이지 않는다. 그 풀이는 모의고사 행의 진행으로 보인다([UX12-MOCKRESUME-AC01](ux12-mock-resume.md)).

### UX12-RESUME-AC09

- **Given:** 끝나지 않은 묶음의 문제가 모두 지워졌다. 다른 묶음은 앞 위치의 문제만 지워졌다
- **When:** 모의고사 목록을 연다
- **Then:** 첫 묶음은 행 없이 목록이 오류 없이 보인다. 다른 묶음의 이름(제목)은 살아 있는 첫 미제출 위치를 연다.

# UX12-STEMTABLE — 발문 표의 병합 셀과 표 편집

**Route:** 별도 route 없음. 문제 내용 전체를 보이는 부품([QTABLE-01](question-tables.md))과 문제 편집 부품 `QuestionContentFields`(문제 편집, 초안 편집, 모의고사 문제 편집)

**Phase:** UX12-STEMTABLE.0
**테스트:** `tests/e2e/questions/ux12-stem-table.spec.ts`

```yaml
id: UX12-STEMTABLE
linked_tests: [UX12-STEMTABLE-AC01]
```

**명세:** [UX12 EXTRACT-9](../implementation/ux12/index.md), [QTABLE-01](question-tables.md), [questions.md §4 11·§6](../questions.md), [UX12-SPANS](ux12-spans.md)

발문 표는 `stem` 안 GFM pipe 표로 저장한다(D-11). GFM은 병합 셀을 나타내지 못해 칸마다 글자가 반복된다. `stem`은 그대로 두고 그 옆에 구조화 셀 `stem_tables`를 저장한다(사용자 결정 2026-11-06, A안). AI, 검색, fingerprint, 중복 판정은 지금처럼 `stem`만 읽는다. `stem_tables`는 화면과 표 편집만 읽는다.

**저장 형식:** `stem_tables`는 null이거나 `stem`의 pipe 표 묶음과 같은 순서, 같은 개수의 목록이다. 항목은 `{rows, header_rows, spans}`(문서 표 `TableContent`, [UX12-SPANS](ux12-spans.md)) 또는 null이다. null 항목은 그 묶음을 GFM으로 보인다. `rows`는 직사각형 격자이고 병합 셀은 칸마다 글자를 반복하므로, 항목을 GFM으로 쓰면 묶음과 같은 글자가 된다.

**맞물림 규칙:** 항목은 묶음 수가 같고, 항목을 GFM으로 쓴 글자가 공백을 빼고 묶음과 같을 때만 쓴다. 묶음 수가 다르면 전체를, 글자가 다른 묶음은 그 항목만 버리고 GFM으로 보인다. 고쳐서 맞추지 않는다. Python `aligned_stem_tables`와 TS `alignedStemTables`가 같은 규칙이고 `tests/fixtures/stem-table-alignment.json`이 공통 사례다. 모든 항목이 버려지면 저장값은 null이다.

**기존 문제:** 기존 행은 null이고 GFM으로 보인다. 등록된 문제의 병합 셀은 `다시 추출`로만 들어온다. 발문이 같아도 병합 셀이 달라지면 `changed`에 `table`이 들어가 `변경됨`, `표`로 보이고, 새 초안 등록과 `이전 문제 보관`으로 바꾼다([UX12-REEXTRACT](ux12-reextract.md)).

**표 편집:** 문제 내용 입력 아래에 발문의 표 묶음마다 표 편집기가 있다. 구조화 항목이 있으면 그것을, 없으면 pipe 묶음을 해석해 연다. 편집기가 바꾼 표는 구조화 항목이 되고, 그 표의 GFM 묶음은 항목에서 다시 쓴다. 건드리지 않은 표의 항목은 null인 채로 둔다. 저장은 다른 편집과 같이 새 revision을 만든다.

- 칸마다 이름 있는 입력(`표 1 2행 3열`, 병합 칸은 `표 1 2–3행 1열 병합`)이 있다. 칸 안 줄바꿈은 그대로 입력한다.
- 행과 열 머리의 메뉴(Radix `DropdownMenu`)로 위·아래 행 추가, 왼쪽·오른쪽 열 추가, 삭제를 한다. 마지막 남은 행과 열은 삭제할 수 없다.
- 병합 칸의 글자를 바꾸면 병합이 덮는 모든 격자 칸이 함께 바뀐다.
- 병합을 가로지르는 행이나 열을 지우면 병합은 줄어든다. 시작 행이나 열을 지워도 다음 행이나 열이 시작이 된다. 한 칸만 남으면 병합이 아니다.
- 병합 안쪽에 행이나 열을 넣으면 병합이 늘어나 끊어지지 않는다. 병합의 바깥 경계에 넣으면 병합은 그대로이고 새 칸은 비어 있다.
- 칸 병합과 병합 해제는 이번 범위가 아니다.

**직접 고친 표:** 문제 내용 입력에서 pipe 묶음을 직접 고쳐 항목과 어긋나면 맞물림 규칙대로 그 표는 GFM이 된다. 병합은 복원하거나 추측하지 않는다. 편집기는 고친 묶음을 해석해 다시 열고, 해당 표에 `병합 정보 없이 글자 표로 편집합니다.` 안내를 보인다. 저장 전에 글자를 되돌리면 항목이 다시 맞물린다.

### UX12-STEMTABLE-AC01

병합 칸이 있는 문제는 풀이 화면에서 병합 칸을 한 칸으로 보인다(`rowSpan`, `colSpan`, 가려진 칸 없음). 편집 권한 구성원이 문제 편집을 열면 표 편집기에 칸마다 이름 있는 입력이 있다. 병합 칸의 글자를 고치고, 병합을 가로지르는 행을 지우고, 열을 추가하고 저장하면 새 revision이 생긴다. 다시 열면 고친 글자가 보이고 병합은 줄어든 크기로 남아 있으며, `stem`의 GFM 묶음은 같은 글자로 다시 써져 있다. 키보드만으로 메뉴를 열어 행을 지울 수 있다. 폭 375px에서 표 편집기는 자기 영역 안에서 가로로 스크롤하고 페이지는 가로로 스크롤하지 않는다.

## 계약

| ID | 내용 |
|---|---|
| UX12-STEMTABLE-C01 | `question_revisions.stem_tables`, `mock_exam_question_revisions.stem_tables`는 nullable `jsonb`이다. DB 제약 `stem_tables_valid`가 형태(비어 있지 않은 배열, 항목은 null 또는 `rows`와 `header_rows`가 있는 객체), 항목 50개, 200,000바이트를 검사한다. JSON `null`은 거부한다. `QuestionDraft`는 선택 필드 `stem_tables`를 가지며 `schema_version`은 1 그대로다. 이 필드가 없는 초안은 null로 읽는다. |
| UX12-STEMTABLE-C02 | 추출기는 발문에 GFM을 넣는 자리에서 항목을 채우고, 최종 `stem`과 맞물림 규칙으로 한 번 더 맞춘다. 보기 표는 항목이 없다. AI 보조 정리가 표를 바꾸면 그 항목은 쓰지 않는다. |
| UX12-STEMTABLE-C03 | 복사 경로: 초안 등록(`worker_register_import_drafts`, API 등록), 문제 생성과 수정, 초안 수정, 모의고사 문제 수정, Fork(`worker_fork_commit`)는 값을 그대로 옮긴다. 모의고사 `OPTION_SHUFFLE`은 발문이 같아 값을 옮긴다. 발문이 달라지는 AI 변형은 값을 버린다. 일반 변형 초안은 값이 없다. |
| UX12-STEMTABLE-C04 | 쓰기 API(`QuestionCreate`, `QuestionUpdate`, `QuestionDraftUpdate`, `MockExamQuestionUpdate`)는 선택 필드 `stem_tables`를 받는다. 서버는 저장 전에 맞물림 규칙을 적용하며, 어긋난 항목은 오류가 아니라 null이 된다. 수정 요청에 이 필드가 없으면 저장된 값에 새 `stem`으로 같은 규칙을 적용한다. |
| UX12-STEMTABLE-C05 | 읽기 DTO(풀이 세션, 풀이 run 항목, 재풀이 세션, 모의고사 풀이, 모의고사 문제, 문제 상세 revision, 초안 payload, 문제 미리보기)는 `stem`이 있는 곳에만 `stem_tables`를 준다. `stem`이 null이면 이 값도 null이다. 표에는 정답이 없지만 정답 없는 DTO 규칙은 같다. 고정 표시 대상이 아닌 응답(요약, 목록 미리보기, 중복 그룹)에는 넣지 않는다. |
| UX12-STEMTABLE-C06 | 화면은 구조화 항목이 있는 묶음을 `rowSpan`, `colSpan`으로 그린다(`tableGrid`, `printed-table.module.css`). 머리글 행의 칸은 `th scope="col"`이고 병합 머리글은 덮는 열 전부의 머리글이다. 항목 수가 묶음 수와 다르면 전부 GFM으로 보인다. |
| UX12-STEMTABLE-C07 | 편집 모델 `stem-table-edit.ts`: 칸 글자, 행·열 추가와 삭제, 병합 줄임·늘림, `tableGfm`, 발문의 해당 묶음 교체. `tableGfm`은 Python `gfm_table`과 같은 글자를 쓴다. |

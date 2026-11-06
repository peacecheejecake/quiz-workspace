# CHMAN-01 — 챕터 관리 Floating Panel

**상태:** 확정 화면 요구사항 v1.0 · UX12 CHAPTER-3 신규 2026-11-06 (사용자 항목 "챕터 기능 개선: 수정/삭제/추가", "챕터 관리 화면 추가: dnd를 통해 계층 관리", "챕터 > drop", 사용자 결정 D-9)
**Route:** `/workspaces/:workspaceId?panel=chapter-management` (Workspace 홈 header `문서 N` 메뉴의 `챕터 관리`가 여는 modal panel)
**테스트:** `tests/e2e/questions/chapter-management.spec.ts` (계약: `tests/integration/questions/chapter_management/`, 트리 로직: `apps/api/tests/test_chapter_tree.py`·`apps/web/test/chapter-tree.test.ts`, guard: `supabase/tests/32_chapter_edit.test.sql`)
**Phase:** CHMAN.0
**연계:** [Questions 명세](../questions.md) §14.5, [DOC-02](documents-editor.md) AC02, [CHREDIST-01](chapter-redistribution.md), [UX12-PICKER](ux12-chapter-picker.md), [HOMEDLG-01](home-dialogs.md), [Workspace 공유](../workspace-sharing.md) §11

```yaml
id: CHMAN-01
route: /workspaces/:workspaceId?panel=chapter-management
actor: editor/owner (활성 Workspace)
permission: edit
status: confirmed
api: [GET /api/v1/workspaces/:id/chapter-tree, POST /api/v1/workspaces/:id/chapters, PATCH /api/v1/chapters/:id, POST /api/v1/documents/:id/chapters/tree, DELETE /api/v1/chapters/:id, POST /api/v1/workspaces/:id/questions/chapter-assignments]
components: [FloatingSidePanel, ChapterPicker, Button, ConfirmDialog, DndContext]
linked_tests: [CHMAN-01-AC01 … CHMAN-01-AC08]
```

## 목적과 정책

- **즉시 적용 (D-9):** 챕터 편집은 draft·발행 없이 문서의 **활성 revision**에 바로 적용된다. 챕터 구조는 교정 대상인 본문이 아니라 문제를 묶는 분류다. 그래서 활성 revision의 불변 규칙에서 `chapter_edit` 경로 하나만 예외로 둔다(DOC-02-AC02). 본문 블록의 글자·순서는 이 화면에서 바뀌지 않는다.
- **교재만:** 챕터는 교재(`document_type = book`, 교재·교재+문제)의 활성 revision에 있다. 문제지 문서와 아직 처리 중인 문서는 트리에 없다. 교재가 없는 Workspace에는 챕터를 추가할 곳이 없어 빈 상태 "챕터를 관리할 교재가 없습니다. 교재 PDF를 먼저 올려 주세요."만 보인다.
- **안정 key:** 사용자가 추가한 장의 `section_key`는 `user-<uuid>`다. 기존 장은 이름을 바꾸거나 옮겨도 `section_key`를 유지하므로 정리 노트·요약(둘 다 `section_key`에 묶임)과 교정 발행의 문제 재연결이 그대로 이어진다.
- **교정 draft와 복원:** 챕터 편집은 이미 있는 교정 draft에도 같은 구조로 반영되므로 draft를 발행해도 편집이 사라지지 않는다. 이전 revision을 복원한 draft도 지금 활성 revision의 트리를 이어받는다: `user-*` 장과 계층·순서가 유지되고 삭제한 장은 돌아오지 않는다. 다만 복원은 글자 교정을 되돌리는 동작이므로 파서가 만든 장의 제목은 복원본의 제목으로 돌아간다.
- **발행 중:** 교정 draft의 발행 job이 대기·실행 중이면 편집은 409 `publish-in-progress`이고 화면은 "교정본을 발행하는 중입니다. 끝난 뒤 다시 시도해 주세요."를 보인다.
- **삭제:** 문제가 있는 장의 삭제는 문제를 옮길 곳을 반드시 고른다(다른 챕터 또는 `챕터 없음`; D-9). 정리 노트가 있으면 경고를 보인다: 노트는 `section_key`에 묶여 있어 장과 함께 보이지 않게 된다. 하위 장은 지워지지 않고 지운 장의 상위로 올라간다. 본문 블록은 지운 장의 상위 장(없으면 장 없음)으로 옮겨지고, 다른 내용은 바뀌지 않는다.
- **문제 기록:** 삭제로 옮긴 문제는 `chapter_source = manual`이고(자동 재매칭이 건드리지 않음) `question_chapter_changes` 행(source `chapter_edit`)을 남긴다. 문제 revision·attempt·학습 상태·범위 풀이 묶음은 바뀌지 않는다(questions.md §14.1). 모의고사 범위(`range.chapter_ids`)·AI 질문 범위(`scope`)에 남은 지운 장 id는 없는 것으로 읽는다.
- **검색:** 장 범위 검색은 하위 트리를 DB에서 읽으므로 이동·이름 변경 뒤 재색인이 없다. 지운 장의 본문 조각은 다음 교정 발행이나 `make reindex`까지 Qdrant에 옛 `section_id`로 남아, 전체 검색에는 나오지만 상위 장 범위 검색에는 잡히지 않는다.
- **공유·Fork:** 공유 화면은 편집 결과를 그대로 읽기만 하고 편집 API가 없다. Fork는 커밋 시점 트리를 복사한다(`user-*` key 포함, workspace-sharing.md §11).

## 레이아웃 및 컴포넌트

- **진입:** `문서 N` 메뉴의 `챕터 재분배` 다음에 `챕터 관리`(`requiresEdit: true`). 보기 권한·보관된 Workspace에서는 다른 편집 항목과 같이 비활성이고 이유 글자를 보인다. 그들이 `?panel=chapter-management`로 와도 panel은 열리지 않는다.
- **panel:** 공통 `FloatingSidePanel` **modal**, 넓은 폭, 제목 "챕터 관리". 즉시 열리고 skeleton "챕터를 불러오는 중입니다.", 실패하면 role=alert와 `다시 시도`.
- **트리:** 교재마다 문서 제목 묶음과 `챕터 추가` 버튼, 그 아래 장 목록. 행은 끌기 손잡이 · 제목 · 문제 수 · 정리 노트 표시 · `챕터 메뉴` 버튼이다. 들여쓰기는 `level`이다.
- **행 메뉴:** `이름 바꾸기`, `하위 챕터 추가`, `위로`, `아래로`, `들여쓰기`, `내어쓰기`, `삭제`. 끌기와 같은 결과를 내는 키보드·터치 동등 경로이며, 할 수 없는 항목은 비활성이다(맨 위의 `위로`, 깊이 20의 `들여쓰기` 등).
- **끌어서 옮기기:** 행을 끌어 다른 행 위에 놓으면 그 장의 하위 맨 끝으로 간다. 형제 사이 순서는 `위로`·`아래로`로 바꾼다. 자기·하위 행이나 깊이 20을 넘는 위치에 놓으면 아무 일도 없고 alert로 이유를 알린다. 끄는 동안 live region이 위치를 읽어 준다.
- **문제 놓기 (사용자 항목 "챕터 > drop"):** 트리 옆(좁은 폭에서는 트리 아래) `문제` 목록은 챕터 재분배와 같은 Heatmap 순서의 확정 문제다. 문제를 장 행에 끌어 놓으면 기존 `chapter-assignments`(source `manual`)로 옮긴다. 키보드·터치에서는 문제 행의 `챕터로 옮기기` `ChapterPicker`가 같은 일을 한다. 이 경로는 CHREDIST-01의 충돌 규칙을 그대로 따른다.
- **삭제 확인:** dialog "<장>을 삭제할까요?". 문제가 있으면 `문제를 옮길 챕터` `ChapterPicker`(지우는 장 제외, 맨 위 `챕터 없음`)를 고르기 전까지 `삭제`는 비활성이고 이유 글자가 보인다. 노트가 있으면 경고 "이 챕터의 정리 노트는 더 이상 보이지 않습니다."를 보인다.
- **닫기:** 닫으면 홈이 다시 읽혀 Heatmap·필터의 장 이름과 묶음이 새 트리를 따른다. focus는 메뉴 버튼으로 돌아간다.

## 화면 상태

| 상태 | 편집 권한(활성 Workspace) | 보기 권한 | 보관된 Workspace |
|---|---|---|---|
| 메뉴 항목 | 활성 | 비활성 + 이유 | 비활성 + 이유 |
| `?panel=chapter-management` | panel 열림 | 열리지 않음 | 열리지 않음 |
| 교재 없음 | 빈 상태 | — | — |
| 다른 사람이 먼저 바꿈 | role=alert "그 사이 챕터가 바뀌어 저장하지 않았습니다. 목록을 다시 불러왔습니다." | — | — |
| 발행 중 | role=alert 발행 안내, 트리는 그대로 | — | — |

## API 계약

### CHMAN-01-C01 권한

모든 route는 편집 권한·활성 Workspace를 요구한다: 보기 권한 403 `insufficient-role`, 보관 403 `workspace-archived`, 다른 Workspace·삭제·없는 id는 같은 본문의 404. Share session에는 route가 없다. 쓰기는 `Idempotency-Key`를 받는다(같은 키·같은 본문 → 저장한 응답, 다른 본문 → 422 `idempotency-key-reused`).

### CHMAN-01-C02 잠금 순서

Workspace FOR SHARE → 문서 FOR UPDATE → 문제 id 순 FOR UPDATE. 삭제 대상이 다른 문서의 장이면 두 문서를 id 순으로 잠근다(편집 문서 FOR UPDATE, 대상 문서 FOR SHARE). questions.md §14.3과 같은 순서라 교정 발행·챕터 재분배와 deadlock이 없다. Fork 커밋은 원본 문서를 FOR SHARE로 잠근 뒤 복사하므로 편집 전 또는 후의 온전한 트리를 복사한다.

### CHMAN-01-C03 조회

`GET /workspaces/{id}/chapter-tree` → `{documents: [{document_id, title, revision_id, version, chapters: [{id, parent_id, section_key, title, level, sort_order, page, question_count, has_note, user_created}]}]}`. 살아 있는 교재의 활성 revision만, outline 순서. `question_count`는 그 장의 살아 있는 `CONFIRMED` 문제 수(하위 장 제외), `has_note`는 살아 있는 정리 노트 존재 여부, `version`은 `documents.chapter_tree_version`이다. 본문·정답·해설은 없다.

### CHMAN-01-C04 생성·이름

`POST /workspaces/{id}/chapters` `{document_id, parent_id, title}` → 201 `{chapter, version}`. 상위의 마지막 자식(`parent_id: null`이면 마지막 최상위)으로 들어간다. `PATCH /chapters/{id}` `{title}` → 200 같은 모양. 제목은 앞뒤 공백을 지우고 1~1000자. 문서가 교재가 아니거나 활성 revision이 없으면 422 `chapter-invalid`, 깊이 20 초과는 422 `chapter-tree-invalid`, 지난 revision의 장 id는 409 `chapter-tree-changed`.

### CHMAN-01-C05 이동

`POST /documents/{id}/chapters/tree` `{expected_version, moves: [{chapter_id, parent_id, position}]}`(1~500개, 차례대로 적용, `position`은 새 상위 아래 0부터) → 200 `{version, chapters}`. `expected_version`이 다르면 409 `chapter-tree-changed`, 아무것도 바뀌지 않는다. 자기·하위로의 이동과 깊이 20 초과는 422 `chapter-tree-invalid`. 이 문서의 활성 revision에 없는 id는 404. 매 요청 revision 전체의 `level`(상위 + 1)과 `sort_order`(pre-order)를 다시 계산한다.

### CHMAN-01-C06 삭제

`DELETE /chapters/{id}?move_questions_to=<chapter id|none>` → 200 `{moved_questions, version}`. 이 장을 가리키는 모든 문제(초안·보관·삭제 표시 포함)를 옮긴다. 옮길 문제가 있는데 값이 없으면 422 `chapter-target-required`. 대상은 살아 있는 교재의 활성 revision 장이어야 하고(CHREDIST-01과 같은 검사) 자기 자신이면 422 `chapter-invalid`, 다른 Workspace의 장이면 404다. 삭제로 옮기는 문제와 같은 대상으로 초안의 직접 고른 챕터(`question_drafts`)도 옮기며, `none`이면 FK가 지운다. import 실행의 목표 챕터(`question_import_runs.target_chapter_id`)도 같은 대상으로 옮기거나 지운다.

### CHMAN-01-C07 쓰기의 공통 효과

`documents.chapter_tree_version` 1 증가, 활성 revision의 `content_hash` 재계산(불변 검사 예외 경로 안에서), 교정 draft 동기화. 활동 기록은 `document.chapter_created`·`document.chapter_renamed`·`document.chapters_moved`·`document.chapter_deleted`이고 id와 개수만 담는다(제목 없음).

## Acceptance Criteria

### CHMAN-01-AC01

- **Given:** 교재가 있는 Workspace의 소유자, 보기 권한 구성원, 보관된 Workspace
- **When:** `문서 N` 메뉴의 `챕터 관리`를 연다
- **Then:** 소유자는 modal panel에서 교재별 트리와 장마다 문제 수를 보고 URL은 `?panel=chapter-management`다. 보기 권한·보관된 Workspace에서는 항목이 비활성이고 이유 글자가 보이며 URL로 와도 panel이 열리지 않는다.

### CHMAN-01-AC02

- **Given:** 열린 panel
- **When:** `챕터 추가`·`하위 챕터 추가`로 장을 만들고 `이름 바꾸기`로 고친다
- **Then:** 트리에 바로 보이고 draft revision이 생기지 않으며, 새로 읽어도 남고, 닫으면 문제 등록의 챕터 목록에 새 이름이 보인다.

### CHMAN-01-AC03

- **Given:** 문제와 정리 노트가 있는 장
- **When:** `삭제`를 누른다
- **Then:** 옮길 챕터를 고르기 전에는 삭제할 수 없고 노트 경고가 보인다. 삭제하면 문제가 고른 장으로 옮겨지고 풀이 기록과 문제 revision은 그대로이며 `question_chapter_changes`에 `chapter_edit` 행이 남는다. 하위 장은 지운 장의 상위로 올라간다.

### CHMAN-01-AC04

- **Given:** 두 단계 트리
- **When:** 행을 끌어 다른 장 아래로 놓고, 행 메뉴의 `위로`·`아래로`·`들여쓰기`·`내어쓰기`를 쓴다
- **Then:** 계층과 순서가 바뀌고 새로 읽어도 남으며, 메뉴는 Tab·화살표·Enter만으로 닿고, 할 수 없는 항목은 비활성이다.

### CHMAN-01-AC05

- **Given:** 다른 탭이 먼저 트리를 바꾼 panel
- **When:** 옮기기를 시도한다
- **Then:** role=alert가 "그 사이 챕터가 바뀌어 저장하지 않았습니다"를 알리고 트리를 다시 읽으며 아무것도 옮기지 않는다.

### CHMAN-01-AC06

- **Given:** 확정 문제가 있는 panel
- **When:** 문제를 다른 장 행에 끌어 놓는다(키보드: `챕터로 옮기기`)
- **Then:** 문제가 그 장으로 옮겨지고 양쪽 장의 문제 수가 바뀌며 풀이 기록은 그대로다.

### CHMAN-01-AC07

- **Given:** 하위 장에 문제가 있는 교재
- **When:** 홈 챕터 필터를 연다
- **Then:** `ChapterPicker`가 상위 장 아래에 하위 장을 계층으로 보이고, Heatmap의 장 묶음 배치는 전과 같다.

### CHMAN-01-AC08

- **Given:** 375px 터치 화면(WebKit 포함)
- **When:** panel을 열고 행 메뉴로 장을 옮긴다
- **Then:** 페이지·panel에 가로 스크롤이 없고 조작 영역이 44px 이상이며 pointer 끌기 없이 같은 결과가 난다.

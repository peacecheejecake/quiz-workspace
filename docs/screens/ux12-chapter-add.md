# UX12-CHAPTERADD — 문제 챕터 dropdown에서 챕터 추가, Workspace 챕터

**상태:** 구현 중 · [UX12 계획](../implementation/ux12/index.md) §4.3b CHAPTER-8 · 사용자 결정 2026-11-06
**화면:** 문제 편집기·가져오기 초안의 챕터 dropdown([UX12-PICKER](ux12-chapter-picker.md)), [챕터 관리](chapter-management.md)
**테스트:** `tests/e2e/questions/ux12-chapter-add.spec.ts` (계약: `tests/integration/questions/chapter_management/test_workspace_chapters_contract.py`, guard·Fork: `supabase/tests/35_workspace_chapters.test.sql`, picker: `packages/ui/test/chapter-picker.test.tsx`, 트리: `apps/web/test/chapter-tree.test.ts`)
**Phase:** UX12-CHAPTERADD.0
**연계:** [Questions 명세](../questions.md) §14.6, [architecture](../architecture.md) §5, [Workspace 공유](../workspace-sharing.md) §11

사용자 결정(2026-11-06): ① 문제의 챕터 dropdown에서 `새 챕터`로 이름을 넣으면 챕터가 만들어지고 바로 골라진다. ② 교재가 없는 Workspace에서도 챕터를 만들 수 있다.

## 데이터 모델 결정

**Workspace 챕터:** 어떤 문서에도 속하지 않는 장. `chapters` 행의 `document_id`·`document_revision_id`가 둘 다 null이다(방안 a). `section_key`는 `user-<uuid>`, `page`·`heading_block_id`는 null이다. 다른 장처럼 `parent_id`로 계층을 이룬다. 본문·정리 노트·요약·검색 대상이 아니다: 문제를 묶는 분류일 뿐이다.

| 방안 | 판단 |
|---|---|
| **(a) `document_id` null 행 (채택)** | 문제의 장을 읽는 곳은 거의 `questions.chapter_id` left join으로 제목만 읽어 그대로 동작한다. revision이나 교재를 묻는 곳은 inner join이라 Workspace 챕터가 저절로 빠진다(본문 없음과 같은 뜻). 고칠 곳은 "살아 있는 장인가"를 묻는 몇 곳뿐이다(아래 표). 발행 revision의 불변 규칙도 건드리지 않는다: revision이 없으므로 `revision_content_guard`가 관여하지 않는다 |
| (b) Workspace마다 숨은 container 문서 | `documents`는 PDF 원본이 전제다(`sha256`, `size_bytes ≥ 1`, `source_object_key`가 NOT NULL·형식 검사). 가짜 값을 넣어야 하고, 문서를 읽는 28개 파일(문서 목록·`문서 N`·업로드·검색·교정·요약·재색인)에서 숨겨야 하며, Fork는 원본 PDF 복사·`chunk_revision`·`document.index_sync`를 건너뛰어야 한다. 빠뜨리면 없는 PDF가 사용자에게 보이는 실패다 |

**트리 잠금·version:** 새 표 `workspace_chapter_trees(workspace_id, version)`가 Workspace 챕터에서 `documents` 행의 역할을 한다. 쓰기는 이 행을 FOR UPDATE로 잡고 `version`을 올린다(일괄 이동의 `expected_version`). `workspaces` 행을 쓰지 않는 이유는 모든 쓰기가 그 행을 FOR SHARE로 잡고 있어, 올려 잡으면 서로를 기다리기 때문이다. 잠금 순서는 Workspace FOR SHARE → **트리 행** → 문서(id 순) → 문제(id 순) → 초안이다(questions.md §14.6). 문제 저장·재분배·import는 Workspace 챕터를 고르면 트리 행을 FOR SHARE로 잡고, Fork 커밋도 문서보다 먼저 FOR SHARE로 잡는다. 행이 없으면 Workspace 챕터도 없다.

**DB 불변:** 두 null은 함께다, null 행은 `user-<uuid>` key이고 쪽·제목 블록이 없다, 상위는 같은 Workspace의 Workspace 챕터다(trigger; `chapters_parent_fk`는 revision이 null이면 검사하지 않는다), Workspace를 지우면 함께 지워진다(`workspace_level_of` FK: `workspace_id` FK는 교재 장도 revision보다 먼저 지워 `revision_content_guard`에 걸린다).

**교재가 있는 Workspace에서 dropdown으로 만든 장의 자리:** 지금 고른 챕터가 살아 있는 교재의 장이면 그 교재의 맨 끝 최상위 장(CHMAN-01의 활성 revision 경로), 아니면(챕터 없음, 문제지 장, Workspace 챕터) Workspace 챕터의 맨 끝 최상위 장이다. 서버가 `near_chapter_id`로 정한다.

### 확인한 읽기 경로

| 읽는 곳 | Workspace 챕터에서 |
|---|---|
| `authz` `ResourceType.CHAPTER` | **고침:** 같은 Workspace의 null 행도 보인다(resource → workspace → membership 그대로) |
| 문제 저장 `chapter_is_current`·`lock_documents` | **고침:** 살아 있는 장으로 받고, 문서 대신 트리 행을 잠근다 |
| 재분배 `target_chapters`·`targets` | **고침:** 유효한 대상이고 `옮길 챕터`에 묶음으로 보인다. 추천·미리보기는 교재만 본다 |
| import `current_chapters`·`lock_documents_of`·`_chapter_options` | **고침:** 초안의 직접 고른 챕터로 쓸 수 있고 등록 뒤에도 남는다 |
| `worker_register_import_drafts` | **고침:** 고른 Workspace 챕터를 그대로 쓴다(문서 현재 revision으로 옮길 것이 없다) |
| `worker_fork_commit` | **고침:** 트리 행을 잠그고 전부 복사하며 문제의 `chapter_id`를 재매핑한다 |
| 공유 `_question_out` | **고침:** 공개 문서 검사에서 빠져 공유 문제에 장이 보인다. 트리는 읽기 전용, 공유 쓰기 route 없음 |
| Heatmap `heatmap_source`·`heatmap_order` | 그대로. 문서 정렬값이 null이라 교재 장 뒤, `챕터 없음` 앞이다. `chapter_lineage`·`chapter_ancestors`는 `parent_id`만 읽는다 |
| 범위 풀이·모의고사 범위 `question_ranges` | 그대로. Workspace 소속만 검사한다 |
| 문제 목록, `practice_runs`, `mock_practice`, `mock_exams`, `highlights`, `question_duplicates`, `ask`·`ai_explanations` 제목 | 그대로. left join으로 제목만 읽는다 |
| 정리 노트 `_chapter_select`, `workspace_chapters`, `chapter_note_store` | API는 그대로 제외. inner join(활성 revision)이라 노트가 없고 `GET`·`POST /chapters/{id}/note`는 404다. 노트는 `section_key` + 문서에 묶이고 본문이 입력이다. **고침:** 홈 Heatmap 묶음의 `정리 노트` 버튼은 Workspace 챕터에 없다 |
| 문서 요약 `summary_store`, `document_content` | 그대로 제외. revision으로 읽는다 |
| 검색·Ask `chapters_by_id`·`chapters_of`, `/documents/{id}/outline` | 그대로 제외. 본문 범위라 고를 수 없다. 범위 JSON에 남은 id는 없는 것으로 읽는다 |
| 재매칭 `chapter_rematch` | 그대로. `candidates`는 `chapter_source = auto`만 보고 `d.document_type <> 'book'`이 null이라 제외된다. dropdown 지정은 `manual`이다 |
| 교정 발행 `documents_remap_question_chapters`, `chapter_edit_sync_draft`, `content_hash` | 그대로. revision 안의 장만 다룬다 |
| `documents.in_use_as_book`, 문서 삭제 | 그대로. 문서의 장만 본다 |
| 재색인·백업 | 그대로. 재색인은 문서만, 백업은 표 전체다 |

## 동작

**`새 챕터` 행:** 편집 권한이 있는 활성 Workspace의 문제 편집기 `챕터`, 가져오기 초안 `N번 문제 챕터` picker 아래쪽에 언제나 보이는 버튼이다. 트리 목록 밖에 있어 찾기·접기와 상관없고 스크롤되지 않는다. 그 밖의 picker(홈 필터, 재분배, 챕터 관리, Ask, 검색)에는 없고, 보기 권한과 보관된 Workspace에도 없다.

**입력:** 누르면 그 자리에 `새 챕터 이름` 입력란과 `추가`·`취소`가 열린다. 찾기 입력란에 글자가 있으면 그 글자로 시작한다. 이름은 CHMAN-01-C04를 따른다: 앞뒤 공백을 지우고 1~1000자, 비어 있으면 `추가`는 비활성이다. 같은 이름은 막지 않는다(챕터 관리와 같다). 한글 조합 중의 Enter는 제출이 아니다.

**결과:** 성공하면 목록에 새 장이 들어가고 그 장이 골라지며 popover가 닫히고 focus는 트리거로 돌아온다. 편집기에서는 다른 필드처럼 저장할 때 문제에 적용되고, 초안에서는 바로 저장된다. 저장하지 않아도 만든 장은 남는다(문제 없는 장). 실패하면 popover가 열린 채 입력은 그대로이고 role=alert가 CHMAN-01의 문구를 보인다. 재시도는 같은 `Idempotency-Key`다.

**키보드·터치:** 찾기 입력란 → 트리 → `새 챕터` 순으로 Tab이 간다. 입력란의 Enter는 추가, Escape는 입력을 닫고 focus를 `새 챕터`로 돌린다(popover는 열려 있다). 768px 미만 sheet에서도 같고 버튼은 44px 이상이다. modal panel 안에서도 picker 규칙 그대로다.

**챕터 관리:** 교재가 없거나 Workspace 챕터가 있으면 `Workspace 챕터` 묶음이 교재 묶음 뒤에 보인다. `챕터 추가`, 행 메뉴(이름 바꾸기·하위 챕터 추가·옮기기·삭제), 끌기, 문제 놓기가 교재와 같다. 교재가 없을 때의 빈 상태 문구를 이 묶음이 대신한다. 교재가 있고 Workspace 챕터가 없으면 묶음을 보이지 않는다.

**묶음 이름:** picker·재분배는 둘 이상의 묶음이 있을 때 `Workspace 챕터` 묶음 행을 보이고 닫힌 트리거는 `제목 (Workspace 챕터)`다.

**교재를 나중에 올려도** Workspace 챕터와 문제는 그대로다. 교재 장으로 옮기려면 챕터 재분배나 챕터 관리를 쓴다. 트리 사이 끌기는 지금처럼 거절된다.

## API 계약

### UX12-CHAPTERADD-C01 권한

Workspace 챕터 쓰기도 CHMAN-01-C01과 같다: `Action.DOCUMENT_EDIT`, 보기 권한 403 `insufficient-role`, 보관 403 `workspace-archived`, 다른 Workspace·없는 id는 같은 본문의 404, Share session에는 route가 없다. `near_chapter_id`·`parent_id`도 다른 Workspace면 404다.

### UX12-CHAPTERADD-C02 조회

`GET /workspaces/{id}/chapter-tree`에 `workspace: {title, version, chapters: [...]}`가 더해진다. `chapters` 모양은 CHMAN-01-C03의 장과 같고 `has_note`는 언제나 false, `user_created`는 언제나 true다.

### UX12-CHAPTERADD-C03 생성

`POST /workspaces/{id}/chapters` `{document_id?, parent_id?, title, near_chapter_id?}` → 201 `{chapter, version, document_id, document_title}`. `document_id: null`이면 Workspace 챕터다. `near_chapter_id`는 자리를 서버가 정하게 하며(위 규칙) `document_id`·`parent_id`와 함께 보내면 422다. 교재 쪽은 CHMAN-01의 오류를 그대로 쓴다(교정 발행 중 409 `publish-in-progress`). `Idempotency-Key`는 같은 규칙이다.

### UX12-CHAPTERADD-C04 이동·이름·삭제

`POST /workspaces/{id}/chapters/tree` `{expected_version, moves}` → 200 `{version, chapters}`, CHMAN-01-C05와 같은 규칙으로 Workspace 챕터 트리를 바꾼다. 교재의 장을 넣으면 404다. `PATCH /chapters/{id}`, `DELETE /chapters/{id}`는 같은 route이고 삭제 규칙은 CHMAN-01-C06과 같다: 문제가 있으면 옮길 곳이 필요하고 하위 장은 상위로 올라간다. 대상은 교재 장이나 다른 Workspace 챕터여도 된다.

### UX12-CHAPTERADD-C05 공통 효과

쓰기마다 `workspace_chapter_trees.version` 1 증가. 활동 기록은 `workspace.chapter_created`·`workspace.chapter_renamed`·`workspace.chapters_moved`·`workspace.chapter_deleted`이고 id와 개수만 담는다.

## 수용 기준

### UX12-CHAPTERADD-AC01

교재가 없는 Workspace에서 문제 편집기의 `챕터`를 열고 `새 챕터`를 눌러 `시험 범위 1`을 입력하고 `추가`를 누르면 popover가 닫히고 focus는 트리거에 있으며 트리거에 `시험 범위 1`이 보인다. 저장하면 그 문제가 그 챕터에 속하고 홈 Heatmap에 그 챕터 묶음이 보인다. 그 묶음에 `정리 노트` 버튼은 없다(본문이 없다).

### UX12-CHAPTERADD-AC02

교재가 있는 Workspace에서 교재 장을 고른 문제의 dropdown에서 만들면 새 장은 챕터 관리의 그 교재 맨 끝에 있다. 챕터 없는 문제에서 만들면 `Workspace 챕터` 묶음에 있다.

### UX12-CHAPTERADD-AC03

마우스 없이: 트리거에서 Enter, Tab으로 `새 챕터`에 가서 Enter, 입력란에 이름을 치고 Enter로 만들면 그 장이 골라지고 focus는 트리거다. 입력이 비어 있으면 `추가`는 비활성이다. 입력란의 Escape는 입력만 닫고 focus는 `새 챕터`이며 picker는 열려 있다. 찾기 입력란의 글자는 이름 입력란으로 이어진다.

### UX12-CHAPTERADD-AC04

폭 375px 터치 화면(홈의 modal 문제 편집기)에서 `새 챕터`는 44px 이상이고 sheet 안에서 눌리며, 만들면 sheet만 닫히고 편집기는 그대로 열려 있고 페이지에 가로 스크롤이 없다.

### UX12-CHAPTERADD-AC05

보기 권한 구성원은 홈 필터 picker에 `새 챕터`가 없고 `POST /workspaces/{id}/chapters`는 403이다. 편집 권한이어도 홈 필터 picker에는 `새 챕터`가 없다.

### UX12-CHAPTERADD-AC06

교재가 없는 Workspace의 `챕터 관리`는 빈 상태 대신 `Workspace 챕터` 묶음을 보인다. `챕터 추가`로 만들고, 이름을 바꾸고, `하위 챕터 추가`와 `내어쓰기`가 되고, 문제가 있는 장은 옮길 곳을 골라야 삭제되며 그 문제는 고른 곳으로 옮겨지고 풀이 기록은 그대로다. 새로 읽어도 남는다.

### UX12-CHAPTERADD-AC07

Workspace 챕터에 문제가 있는 Workspace를 공유하면 공유 문제 목록에 그 장 이름이 보이고 편집 도구는 없다. Fork한 Workspace의 `챕터 관리`에도 같은 장이 있고 문제가 그 장에 속하며 원본의 장 이름을 바꿔도 사본은 바뀌지 않는다.

### UX12-CHAPTERADD-AC08

문제지만 있는 Workspace의 가져오기 초안에서 `1번 문제 챕터`의 `새 챕터`로 장을 만들면 바로 그 초안의 챕터가 되고 다른 초안의 picker에도 보이며, 등록하면 문제가 그 장에 속한다.

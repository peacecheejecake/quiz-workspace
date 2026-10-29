# DOC-03 — 문서 전문 텍스트 내보내기

**상태:** 확정 화면 요구사항 v1.0 · DOCSUM-SPEC 신규 2026-10-29 (사용자 요청 "문서 전문 텍스트 변환")
**Route:** 진입점 두 곳 — 문서 관리 dialog `/workspaces/:workspaceId?panel=documents`(DOC-01)의 행 메뉴, DOC-02 `/workspaces/:workspaceId/documents/:documentId` header. 파일은 API `GET /api/v1/documents/{id}/text`가 내려준다.
**테스트:** `tests/e2e/documents/documents-export.spec.ts` (계약: `tests/integration/documents/test_document_text_export.py`)
**Phase:** DOCTXT.0 (RED) → DOCTXT
**연계:** [전체 아키텍처](../architecture.md) §6, [DOC-01](documents-library.md), [DOC-02](documents-editor.md), [공유 명세](../workspace-sharing.md) §8, [E2E 규칙](../e2e-strategy.md)

```yaml
id: DOC-03
route: /workspaces/:workspaceId?panel=documents (행 메뉴) · /workspaces/:workspaceId/documents/:documentId (header)
actor: workspace_member
permission: read (발행본) · edit (교정 중 초안)
status: confirmed
api: [GET /api/v1/documents/:id/text]
components: [DropdownMenu, IconButton, Toast]
linked_tests: [DOC-03-AC01, DOC-03-AC02, DOC-03-AC03]
```

## 목적과 범위

- 파싱·교정된 canonical text(발행 revision의 `content_blocks`)를 사람이 읽고 다른 도구에 붙일 수 있는 텍스트 파일로 내보낸다. PDF 원본은 바꾸지 않고, 내보내기는 서버 상태를 바꾸지 않는다(활동 기록 없음).
- **형식 두 가지:**
  - `Markdown (.md)` — 문서 제목은 `#`, 장·절은 outline 깊이에 따라 `##`부터(최대 `######`, 더 깊으면 `######` 유지). 문단은 빈 줄로 나누고, 목록 블록은 목록, 표 블록은 GFM 표(셀 안의 `|`는 escape), 그림·이미지 블록은 `[그림 p.N]` 자리표시(이미지 파일은 내보내지 않음). 각 쪽이 시작하는 자리에 `<!-- p.N -->` 주석을 둔다(N = PDF 쪽 번호, 1부터).
  - `텍스트 (.txt)` — 같은 순서의 일반 텍스트. heading은 줄 하나(번호·제목 그대로), 표는 셀을 탭으로 구분한 줄, 그림은 `[그림 p.N]`, 쪽 경계는 단독 줄 `[p.N]`.
  - 둘 다 UTF-8(BOM 없음), 줄바꿈 LF, 블록 순서는 outline·쪽 순서(DOC-02 원문 pane과 같음). 같은 revision을 같은 형식으로 두 번 내보내면 byte 단위로 같다(결정적).
- **revision:** 기본은 현재 발행본(published active revision). 편집 권한자는 교정 중 초안(아직 발행하지 않은 draft revision)도 내보낼 수 있다. 보기 권한자·공유 링크 게스트는 초안을 받을 수 없다.
- **대상 문서:** 처리가 끝난(준비 완료) 모든 종류(`교재`·`문제지`·`교재+문제`)의 PDF. 처리 중·실패한 문서는 내보낼 텍스트가 없다.
- **파일 이름:** `<문서 제목>.md` / `<문서 제목>.txt`(경로 구분자·제어 문자 제거, 120자 제한; 초안이면 `<문서 제목> (초안).md`). `Content-Disposition: attachment`(RFC 5987 `filename*` UTF-8).
- **공유 링크 게스트:** 내보내기 진입점과 API가 없다(사용자 결정 Q9 2026-10-29; 게스트는 DOC-02와 같은 화면에서 발행 원문을 읽을 수만 있다 — WS-VIEW-01).

## 레이아웃 및 컴포넌트

- **문서 관리 dialog 행 (DOC-01):** 준비 완료 행마다 `텍스트 내보내기` 아이콘 메뉴 버튼(Radix DropdownMenu, 접근성 이름 "<제목> 텍스트 내보내기", tooltip "텍스트 내보내기", 모든 구성원). 항목: `Markdown (.md)` · `텍스트 (.txt)`. 처리 중·실패 행에는 버튼이 없다. 위치는 `요약` 버튼(DOCSUM-01)과 휴지통 버튼 사이.
- **DOC-02 header:** `텍스트 내보내기` 메뉴 버튼(글자 버튼). 항목: `Markdown (.md)` · `텍스트 (.txt)` · `전체 복사`(현재 보고 있는 revision의 Markdown을 클립보드로; 끝나면 "복사했습니다" 상태 알림(`role="status"`), 실패하면 "복사하지 못했습니다. 파일로 내려받으세요."). 편집 권한자가 아직 발행하지 않은 교정본을 가진 경우 메뉴가 `발행본`·`교정 중 초안` 두 그룹(각 그룹에 Markdown·텍스트)을 보이고, `전체 복사`는 화면에 보이는 revision을 복사한다.
- 내려받는 동안 메뉴 버튼은 "내보내는 중"을 보이고 비활성(`aria-disabled`)이며, 실패하면 이유를 alert로 보인다(`document-not-ready` → "아직 처리 중인 문서입니다.", 그 밖 → "텍스트를 내보내지 못했습니다. 다시 시도하세요.").
- 키보드: 메뉴 버튼 Enter/Space로 열고 화살표·Enter로 고르며 Escape로 닫으면 focus가 메뉴 버튼으로 돌아온다.

## 화면 상태

| 상태 | 표시 |
|---|---|
| 준비 완료 문서 | 행 메뉴·DOC-02 메뉴 사용 가능 |
| 처리 중·실패 | 행에 메뉴 없음, API 409 `document-not-ready` |
| 보기 권한 | 발행본 Markdown·텍스트·전체 복사만, 초안 그룹 없음 |
| 보관된 Workspace | 내보내기 가능(읽기) |
| 삭제된 Workspace·문서, 다른 Workspace | API 404, 진입점 없음 |
| 공유 링크 게스트 | 진입점 없음, API 거부 |

## 수용 기준

### DOC-03-AC01

- **Given:** 보기 권한자가 연 Workspace 홈, 합성 교재 PDF(`book-ko.pdf`)가 준비 완료(장·절, 표, 그림이 있는 발행 revision)
- **When:** 문서 관리 dialog에서 `<제목> 텍스트 내보내기` 메뉴를 키보드로 열어 `Markdown (.md)`를 고르고, 이어서 `텍스트 (.txt)`를 고른다
- **Then:** `<제목>.md`와 `<제목>.txt`가 각각 내려받아진다. Markdown은 문서 제목 `#`, outline 깊이를 따르는 장·절 heading, GFM 표, `[그림 p.N]` 자리표시, 각 쪽 시작의 `<!-- p.N -->`를 갖고 블록 순서가 DOC-02 원문 pane과 같다. 텍스트 파일은 같은 순서에 `[p.N]` 쪽 줄을 갖는다. 같은 형식을 다시 내려받으면 내용이 같다. 메뉴를 Escape로 닫으면 focus가 메뉴 버튼으로 돌아온다.

### DOC-03-AC02

- **Given:** 편집 권한자가 DOC-02에서 블록 하나를 교정해 저장했지만 아직 발행하지 않은 문서(같은 Workspace에 보기 권한자도 있음)
- **When:** 편집 권한자가 header의 `텍스트 내보내기`를 열어 `교정 중 초안` › `Markdown (.md)`, `발행본` › `Markdown (.md)`, `전체 복사`를 차례로 고른다. 보기 권한자가 같은 DOC-02를 열고 메뉴를 연다
- **Then:** 초안 파일(`<제목> (초안).md`)에는 교정한 문장이, 발행본 파일에는 교정 전 문장이 있다. `전체 복사` 후 "복사했습니다"가 알려지고 클립보드의 내용이 화면에 보이는 revision의 Markdown과 같다. 보기 권한자의 메뉴에는 `교정 중 초안` 그룹이 없고, 보기 권한자가 `revision=draft`로 API를 직접 부르면 403이다.

### DOC-03-AC03

- **Given:** 처리 중인 문서와 준비 완료 문서가 있는 Workspace, 그 Workspace의 공유 링크 게스트 세션, 다른 Workspace의 사용자
- **When:** 문서 관리 dialog를 열고, 공유 화면(`/share/:shareId`)과 DOC-02와 같은 공유 문서 화면을 열고, 각 사용자로 `GET /api/v1/documents/{id}/text`를 직접 부른다
- **Then:** 처리 중인 행에는 `텍스트 내보내기` 메뉴가 없고 API는 409 `document-not-ready`다. 공유 화면에는 내보내기 진입점이 없고 공유 세션만으로는 API가 401이다. 다른 Workspace 사용자는 404다. 성공 응답은 `Cache-Control: private, no-store`와 `Content-Disposition: attachment`를 갖고, 내보낸 문서 본문은 API·worker 로그와 Playwright trace·artifact에 남지 않는다(log-audit·artifact-audit 0).

## 계약 요구사항 (pytest, 화면 AC 아님)

`tests/integration/documents/test_document_text_export.py`, `packages/core` unit test.

| ID | 요구사항 |
|---|---|
| DOC-03-C01 | 인가 matrix: owner·editor·viewer는 발행본 200; `revision=draft`는 owner·editor만(viewer 403); 초안이 없으면 `revision=draft`는 404 `draft-not-found`; 보관 Workspace 200(읽기); 삭제된 Workspace·문서와 다른 Workspace 404; 공유 세션 cookie만 있는 요청 401; 처리 중·실패 409 `document-not-ready`. Workspace는 문서에서 DB로 해석한다(클라이언트 `workspace_id` 불신). |
| DOC-03-C02 | `book_core.export.render_revision(revision, format)`은 순수 함수다: 합성 fixture(`book-ko.pdf`, `book-en.pdf`)의 golden 파일과 byte 단위로 같고, 표 셀의 `|`·줄바꿈 escape, heading 깊이 상한, 쪽 marker 위치(쪽의 첫 블록 앞)를 검증한다. |
| DOC-03-C03 | 응답 header(`no-store`, `attachment`, `X-Content-Type-Options: nosniff`, `text/markdown; charset=utf-8` / `text/plain; charset=utf-8`), 파일 이름 정규화(경로 문자·제어 문자 제거, 120자), 본문이 로그·활동 기록·job 결과에 남지 않음(log capture test). |

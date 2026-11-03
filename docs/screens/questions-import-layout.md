# QIMPORT-02 — 문제 PDF 가져오기 두 영역 배치 (검토할 PDF 목록 · 검토 상세)

**상태:** 확정 화면 요구사항 v1.0 · UX9-SPEC 신규 2026-11-02 (사용자 피드백 "문제 pdf 가져오기 Layout 변경 — 왼쪽에 전체 검토할 pdf 목록(문서 관리와 동일하게 각각의 제목, 상태 보여줌) — 오른쪽에 선택한 문서의 검토 상세", 사용자 결정 2026-11-02 D1; 제안 (s)(t)(u)는 같은 날 사용자 결정)
**Route:** 별도 route 없음 — QIMPORT-01 가져오기 페이지(`/workspaces/:workspaceId/questions/import?document=:documentId`)의 배치. 이 화면 ID는 QIMPORT-01(phase M4.0, CI에서 GREEN)에 새 AC를 더하지 않고 배치 변경을 따로 추적하기 위한 것이다(DOCVIEW-01이 DOC-02의 배치인 것과 같은 방식).
**테스트:** `tests/e2e/questions/questions-import-layout.spec.ts`
**Phase:** UX9.0 (RED) → UX9-IMPORT-W
**연계:** [QIMPORT-01](questions-import.md), [DOC-01](documents-library.md)(행 형식·상태), [Questions 명세](../questions.md) §6, [디자인 시스템](../design-system.md) §5·`StepProgress`, [E2E 규칙](../e2e-strategy.md)

```yaml
id: QIMPORT-02
route: (QIMPORT-01 화면 안 — /workspaces/:workspaceId/questions/import?document=:documentId)
actor: workspace_member (보기) · editor/owner (추출·검토·등록)
permission: read · edit
status: confirmed
api: [GET /api/v1/workspaces/:id/documents, GET /api/v1/question-imports/:id/draft-summaries, GET /api/v1/question-imports/:id/drafts]
components: [PageHeader, BackLink, Breadcrumb, Badge, StepProgress, ProgressBar, FloatingSidePanel, ConfirmDialog]
linked_tests: [QIMPORT-02-AC01 … QIMPORT-02-AC04]
```

## 목적과 정책

- **두 영역 (사용자 결정 D1):** 가져오기 페이지는 왼쪽 **검토할 PDF 목록**과 오른쪽 **선택한 PDF의 검토 상세**로 나뉜다. 위쪽의 `검토할 PDF` 선택 상자(UX6-UPLOAD)는 없어지고 왼쪽 목록이 그 일을 한다. 검토 상세는 지금의 검토 화면 그대로다(진행 표시·초안 목록·`전체 선택`·원본 비교·챕터·중복 표시·`선택한 문제 승인 및 등록`·등록 진행률 — QIMPORT-01 AC01~AC10 동작 불변).
- **목록에 나오는 PDF:** 이 Workspace의 살아 있는 PDF 중 (a) 추출 run이 있는 PDF(문서 목록 API의 `latest_import_id`), 그리고 (b) run은 없지만 종류가 `문제지`·`교재+문제`인 PDF(처리 중·처리 실패·확신이 낮아 `문제 추출`을 기다리는 PDF 포함). 문제가 없는 `교재`(run 없음)는 나오지 않는다 (사용자 결정 2026-11-02).
- **행 (문서 관리와 같은 내용):** 문서 관리(DOC-01) 행과 같은 부품으로 제목(넘치면 말줄임 + 전체 제목 tooltip·접근 가능한 이름), 종류 badge(`문제지`·`교재+문제`·`교재`), 상태 글자 — 처리 중(`업로드 → 분석 → 색인` 축약 `StepProgress`)·추출 중("문제 추출 중 k%" `ProgressBar`)·등록 중("등록 중 k/n")·완료("초안 n개 · 등록 m개")·추출 전("추출 전" + 편집 권한자에게 `문제 추출`)·실패("처리 실패"/"추출 실패", 글자). 상태는 색이 아니라 글자로 전한다. 순서는 최근 추출 순(run 없는 PDF는 그 뒤에 업로드 최신순) — 지금 선택 상자의 순서와 같다.
- **선택과 URL:** 선택한 PDF는 `?document=<id>`다. 행을 누르면 그 PDF의 검토로 바뀌며 기록 항목을 **하나 쌓는다**(push): 뒤로가기는 앞서 보던 PDF로, 앞으로가기는 다시 돌아온다(지금 선택 상자가 `?document=`로 이동하는 것과 같음). `?document=` 없이 들어오면 지금처럼 가장 최근 추출의 PDF를 고르고 주소를 그 `?document=`로 바꾼다(replace — 기록이 늘지 않음). 목록에 없는 id(다른 Workspace·삭제·문제 없는 교재)는 "PDF를 찾을 수 없습니다."와 목록을 보인다(404와 같은 응답 — 내용 누출 없음).
- **선택을 바꿀 때 고른 초안:** 오른쪽에서 고른(체크한) 초안이 있고 아직 등록하지 않았으면 다른 PDF를 누를 때 확인 dialog "선택한 초안 k개의 선택이 사라집니다. 다른 PDF로 바꿀까요?"를 보인다(`바꾸기`·`취소`) (사용자 결정 2026-11-02). 등록이 진행 중이면 확인 없이 바꾼다(서버에서 계속 — QIMPORT-01-AC07).
- **불러오기:** 목록은 문서 목록 API 한 번(요약 필드만)으로 그리고, 문서 관리처럼 진행 중인 행만 polling한다. 초안 요약·내용은 **선택한 PDF 것만** 읽는다 — QIMP-PAGING(요약 + 100개 페이지, 앞뒤 페이지 미리 읽기)과 QIMP-REVIEW-SCALE(챕터 선택 상자 지연 렌더링, 페이지 표시) 규칙은 그대로이고, 목록 행은 다른 PDF의 초안을 읽지 않는다. PDF를 바꾸면 이전 PDF의 초안 페이지 요청은 취소된다(늦은 응답이 새 PDF 화면을 덮지 않음).
- **권한:** 모든 구성원이 목록과 검토를 본다(지금과 같음). `문제 추출`·초안 편집·등록은 편집 권한·활성 Workspace만(서버 규칙 그대로).

## 레이아웃 및 컴포넌트

- **데스크톱(≥ 1024px):** 페이지 header(뒤로가기·breadcrumb `Workspace 이름 › 문제 PDF 가져오기`, QOV-01-AC13) 아래 두 열. 왼쪽 열 폭 `--outline-panel-width`(20rem), 자체 scroll·화면 높이에 붙음(sticky), 제목 "검토할 PDF (n)"(`h2`). 오른쪽 열은 남은 폭 전체이며 지금의 검토 화면이다. **제목 구조 (사용자 결정 2026-11-02):** 페이지 `h1`은 그대로 "문제 PDF 가져오기"이고(breadcrumb의 현재 항목과 같음), 오른쪽 검토 영역은 자기 제목 `h2` = 고른 PDF의 제목(넘치면 줄바꿈, 말줄임 없음)을 가진다; 왼쪽 목록 제목 "검토할 PDF (n)"도 `h2`다. 검토 영역은 `region`이고 이름은 그 `h2`(`aria-labelledby`)다. 두 열 사이 1px `--color-border` 구분선(크기 조절 없음).
- **태블릿(768–1023px):** 같은 두 열이고 왼쪽 열은 16rem.
- **좁은 화면(< 768px) (사용자 결정 2026-11-02):** 목록 열이 없고 검토 위에 "검토할 PDF" 버튼(지금 PDF 제목 + 상태 글자, `aria-haspopup="dialog"`)이 있다. 누르면 같은 행 목록을 modal bottom sheet(`FloatingSidePanel` 모바일 레이아웃, 제목 "검토할 PDF"; HOMEDLG-01과 같은 modal·배치 고정)로 열고 행을 누르면 바뀐 뒤 닫힌다. 대안: 목록을 검토 위에 접을 수 있는 영역으로.
- **목록 semantics:** `nav`(이름 "검토할 PDF") 안의 `ul` + 행마다 링크(`<a href="?document=<id>">`, 지금 PDF는 `aria-current="page"` + 굵기·배경 `--color-state-selected` — 색만이 아님). `문제 추출` 버튼은 링크 밖 같은 행의 별도 버튼(편집 권한). Tab은 행 링크·버튼을 차례로 지나고 Enter가 연다. 선택한 PDF를 바꾸면 focus는 오른쪽 검토 영역의 제목(`h2` = 고른 PDF 제목, `tabindex="-1"`)으로 가고 목록의 scroll 위치는 그대로다. `?document=` 없이 들어오거나 새로 고침해 처음 그릴 때는 focus를 옮기지 않는다(페이지 기본 focus).
- **빈 상태:** 목록에 PDF가 하나도 없으면 두 열 대신 지금의 빈 상태("추출된 문제가 없습니다. 문서 관리에서 PDF를 올리면 문제가 있는 PDF는 자동으로 추출됩니다." + 편집 권한 `문서 관리 열기`)를 전체 폭으로 보인다. PDF가 하나여도 목록 열을 보인다(한 행).
- **선택한 PDF가 run 없음:** 오른쪽에 "아직 추출하지 않았습니다."(+ 편집 권한 `문제 추출`, 처리 중이면 진행, 실패면 이유)를 보인다.
- 불러오는 동안 목록 열과 오른쪽 모두 skeleton(route `loading.tsx`, QOV-01-AC09). 375px에서 페이지 가로 스크롤 없음.

## 수용 기준

### QIMPORT-02-AC01

- **Given:** 추출 run이 있는 문제지 A(초안 3개, 등록 1개)·교재+문제 B(초안 2개), run이 없고 확신이 낮은 교재+문제 C, 처리 중인 문제지 D, 교재 E(문제 없음)가 있는 Workspace(편집 권한, 데스크톱 1280px)
- **When:** 문서 관리의 A 행 `문제 검토`로 가져오기 페이지를 연다
- **Then:** 왼쪽에 `nav` "검토할 PDF" 목록이 A·B·C·D 네 행(E 없음)을 최근 추출 순으로 보이고, 각 행은 문서 관리와 같은 제목·종류 badge와 상태 글자(A "초안 3개 · 등록 1개", B "초안 2개 · 등록 0개", C "추출 전" + `문제 추출`, D 처리 단계 표시)를 보인다. A 행은 `aria-current="page"`이고 오른쪽은 A의 검토(초안 3개, `전체 선택`, 등록 버튼)다. 페이지 `h1`은 "문제 PDF 가져오기"이고 오른쪽 검토 영역의 `h2`는 A의 제목이다(목록 제목 "검토할 PDF (4)"도 `h2`). 위쪽 `검토할 PDF` 선택 상자는 없다. 목록을 그리는 동안 다른 PDF의 초안 요청(`draft-summaries`·`drafts`)이 없다.

### QIMPORT-02-AC02

- **Given:** AC01의 페이지(A 선택)와 그 전에 Workspace 홈을 연 기록
- **When:** B 행을 click하고, 키보드로 A 행 링크에 Tab해 Enter를 누르고, 뒤로가기·앞으로가기를 누르고; `?document=` 없이 페이지 URL을 열고; 다른 Workspace의 문서 id로 `?document=`를 연다
- **Then:** B를 누르면 URL이 `?document=<B>`가 되고 오른쪽이 B의 검토로 바뀌며 검토 영역의 `h2`가 B의 제목이 되고 focus가 그 `h2`로 간다; 페이지 `h1`은 "문제 PDF 가져오기" 그대로다. 키보드 Enter도 같다. 뒤로가기는 앞서 보던 PDF(B)로, 다시 뒤로가기는 A로, 앞으로가기는 B로 돌아온다(행마다 기록 항목 하나). `?document=` 없이 열면 가장 최근 추출의 PDF가 선택되고 주소가 그 `?document=`로 바뀌되 기록이 늘지 않는다(그 뒤 뒤로가기는 홈). 다른 Workspace의 id는 "PDF를 찾을 수 없습니다."와 목록을 보이고 그 문서의 이름·초안이 응답에 없다.

### QIMPORT-02-AC03

- **Given:** 초안 512개가 있는 문제지 A와 초안 2개가 있는 B의 가져오기 페이지(편집 권한, A 선택)
- **When:** A의 초안 3개를 체크한 뒤 B 행을 누르고 확인 dialog에서 `취소`, 다시 B를 눌러 `바꾸기`를 누르고; A로 돌아와 초안 페이지 3으로 간 뒤 빠르게 B를 누른다
- **Then:** 체크한 초안이 있으면 확인 dialog "선택한 초안 3개의 선택이 사라집니다. 다른 PDF로 바꿀까요?"가 열리고 `취소`는 A와 선택을 그대로 둔다. `바꾸기`는 B로 바꾼다(A의 선택은 사라짐). A의 초안은 지금처럼 요약 + 100개 페이지로 읽히고(QIMP-PAGING) 챕터 선택 상자는 열 때만 목록을 그린다(QIMP-REVIEW-SCALE). 페이지 3 요청 중에 B로 바꾸면 늦게 온 A의 응답이 B 화면을 바꾸지 않는다.

### QIMPORT-02-AC04

- **Given:** AC01과 같은 Workspace(375px 휴대폰 터치, 그리고 보기 권한 멤버의 데스크톱), 그리고 문제 PDF가 하나도 없는 Workspace
- **When:** 휴대폰에서 페이지를 열고 "검토할 PDF" 버튼을 탭해 B 행을 탭하고; 보기 권한 멤버가 페이지를 열고; 문제 PDF가 없는 Workspace에서 페이지를 연다
- **Then:** 휴대폰에서는 목록 열 없이 검토 위에 지금 PDF 제목과 상태를 가진 "검토할 PDF" 버튼이 있고, 탭하면 같은 행 목록이 bottom sheet로 열리며 B를 탭하면 B의 검토로 바뀌고 sheet가 닫힌다; 페이지 가로 스크롤이 없다. 보기 권한 멤버는 같은 목록과 검토를 보지만 `문제 추출`·등록·편집 동작이 없다. 문제 PDF가 없으면 목록 없이 "추출된 문제가 없습니다…" 빈 상태만 보인다.

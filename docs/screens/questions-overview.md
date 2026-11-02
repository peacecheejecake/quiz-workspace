# QOV-01 — Questions Heatmap 홈

**상태:** 확정 화면 요구사항 v1.3 · UX3c 개정 2026-10-20 (Workspace 홈 통합) · UX4 개정 2026-10-21 (header 버튼 묶음·`문제` 메뉴) · UX6-PROGRESS 개정 2026-10-28 (`문제은행` 버튼 → `문제` 메뉴의 `전체 문제`) · UX6-BANK 개정 2026-10-28 (문제은행 페이지 이름도 `전체 문제`) · UX7-BANK 개정 2026-11-01 (전체 문제 페이지 폐기: 직접 추가는 홈 위 dialog, 편집·삭제는 풀이 panel) · UX7-DOCS 개정 2026-11-01 (`PDF 관리` 항목 폐기, 문서 관리로 통합) · UX7-SEARCH 개정 2026-11-01 (문제·본문 검색창 분리) · UX7-BACK 개정 2026-11-01 (닫은 dialog를 뒤로가기로 다시 열지 않음) · UX7-DOCS-2 개정 2026-11-01 (`문제` 버튼은 편집 권한이 없어도 보이고 항목은 이유와 함께 비활성) · UX7-BACK-2 개정 2026-11-01 (닫은 dialog는 앞으로가기로도 다시 열지 않음, 뒤로가기 한 번에 dialog 하나) · UX7-BANK-2 개정 2026-11-01 (`보관·초안 문제` dialog) · UX7-DEDUP 개정 2026-11-01 (`중복 문제 정리` dialog, 합친 풀이 기록)
**Route:** `/workspaces/:workspaceId` (이전 `/workspaces/:workspaceId/questions`는 같은 query로 redirect)
**테스트:** `tests/e2e/questions/questions-overview.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- 상태 토큰: unseen=lightgray, viewed=gray, incorrect=red, correct=green, retry=yellow(최상위 우선순위).
- 일반 마커 rounded square, 즐겨찾기 rounded star(크기 동일). Hover/focus scale=1.18, 고정 Grid 셀, 키보드/스크린리더 대응.
- 마커 사이 보이는 간격은 마커 폭의 1/3 이하(UX5-UI 2026-10-23): 셀 24px(touch 32px)·grid gap 0, 마커 18px(touch 24px). 크기 규격은 [디자인 시스템](../design-system.md) §6.
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.

## Workspace 홈 레이아웃 (UX3c 2026-10-20)

이 화면이 Workspace의 유일한 홈이다. Workspace 왼쪽 메뉴(문서/검색/문제/이력/공유 설정)는 없다.

1. **Workspace header**(홈 최상단, 화면 제목·설명 없음; 접근성 `h1`은 Workspace 이름을 시각적으로 숨겨 둔다)
   - 왼쪽: 문제 검색 입력란(접근성 이름 "문제 검색", 검색 버튼 없이 입력하는 대로 Heatmap을 거름 — SEARCH-01-AC12)과 그 옆 "문제 설정" popover 버튼(챕터·유형), 그 아래 "본문 검색" 펼치기 버튼(기본 접힘, SEARCH-01-AC10). 이전 통합 검색창과 검색 범위 체크박스는 없다(UX7-SEARCH 2026-11-01, search.md).
   - 오른쪽 버튼은 두 묶음이다(UX4 2026-10-21). 첫 묶음: `문서 n`(등록된 책 문서 수 — UX6-UPLOAD부터 본문이 있는 PDF(`교재`·`교재+문제`) 수, 문서 관리 dialog) · `문제`(메뉴 버튼, 아래). 별도의 `문제은행` 버튼은 없다(UX6-PROGRESS 2026-10-28, 사용자 피드백 "문제은행 버튼은 '문제' dropdown menu 안으로 이동, 문구는 '전체 문제'로 변경"). 둘째 묶음(오른쪽 정렬): `이력`(아이콘 버튼, 이력 dialog) · `공유하기`(Owner만; `이력`과 같은 흰색(secondary) 아이콘 버튼, 접근성 이름·tooltip "공유하기", 링크 공유 dialog).
   - `문제` 메뉴(Radix DropdownMenu, `aria-haspopup="menu"`, 화살표·Enter·Escape 키보드 조작): `직접 추가`(홈 위에 "문제 등록" dialog를 연다: `?panel=question-create`, AC12) · `변형 출제`(문제 생성 dialog `?panel=generate`, QGEN-01-AC05) · `중복 문제 정리`(UX7-DEDUP, 아래 "중복 문제 정리 dialog", `?panel=question-duplicates`, AC16). `문제` 버튼은 편집 권한이 없어도(보기 권한, 보관된 Workspace) 숨기지 않는다(UX7-DOCS-2 2026-11-01, 사용자 결정 "문제 버튼: Do not hide"; UX7-DOCS의 숨김 제안 기각). `직접 추가`·`변형 출제`·`중복 문제 정리`는 편집 권한에만 쓸 수 있으므로 그 밖에는 비활성 항목(`aria-disabled="true"`, 화살표 키는 건너뜀, 골라도 아무 일 없음)으로 보이고, 그 아래 글자로 이유를 보인다: 보기 권한 "편집 권한이 있어야 사용할 수 있습니다", 보관된 Workspace "보관된 Workspace는 읽기 전용입니다"(보관이 우선). 이유는 색이나 흐림만이 아니라 글자로 보이며(touch에는 tooltip이 없으므로 tooltip에만 두지 않는다), 비활성 항목과 메뉴의 `aria-describedby`로 연결된다. 보기 권한자도 쓸 수 있는 항목은 같은 메뉴에 활성 항목으로 함께 둔다: 구분선 아래 `보관·초안 문제`(UX7-BANK-2, 모든 구성원·보관된 Workspace에서도 활성, 아래 "보관·초안 문제 dialog"; 이후 `모의고사`·`문제 풀기`도 같은 방식). `PDF 관리`(문제 PDF 관리 dialog `?panel=question-pdfs`) 항목은 없다(UX7-DOCS 2026-11-01, 사용자 "문제 Pdf 관리를 문서 관리로 통합": 문제 PDF는 `문서 n`의 문서 관리 dialog에서 다룬다, DOC-01-AC09; 이전 URL은 `?panel=documents`로 redirect). `전체 문제` 항목과 전체 문제 페이지(QBANK-01)는 없다(UX7-BANK 2026-11-01, 사용자 결정 "'전체 문제' 페이지 삭제. 문제 편집/삭제만 홈으로 옮기면 될듯. 나머지는 이미 홈에 있음" — 폐기 기록 [questions-bank.md](questions-bank.md)). 이전 URL `/questions/bank`는 홈으로 redirect한다(`?question=`만 유지).
   - **문제 등록 dialog (UX7-BANK):** `직접 추가`와 빈 Heatmap의 `문제 등록`은 같은 "문제 등록" dialog(기존 문제 편집기: 유형·문제 내용·보기·정답·챕터·문제 번호·출처)를 홈 위에 연다. 입력 중 다른 곳을 실수로 누르지 않도록 modal dialog이고 URL에 `?panel=question-create`를 남긴다(다른 dialog와 달리 쌓기·옆으로 비키기 대상이 아니다). 챕터·출처 문서 목록은 dialog가 열린 뒤 불러온다. 저장하면 확정 문제로 등록되고 dialog가 닫히며 Heatmap이 새로 읽혀 그 챕터에 점이 생긴다. 닫으면(취소·Escape·저장) `question-create`가 URL에서 빠진다. 보기 권한·보관된 Workspace에서는 열리지 않는다(`?panel=question-create`도 무시).
   - **보관·초안 문제 dialog (UX7-BANK-2 2026-11-01, 사용자 결정 A "floating dialog"):** 전체 문제 페이지의 상태 필터 `초안`·`보관됨`과 그 목록을 홈으로 되살린다(폐기 기록 [questions-bank.md](questions-bank.md)). `문제` › `보관·초안 문제`는 non-modal FloatingSidePanel "보관·초안 문제"(`?panel=inactive-questions`, 4의 쌓기·뒤로가기 규칙, 문서 관리와 같은 모양)를 연다. Heatmap에 보이지 않는 문제만 다룬다: `초안`(publication_status DRAFT — 직접 등록 API로 만든 미완성 문제. 문제 PDF·변형 출제의 검토 대기 초안(question_drafts)은 문제가 아니므로 여기 없다)과 `보관됨`(ARCHIVED).
     - **상태 필터:** `상태` Select — `전체`(초안+보관됨, 기본) · `초안` · `보관됨`. 전체 문제 페이지의 `확정 문제`·`전체 상태`는 Heatmap이 확정 문제를 보이므로 두지 않는다. 이 dialog의 `전체`는 확정 문제를 뺀 초안+보관됨이고, 필터는 URL에 남기지 않는다(dialog를 열 때마다 `전체`) — 사용자 결정 2026-11-01(UX7 확인 7).
     - **목록:** 전체 문제 페이지 순서(정렬 순서·문제 번호·등록 순)대로 50개씩, 더 있으면 목록 끝의 `더 보기`(전체 문제 페이지와 같은 cursor paging). 행마다 문제 번호·유형·상태 badge(`초안`/`보관됨`, 글자)·챕터, 문제 내용 앞부분(버튼, 누르면 상세). 불러오는 동안 skeleton 문구 "문제를 불러오는 중입니다.", 실패하면 role=alert와 `다시 시도`, 비면 "보관하거나 초안인 문제가 없습니다"(필터가 `초안`/`보관됨`이면 그 상태의 문구) 빈 상태.
     - **상세:** 행의 문제 내용을 누르면 풀이 panel의 "문제 상세" dialog(QPLAY-01 "정답·해설·이력 보기", 같은 component)가 그 문제로 열린다: 문제·보기·정답·해설·출처·수정 이력, 읽기 전용.
     - **편집 권한(보관되지 않은 Workspace):** 보관된 행에 `보관 해제`(확정으로 되돌림), 초안 행에 `확정`(내용이 다 갖춰져야 함 — 아니면 서버 422 문구를 알림으로 보임) 버튼이 있다. 상세 dialog의 footer에는 그 상태의 같은 버튼과 `편집`(문제 편집 dialog), `삭제`(확인 dialog)가 있다 — 전체 문제 상세 panel의 초안(확정·편집·삭제)·보관(보관 해제·편집·삭제) 동작과 같다. `보관 해제`·`확정`한 문제는 목록에서 빠지고 Heatmap에 점으로 다시 나타난다.
     - **보기 권한·보관된 Workspace:** 목록·필터·상세는 같고 `보관 해제`·`확정`·`편집`·`삭제`가 없다(서버도 거절). 보관된 Workspace에는 dialog 위에 "보관된 Workspace는 읽기 전용입니다." 문구를 보인다. AC15.
   - **중복 문제 정리 dialog (UX7-DEDUP 2026-11-01, 사용자 요청 "중복 문제 제거 기능"; 규칙 [questions.md](../questions.md) §10):** `문제` › `중복 문제 정리`(편집 권한, 보관되지 않은 Workspace — 그 밖에는 위 비활성 규칙)는 non-modal FloatingSidePanel "중복 문제 정리"(`?panel=question-duplicates`, 4의 쌓기·뒤로가기 규칙)를 연다. 열면 바로 Workspace의 확정 문제를 검사한다("중복 문제를 찾는 중입니다." skeleton, 실패하면 role=alert와 `다시 시도`). 같은 문제(객관식은 정규화한 발문 + 보기, 단답형·서술형은 발문 + 모범답안; 보기 순서·번호 형식·문장부호·띄어쓰기·끝의 `( )` 무시)가 없으면 빈 상태 "중복 문제가 없습니다".
     - **묶음:** 묶음마다 제목 "중복 묶음 n · 문제 k개"와 `이 묶음 정리` 체크박스(기본 체크)가 있고, 문제마다 `남길 문제` 라디오(묶음이 radiogroup, 이름 "중복 묶음 n 남길 문제") — 기본은 서버 추천: 구성원들의 채점된 풀이가 가장 많은 문제, 같으면 가장 먼저 등록된 문제(사용자 결정 2026-11-01; 풀이 수는 보이지 않는다) — 와 문제 번호·챕터·등록일·발문·보기(정답 표시 없음)를 보인다. 정답이 서로 다른 객관식 묶음은 "정답이 서로 다릅니다 — 남길 문제를 확인하세요" 경고를 글자로 보이고 정리는 그대로 할 수 있다(사용자 결정 2026-11-01).
     - **정리:** `선택한 묶음 정리 (k)`(k = 체크한 묶음에서 보관될 문제 수)를 누르면 확인 dialog "중복 문제 k개를 보관할까요?"(설명: "남길 문제에 풀이 기록이 합쳐집니다. 보관·초안 문제에서 보관 해제하면 되돌릴 수 있습니다.")가 열리고, `보관`을 누르면 서버가 나머지를 보관하고 기록을 합친다(`POST …/question-duplicates/merge`). 끝나면 알림 "중복 문제 k개를 보관했습니다."을 보이고 다시 검사하며(정리한 묶음은 없어진다) Heatmap과 열린 `보관·초안 문제` 목록을 다시 읽는다. 정리는 API 한도(요청당 100묶음·묶음당 중복 50개) 안에서 여러 요청으로 나눠 보낸다(같은 묶음의 조각은 같은 남길 문제로, 요청마다 멱등; Codex P2). 한 요청이 실패하면(그 사이 바뀜 409 등) 멈추고 role=alert로 "중복 문제 n개를 보관했습니다. 남은 문제는 정리하지 못했습니다. <이유>"와 `이어서 정리`(남은 요청을 같은 남길 문제로 다시 보냄)·`다시 검사`를 보이며, 그동안 `선택한 묶음 정리`와 묶음의 `이 묶음 정리`·`남길 문제`는 비활성이고(이어서 정리는 저장된 계획을 보내므로 바꾼 선택이 무시되지 않도록; Codex P2) 그 옆에 "이어서 정리하거나 다시 검사한 뒤 바꿀 수 있습니다"를 글자로 보이며 `aria-describedby`로 연결한다.
     - **합친 기록:** 남길 문제의 점은 보관된 중복의 풀이 기록까지 합친 상태다 — 마지막 채점 결과는 묶음에서 가장 늦은 채점, 즐겨찾기·다시 풀기는 합집합, 한 번이라도 열었으면 열람. 보관한 문제는 `보관·초안 문제`(`보관됨`)에 있고 `보관 해제`하면 합침이 풀려 자기 기록으로 Heatmap에 돌아온다. AC17.
     - **접근성 검사:** 품질 suite `A11Y-13`(`tests/e2e/quality/a11y.spec.ts`)이 묶음(라디오·체크박스·정답 경고)·확인 dialog·멈춘 정리(계획 고정과 이유 글자)·빈 상태를 axe(light·dark)로 검사한다.
     - **보기 권한·보관된 Workspace:** 메뉴 항목이 비활성(이유 글자)이고 `?panel=question-duplicates`로 와도 dialog가 열리지 않으며, 서버는 검사·정리를 거절한다(viewer 403 `insufficient-role`, 보관 403 `workspace-archived`). AC16.
   - 버튼 문구는 줄바꿈하지 않는다. 좁은 화면(375px)에서는 묶음과 버튼이 버튼 단위로 다음 줄로 넘어가고 페이지 가로 스크롤은 없다.
2. **본문 검색**(기본 접힘, UX7-SEARCH): 펼치면 header 아래, Heatmap 위에 본문 검색 입력란·검색 버튼·"본문 설정"이 나타나고, 검색하면 그 아래 "본문 검색 결과" 영역이 나타나며 "검색 결과 닫기"로 지운다. 결과 항목을 누르면 오른쪽 "본문 발췌" panel에 검색어 주변 내용을 보인다(SEARCH-01-AC11).
3. **문제 영역**(기존 QOV-01 내용): 도구 줄에 상태 필터 펼치기 버튼(기본 접힘, 위/아래 화살표 아이콘, `aria-expanded`·`aria-controls`)만 둔다. 문제 수 문구("현재 필터의 문제 n개")와 `문제 PDF 관리`·`문제 생성` 버튼은 없다(UX4; header의 `문제` 메뉴로 옮김). 접힌 상태에서 상태 필터가 적용 중이면 "상태 필터 적용 중" 문구를 보인다. 펼치면 상태 필터(색 견본 + 상태 텍스트, 즐겨찾기만·다시 풀기만, 필터 초기화); 칩은 크기를 유지한 채 칩 단위로 줄바꿈하며 좁은 화면에서도 찌그러지거나 가로 스크롤되지 않는다. 그 아래 Heatmap. 상태 범례와 상태별 집계(문제 상태 요약)는 두지 않는다 — 상태는 marker의 접근성 이름·preview popover·상태 필터의 텍스트로 전달하고 색만으로 전달하지 않는다. 문제가 없을 때 빈 상태의 버튼은 `문제 등록`(홈 위의 문제 등록 dialog, UX7-BANK) 하나이며 홈의 다른 "PDF 가져오기" 버튼은 없다.
4. **Floating dialog**: 문서 관리(DOC-01; 문제 PDF 관리는 UX7-DOCS에서 여기로 통합), 문제 생성(QGEN-01), 이력(HISTORY-01), 링크 공유(WS-SHARE-01)는 모두 공통 `FloatingSidePanel`(non-modal)로 홈 위에 뜨고 URL `?panel=`에 반영된다(딥링크·이전 경로 redirect). 여러 개를 열 수 있고 나중에 연 dialog가 위에 온다. 문제 풀이 panel(QPLAY-01, `?question=`)도 같은 규칙.
   - **뒤로가기 (UX7-BACK 2026-11-01, 사용자: "floating 영역(예: 문서 관리)를 열기 -> 닫기 -> 뒤로(back button) 했을 때 floating dialog가 열리지 않게"; UX7-BACK-2 2026-11-01, 사용자 결정: "모든 경우에, 닫힌 dialog는 history에 포함하지 않음. dialog가 열려 있을 때는 back button 당 하나의 dialog를 닫는다. dialog가 닫히면 이전의 address로 돌아간다."):** dialog·panel(문서 관리·문제 생성·이력·링크 공유·정리 노트·문서 요약·보관·초안 문제(UX7-BANK-2)·중복 문제 정리(UX7-DEDUP)·문제 등록 dialog `?panel=question-create`·문제 풀이 panel `?question=`)을 열면 기록 항목이 하나 생기고(풀이 panel의 이전/다음, 다른 문서의 요약, 다른 장의 정리 노트도 하나씩), dialog가 열려 있는 동안 뒤로가기 한 번은 마지막 열기 하나만 되돌린다: 맨 위 dialog 하나가 닫힌다. 문제 풀이 panel(`?question=`)과 범위 풀이 panel(`?practice=`, QVIEW-01)은 동시에 열리지 않는다: 하나를 열면 다른 하나를 닫은 뒤 연다(닫힌 쪽은 아래 규칙대로 어느 방향의 기록에도 남지 않고, 새로 연 쪽은 뒤로가기 한 번에 닫힘), 둘을 함께 가진 주소는 범위 풀이만 연다(사용자 결정 2026-11-02, QVIEW-01-AC09). 풀이 panel의 이전/다음, 요약 panel의 문서 바꾸기, 정리 노트의 장 바꾸기는 dialog 닫기가 아니다: 뒤로가기는 panel을 연 채 앞 문제·문서·장으로 돌아가고 앞으로가기는 다시 뒤로 간다(QPLAY-01, 열린 동안 뒤로/앞으로/새로 고침이 문제를 복원). **닫힌 dialog는 어느 방향의 기록에도 남지 않는다**: 닫기 버튼·Escape·저장·삭제로 닫든 뒤로가기로 닫든, 그 뒤의 뒤로가기도 앞으로가기도 그 dialog를 다시 열지 않는다. 닫으면 그 dialog를 열기 전 주소로 돌아가되, 열려 있는 동안 바꾼 필터·검색어는 닫는 방법(닫기 버튼·Escape·저장·삭제·뒤로가기)과 상관없이 유지한다(닫은 주소 = 지금 주소에서 그 dialog만 뺀 것; 사용자 결정 UX7 확인 7 2026-11-01). 그래서 dialog가 열린 동안 본문 검색을 바꾼 뒤의 뒤로가기는 dialog만 닫고 새 검색어를 남긴다(SEARCH-01-AC09). 아직 열려 있는 다른 dialog가 있으면 남고 다음 뒤로가기가 그중 맨 위를 닫는다; 열린 dialog가 없으면 뒤로가기는 홈에 오기 전 페이지로 간다. 딥링크처럼 첫 로드에 dialog가 열려 있으면(`?panel=history`, `?question=`, 여러 개도) 그것들도 연 순서대로 열린 것으로 친다: 뒤로가기 한 번에 맨 위 하나씩 닫히고, 다 닫힌 뒤의 뒤로가기가 이전 페이지로 간다(사용자 결정 UX7 확인 7); 그 dialog를 버튼으로 닫아도 홈에 머문다(사이트를 떠나지 않음). 딥링크로 연 dialog가 열린 채 새로 고침해도 같다. 새로 고침 전에 연 dialog를 닫으면 열기 전 주소로 돌아간다(사용자 확인 2026-11-01). **구현 방식:** 브라우저에는 앞으로 기록을 지우는 API가 없어 앞으로 기록은 새 항목을 쓸 때만 잘린다. 그래서 dialog가 닫히면(버튼이든 뒤로가기든) 닫힌 주소의 항목을 하나 새로 써서 앞으로 기록(닫힌 dialog)을 자르고, 그 바로 아래 항목(그 dialog를 열기 전 항목을 닫은 주소로 고쳐 쓴 것)은 "건너뛸 항목"으로 표시해 뒤로가기는 그 아래로, 앞으로가기는 그 위로 곧바로 지나간다. 버튼으로 닫을 때는 먼저 첫 dialog를 열기 전 항목으로 돌아가(`history.go`) 그 위에 쓴다. 맨 위(가장 나중에 연) dialog만 닫고 아래 dialog가 남으면 그 dialog를 열기 전 항목까지만 돌아간다(그 항목에는 남는 dialog가 그대로 열려 있다): Chromium은 popstate 전에 지나가는 항목을 먼저 그리므로, 남는 dialog가 없는 항목을 지나면 그 dialog가 다시 마운트되어 상태와 focus 복귀 대상을 잃는다. 아래 dialog를 닫거나(그 위 dialog가 남음) 나중에 다시 앞으로 올린 dialog를 닫을 때는 여전히 첫 dialog 전 항목까지 돌아가므로 Chromium에서 남는 dialog가 다시 마운트될 수 있다(브라우저 한계). 닫은 주소가 그 항목과 필터·검색어까지 다르면 그 항목은 Next.js router(`router.replace`)로 고쳐 써서(그 화면을 다시 읽음) Next.js가 저장한 화면과 주소가 어긋나지 않게 하고, 다 읽은 뒤에 건너뛸 항목과 그 위 복사본을 쓴다(그 사이 짧게 앞으로 기록이 남아 있다). 첫 로드에 dialog가 열려 있으면 홈은 지금 항목을 dialog를 모두 닫은 주소로 바꾸고 dialog를 하나씩 다시 연 항목을 그 위에 쓴다(dialog 매개변수만 다르므로 보이는 화면은 그대로이고, Next.js에는 알리지 않는다). 새로 고침 뒤에 닫아 그 항목이 이전 문서의 것이면 돌아가며 그 문서를 다시 읽고, 닫기는 그 문서에서 마무리된다(sessionStorage로 넘김). 새로 고침 뒤 브라우저 뒤로가기가 이전 문서의 항목을 다시 읽어도 마찬가지다: 홈 문서는 떠날 때(pagehide) 있던 항목과 주소(경로와 query만, fragment는 쓰지 않음)를 이 탭의 sessionStorage에 남기고(30초 뒤 무효, 한 번만 읽음), 다음 문서가 그 뒤로가기가 dialog를 닫았으면 같은 규칙으로 닫은 주소(열려 있는 동안 바꾼 필터·검색어 유지)를 쓰고 앞으로 기록을 자른다. **브라우저 한계:** (1) 브라우저 뒤로가기 버튼을 길게 눌러 여는 기록 목록에는 홈이 두 번(건너뛸 항목) 보일 수 있고, 그 목록에서 건너뛸 항목을 직접 고르면 그 항목(닫힌 홈)에 머문다. (2) iOS Safari의 스와이프 뒤로가기는 건너뛸 항목의 snapshot(같은 홈)까지 움직인 뒤 이전 페이지로 이어서 이동한다. (3) Chromium은 window의 popstate listener를 등록 순서대로 부르므로 Next.js가 건너뛸 항목(같은 닫힌 홈)을 한 번 그릴 수 있다(dialog는 열리지 않는다). WebKit은 capture listener를 먼저 불러 그리지 않는다. (4) 탭의 첫 기록 항목에서 연 dialog를 닫으면, Navigation API(`navigation.canGoForward`)가 없는 브라우저에서는 그 뒤 첫 뒤로가기가 화면을 바꾸지 않는다(더 뒤로 갈 기록이 없음). (5) 다른 문서에서 앞으로가기로 건너뛸 항목에 오면(WebKit처럼 홈 문서를 새로 읽는 경우) 그 항목(닫힌 홈)에 머물고 다음 앞으로가기도 같은 닫힌 홈이다; WebKit은 그 앞으로가기에서 Next.js가 같은 주소를 한 번 더 읽을 수 있다. (6) 위 문서 사이 처리는 sessionStorage에 기대므로, 저장소가 막혀 있거나 문서를 다시 읽는 데 30초가 넘게 걸리면 새로 고침 뒤 뒤로가기로 닫은 dialog가 앞으로가기로 다시 열릴 수 있다; 브라우저가 문서를 다시 읽으며 그 항목의 history state(우리 표시)를 잃은 경우도 같다. (7) 새로 고침 뒤에 닫으면 건너뛸 항목이 다른 문서에 속할 수 있다(WebKit은 이전 문서의 항목으로 돌아갈 때 popstate를 보낸 뒤 Next.js가 그 주소를 다시 읽기도 한다): 그때는 닫은 뒤 첫 뒤로가기가 건너뛸 항목(닫힌 홈)에 한 번 머물고 다음 뒤로가기가 이전 페이지로 간다. (제안 — 사용자 확인 필요: 홈에 오기 전 기록이 없으면 닫은 뒤 뒤로가기는 브라우저 기본 동작이다.) AC14.
5. **정리 노트 (DOCSUM-SPEC 2026-10-29):** Heatmap의 각 챕터 그룹 header("챕터 없음" 제외) 오른쪽에 `정리 노트` 버튼(접근성 이름 "<장 제목> 정리 노트", 모든 구성원)이 있고 정리 노트 panel(`?panel=chapter-note&chapter=<id>`, non-modal, 4의 쌓기 규칙)을 연다. 버튼은 그룹의 marker grid 위치·크기를 바꾸지 않는다(grid shift 없음). 동작과 AC는 [CHNOTE-01](chapter-notes.md).
7. **모의고사·문제 풀기 (MOCK-SPEC 2026-11-01, 예정; MOCK-SYNC 2026-11-02에 UX7 메뉴에 맞춤):** `문제` 메뉴의 `변형 출제`는 없어지고(QGEN-RM) `모의고사`(모의고사 dialog `?panel=mock-exams`, 모든 구성원, [MOCK-01](mock-exams.md))와 `문제 풀기`(범위를 골라 하나씩 푸는 QuestionViewer, 모든 구성원, [QVIEW-01](question-viewer.md))가 더해진다. 4의 `문제 생성` dialog도 `모의고사` dialog로 바뀐다. **메뉴 자리:** 두 항목은 보기 권한도 쓰므로 `requiresEdit: false`(UX7-DOCS-2의 항목별 구분)이고 구분선 아래 `보관·초안 문제` 다음에 `모의고사` · `문제 풀기` 순서로 붙는다(MOCK-01 "진입": UX7 이후 메뉴에 더함). 보기 권한·보관된 Workspace에서도 활성이고 이유 글자는 비활성 편집 항목(`직접 추가`·`변형 출제`·`중복 문제 정리`)에만 붙는다. 보관된 Workspace에서 `모의고사`는 읽기 전용 목록, `문제 풀기`는 제출 비활성(MOCK-01·QVIEW-01-AC07). 메뉴를 고치는 순서는 QVIEW-W(`문제 풀기`) → MOCK-W(`모의고사`) → QGEN-RM(`변형 출제` 제거)이고, 끝나면 `직접 추가`·`중복 문제 정리` | `보관·초안 문제`·`모의고사`·`문제 풀기`다. QGEN-RM은 풀이 panel `문제 관리` 메뉴의 `변형 출제`도 지운다(→ `정답·해설 보기`·`수정 이력·출처` | `편집`·`보관` | `삭제`, QPLAY-01). AC09(하위 페이지 skeleton — 지금 test는 `문제 관리` › `변형 출제`로 QGEN 검토 페이지에 감)·AC10·AC11·AC13(하위 페이지 뒤로가기·breadcrumb — `/questions/generate`)의 `변형 출제` 문구와 test는 QGEN-RM이 함께 고친다(하위 페이지는 남는 QIMPORT-01 검토 페이지나 DOC-02로; 그 전까지 지금 문구 그대로 GREEN). marker의 풀이 panel은 QuestionViewer `practice` 방식이다(QPLAY-01). 새 `?practice=`·`?panel=mock-exams` URL state도 4의 뒤로가기 규칙(AC14)을 그대로 따른다(QVIEW-01 "모든 방식이 지켜야 하는 UX7 동작").
6. **즉시 반응**: 버튼으로 화면이 바뀌면 먼저 화면을 바꾸고 skeleton을 보이는 동안 데이터를 불러온다. Workspace 홈·하위 페이지 route는 `loading.tsx` skeleton, dialog는 즉시 열리고 데이터를 불러오는 동안 내용 skeleton을 보인다.

## 수용 기준

### QOV-01-AC01

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 확정 문제 100개와 draft 10개 존재 시 상태 마커는 100개이며 보기 셔플로 점 개수가 증가하지 않는다.

### QOV-01-AC02

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 마커 위 포인터 미리보기만으로 viewed 상태를 만들지 않는다.

### QOV-01-AC03

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 즐겨찾기를 지정하면 현재 상태 색상·기본 크기는 유지한 채 rounded-square를 rounded-star로 변경한다. 고정 셀 유지.

### QOV-01-AC04

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** Hover 또는 키보드 focus 시 1.18배 확대와 Popover를 보여주고 reduced-motion에서는 움직임을 제거한다.

### QOV-01-AC05

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** Retry 플래그가 마지막 정답 상태와 동시에 있으면 노란색을 우선하고 Retry 해제 시 기존 초록색으로 돌아간다.

### QOV-01-AC06

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 마커 click/Enter로 Floating Practice Panel을 열고 닫으면 원래 마커로 focus를 복구한다.

### QOV-01-AC07

- **Given:** 로그인 사용자가 접근할 수 있는 Workspace(Owner, 그리고 Owner가 아닌 멤버)
- **When:** `/workspaces/:workspaceId`를 열거나 이전 경로(`/documents`, `/search?q=…`, `/questions?…`, `/history`, `/settings/sharing`)로 접근
- **Then:** Workspace 왼쪽 메뉴 없이 Workspace header(문제 검색 입력란과 "본문 검색" 펼치기 버튼, `문서 n`·`문제` 묶음 — `문제` 버튼은 보기 권한에도 보인다(UX7-DOCS-2, AC11), 별도의 `문제은행` 버튼 없음(UX6-PROGRESS), 오른쪽 정렬된 `이력`·Owner에게만 `공유하기` 아이콘 버튼 묶음) 바로 아래에 문제 Heatmap이 보이고, 화면 제목·설명 header와 문제 수 문구는 없다. `공유하기`는 `이력`처럼 글자 없는 흰색(secondary) 아이콘 버튼이며 접근성 이름은 "공유하기"다(UX4). `문서 n`의 n은 등록된 책 문서 수(문제 PDF 제외; UX6-UPLOAD부터 `교재`·`교재+문제`, DOC-01-AC06)다. 이전 경로는 홈으로 redirect되며 해당 dialog(`?panel=documents|history|share`)나 검색 상태(문제 검색 `q`, 본문 검색 `text`, 필터; 이전 `/search?q=`는 `text=`로)를 그대로 연다. Owner가 아닌 멤버가 `?panel=share`로 와도 공유 dialog는 열리지 않고 공유 API는 거부된다(UX3c).

### QOV-01-AC08

- **Given:** 확정 문제가 있는 Workspace 홈
- **When:** 문제 영역을 보거나 상태 필터 펼치기 버튼을 누름
- **Then:** 상태 범례와 상태별 집계(문제 상태 요약)는 표시하지 않는다. 상태 필터는 기본으로 접혀 있고, 위/아래 화살표 아이콘 버튼(접근성 이름 "상태 필터", `aria-expanded`, `aria-controls`)으로 펼치고 접는다. 펼친 필터의 각 상태는 색 견본과 텍스트를 함께 보이며, 상태 필터를 고르면 지금처럼 URL과 Heatmap에 반영된다. 필터가 적용된 동안 접어도 필터는 유지되고 "상태 필터 적용 중"으로 알린다(UX3c). 375px 폭에서도 칩은 줄바꿈될 뿐 버튼 크기·문구가 줄지 않는다(UX4).

### QOV-01-AC09

- **Given:** Workspace 홈
- **When:** header나 문제 영역의 버튼으로 dialog를 열거나 하위 페이지로 이동
- **Then:** dialog는 데이터 응답을 기다리지 않고 바로 열리며, 불러오는 동안 `aria-busy` 영역에 skeleton과 "불러오는 중" 상태 문구를 보인 뒤 내용으로 바뀐다. 하위 페이지로의 이동은 route `loading.tsx` skeleton을 먼저 보인다(UX3c).

### QOV-01-AC10

- **Given:** Workspace 홈에서 floating dialog 하나가 열린 상태
- **When:** 다른 floating dialog(문서 관리·이력·링크 공유·`문제` 메뉴의 변형 출제)를 연다
- **Then:** 두 dialog가 함께 열려 있고 나중에 연 dialog가 위에 온다(더 높은 쌓임 순서). 이미 열려 있지만 가려진 dialog의 버튼을 다시 누르면 그 dialog가 다시 위로 온다. 데스크톱에서는 열린 dialog 옆으로 홈 내용(header 버튼 포함)이 비켜서 다른 dialog를 열 수 있다. 각 dialog는 닫기 버튼과 Escape(focus가 안에 있을 때)로 닫히고, 닫히면 해당 `?panel=` 값이 URL에서 빠진다(UX3c).

### QOV-01-AC11

- **Given:** Workspace 홈(편집 권한, 보기 권한, 그리고 보관된 Workspace의 Owner)
- **When:** header의 `문제` 버튼을 마우스나 키보드(Enter, 화살표)로 열고 항목을 고름
- **Then:** `문서 n` 오른쪽의 `문제` 버튼이 메뉴(`role="menu"`)를 열고, 편집 권한에는 `직접 추가`·`변형 출제`·`중복 문제 정리`(UX7-DEDUP) 세 항목과 구분선 아래 `보관·초안 문제`(UX7-BANK-2)가 활성으로 보인다. 보기 권한과 보관된 Workspace에도 `문제` 버튼이 보이고 같은 세 항목이 비활성(`aria-disabled="true"`)으로, `보관·초안 문제`는 활성으로 보이며, 메뉴 안에 이유 문구(보기 권한 "편집 권한이 있어야 사용할 수 있습니다", 보관 "보관된 Workspace는 읽기 전용입니다")가 글자로 보인다. 비활성 항목은 화살표 키 이동에서 건너뛰고, 클릭해도 dialog를 열지 않으며, Escape는 메뉴를 닫고 `문제` 버튼으로 focus를 돌린다(UX7-DOCS-2 2026-11-01, 사용자 결정 "문제 버튼: Do not hide"; UX7-DOCS 2026-11-01~UX7-DOCS-2 전에는 보기 권한에 `문제` 버튼이 없었다. UX7-DOCS에서 `PDF 관리` 항목이 문서 관리로 통합되어 없어짐, DOC-01-AC09; 그 전에는 편집 권한 세 항목, 보기 권한 `PDF 관리` 하나). `전체 문제` 항목은 없다(UX7-BANK; UX6-PROGRESS~UX6-BANK에는 전체 문제 페이지 링크였다). `변형 출제`는 문제 생성 dialog(`?panel=generate`)를 열고, `직접 추가`는 홈을 떠나지 않고 "문제 등록" dialog(`?panel=question-create`)를 연다(UX7-BANK). 홈에는 별도의 `문제 PDF 관리`·`문제 생성`(UX4)·`문제은행`(UX6-PROGRESS) 버튼이 없다.

### QOV-01-AC12

- **Given:** Workspace 홈(편집 권한; 문제가 없는 Workspace와 목차가 있는 책 문서가 있는 Workspace), 그리고 보기 권한·보관된 Workspace
- **When:** 빈 Heatmap의 `문제 등록` 또는 `문제` 메뉴 › `직접 추가`로 "문제 등록" dialog를 열고, 정답 없는 객관식을 저장한 뒤 정답과 챕터를 골라 다시 저장
- **Then:** 홈을 떠나지 않고(경로 그대로, URL에 `?panel=question-create`) modal dialog "문제 등록"이 열리고, Escape로 닫으면 `question-create`가 URL에서 빠진다. 정답 없는 객관식은 거절되어 아무것도 저장되지 않는다(role=alert). 유효하게 저장하면 dialog가 닫히고 확정(CONFIRMED) 문제 하나가 고른 챕터에 생기며(정답은 보기의 안정 ID로 기록) Heatmap의 그 챕터 그룹에 점이 하나 생긴다. 새로 고침해도 점이 남는다. 보기 권한과 보관된 Workspace에는 `직접 추가`·빈 상태의 `문제 등록`이 없고 `?panel=question-create`로 와도 dialog가 열리지 않으며, 서버는 그들의 등록을 거절한다(viewer 403 `insufficient-role`, 보관 403 `workspace-archived`). (QBANK-01-AC01·AC02에서 옮김, UX7-BANK)

### QOV-01-AC13

- **Given:** Workspace 홈과 책 문서 하나가 있는 Workspace(편집 권한)
- **When:** 버튼으로 들어가는 하위 페이지(문제 PDF 가져오기, 문제 변형 출제, PDF 열람)를 열고, 이전 전체 문제 URL `/workspaces/:id/questions/bank`(와 `?question=<id>`)로 접근
- **Then:** 각 하위 페이지 제목 위쪽에 뒤로가기 링크(Workspace 홈으로)와 breadcrumb(`Workspace 이름` 링크 › … › 현재 페이지, 현재 항목 `aria-current="page"`)이 있고 breadcrumb 줄 아래 제목까지 12px 이상 여백이 있다(UX5-UI). 뒤로가기나 breadcrumb의 Workspace 이름을 누르면 Workspace 홈으로 돌아간다. 하위 페이지에는 `전체 문제` 링크가 없다. `/questions/bank`는 Workspace 홈으로 redirect하고 `?question=<id>`가 있으면 그 문제의 풀이 panel이 열린다. (QBANK-01-AC05에서 옮김, UX7-BANK)

### QOV-01-AC14

- **Given:** 확정 문제가 있는 Workspace 홈(Owner), 그 전에 Workspace 목록을 연 기록
- **When:** 문서 관리 dialog, 이력, 링크 공유, 문제 등록 dialog, 문제 풀이 panel(다음 문제로 옮긴 뒤)을 각각 열고 닫은 뒤 뒤로가기·앞으로가기를 누르고; dialog를 연 채 필터를 바꾸고 뒤로가기로 닫은 뒤 앞으로가기를 누르고, 다시 연 채 필터를 바꾸고 닫기 버튼으로 닫은 뒤 뒤로가기·앞으로가기를 누르고; 두 dialog(문서 관리 위에 이력)를 쌓아 연 채 뒤로가기를 두 번 누른 뒤 앞으로가기를 누르고; 다시 쌓아 연 채 아래 dialog를 닫은 뒤 뒤로가기를 두 번 누르고; 풀이 panel에서 다음 문제로 옮긴 뒤 뒤로가기·앞으로가기·뒤로가기·뒤로가기·앞으로가기를 누르고; `?panel=history`·`?panel=documents&panel=history`·`?question=` 딥링크로 들어와 뒤로가기를 누르고, `?panel=history` 딥링크의 dialog를 닫기 버튼으로 닫은 뒤 뒤로가기·앞으로가기를 누르고, `?panel=history` 딥링크를 새로 고침한 뒤 뒤로가기를 누름
- **Then:** 닫은 dialog·panel은 뒤로가기로도 앞으로가기로도 다시 열리지 않는다(URL에 그 `panel`·`question`이 없고 dialog가 보이지 않는다). 버튼·Escape로 닫은 뒤 첫 뒤로가기는 홈에 오기 전 페이지(Workspace 목록)로 가고, 그 뒤 앞으로가기는 dialog가 닫힌 홈으로 돌아오며 그다음 앞으로가기도 dialog를 열지 않는다. dialog가 열려 있는 동안 뒤로가기 한 번은 맨 위 dialog 하나만 닫는다: 쌓인 두 dialog는 뒤로가기 두 번으로 이력, 문서 관리 순서로 하나씩 닫히고 그 뒤 앞으로가기는 어느 것도 다시 열지 않는다. 아래 dialog(문서 관리)를 버튼으로 닫으면 첫 뒤로가기는 남은 이력만 닫고(문서 관리는 다시 열리지 않음) 다음 뒤로가기가 이전 페이지로 간다. 열려 있는 동안 바꾼 필터는 뒤로가기로 닫든 닫기 버튼으로 닫든 남는다(UX7 확인 7). 풀이 panel의 다음 문제는 dialog 닫기가 아니다: 뒤로가기는 panel을 연 채 앞 문제로, 앞으로가기는 다시 뒤 문제로 가고(QPLAY-01), panel을 닫는 뒤로가기 뒤의 앞으로가기는 panel을 열지 않는다. 딥링크로 열린 dialog도 뒤로가기 한 번에 하나씩(맨 위부터) 닫히고 그다음 뒤로가기가 이전 페이지로 간다(새로 고침한 뒤에도); 닫기 버튼으로 닫아도 홈에 머물고(URL에서 `panel`만 빠진다) 그 뒤 뒤로가기는 이전 페이지로, 앞으로가기는 닫힌 홈으로 간다. (UX7-BACK, UX7-BACK-2)

### QOV-01-AC15

- **Given:** 확정 문제 둘, 초안(DRAFT) 문제 하나, 보관(ARCHIVED) 문제 51개가 있는 Workspace 홈: Owner, 보기 권한 멤버, 보관된 Workspace의 Owner
- **When:** `문제` › `보관·초안 문제`로 dialog를 열고 `상태`를 `초안`·`보관됨`·`전체`로 바꾸고 `더 보기`를 누르고, 행의 문제 내용으로 상세를 열고, Owner가 보관된 문제 하나를 `보관 해제`하고 초안을 `확정`한 뒤 dialog를 닫고 뒤로가기를 누름
- **Then:** 홈을 떠나지 않고 non-modal dialog "보관·초안 문제"가 열리고 URL에 `?panel=inactive-questions`가 있다. 기본 `전체`는 초안과 보관 문제만(확정 문제 없이) 50개를 보이고 `더 보기`로 나머지 2개를 더 보인다(중복 없이). `초안`은 초안 하나만, `보관됨`은 보관 문제만 보이며 각 행은 상태를 글자 badge로 보인다. 상세 dialog "문제 상세"는 그 문제의 정답·해설과 수정 이력을 보인다. `보관 해제`한 문제와 `확정`한 초안은 목록에서 빠지고 Heatmap에 점으로 나타난다(새로 고침해도; 확정 문제 4개). dialog를 닫은 뒤 뒤로가기는 dialog를 다시 열지 않는다(AC14). 보기 권한과 보관된 Workspace에서도 dialog·필터·상세가 같게 보이지만 `보관 해제`·`확정`·`편집`·`삭제` 버튼이 없고, 보관된 Workspace에는 읽기 전용 문구가 보이며, 서버는 그들의 상태 변경을 거절한다(viewer 403 `insufficient-role`, 보관 403 `workspace-archived`). (UX7-BANK-2; QBANK-01의 상태 필터·`보관 해제`·`확정`·더 보기)

### QOV-01-AC16

- **Given:** 확정 문제 다섯 개 — 그중 셋은 같은 문제(둘째는 보기 순서가 다르고 `①②③④` 번호가 붙음, 셋째는 띄어쓰기·문장부호가 다르고 끝에 `( )`), 나머지 둘은 서로 다른 문제, 셋째 문제만 한 번 풀었음 — 가 있는 Workspace 홈: Owner, 보기 권한 멤버, 보관된 Workspace의 Owner
- **When:** Owner가 `문제` › `중복 문제 정리`로 dialog를 열고, 묶음의 `남길 문제`를 둘째 문제로 바꾼 뒤 `선택한 묶음 정리`와 확인 dialog의 `보관`을 누르고, dialog를 닫고 `보관·초안 문제`를 연다
- **Then:** 홈을 떠나지 않고 non-modal dialog "중복 문제 정리"가 열리고 URL에 `?panel=question-duplicates`가 있다. 묶음은 하나(문제 3개, 정답 표시 없음)이고 기본 `남길 문제`는 채점된 풀이가 가장 많은 셋째 문제다(풀이 수는 보이지 않는다). 정리하면 남긴 둘째 문제를 뺀 둘이 보관되어 Heatmap의 점이 5개에서 3개가 되고, 다시 검사한 dialog는 "중복 문제가 없습니다"를 보이며, 보관된 둘은 `보관·초안 문제`의 `보관됨`에 있다(새로 고침해도). 다시 검사해도 묶음은 없다. 보기 권한과 보관된 Workspace에서는 `중복 문제 정리` 항목이 이유와 함께 비활성(AC11)이고 `?panel=question-duplicates`로 와도 dialog가 열리지 않으며, 서버는 검사와 정리를 거절한다(viewer 403 `insufficient-role`, 보관 403 `workspace-archived`). (UX7-DEDUP)

### QOV-01-AC17

- **Given:** 같은 문제 A(먼저 등록)와 B가 있는 Workspace 홈(Owner): A는 정답으로 풀었고, B는 나중에 오답으로 풀고 즐겨찾기했다
- **When:** `중복 문제 정리`에서 A를 남기고 B를 보관한 뒤 Heatmap의 A를 보고, A의 풀이 panel에서 즐겨찾기를 끈 다음, `보관·초안 문제`에서 B를 `보관 해제`한다
- **Then:** 정리 뒤 Heatmap에는 A의 점 하나가 B의 기록까지 합친 상태로 보인다: 마지막 채점이 B의 오답이므로 오답(빨강, 접근성 이름·미리보기 글자 "오답"), B의 즐겨찾기로 star 모양. A에서 즐겨찾기를 끄면 star가 사라지고 새로 고침해도 꺼져 있다. 풀이 기록(attempt)은 하나도 바뀌거나 지워지지 않는다. B를 보관 해제하면 합침이 풀려 A는 자기 기록(정답, 초록)으로, B는 자기 기록(오답, 즐겨찾기는 끈 채)으로 각자 점이 된다. (UX7-DEDUP)

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.

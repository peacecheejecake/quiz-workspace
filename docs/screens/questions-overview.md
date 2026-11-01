# QOV-01 — Questions Heatmap 홈

**상태:** 확정 화면 요구사항 v1.3 · UX3c 개정 2026-10-20 (Workspace 홈 통합) · UX4 개정 2026-10-21 (header 버튼 묶음·`문제` 메뉴) · UX6-PROGRESS 개정 2026-10-28 (`문제은행` 버튼 → `문제` 메뉴의 `전체 문제`) · UX6-BANK 개정 2026-10-28 (문제은행 페이지 이름도 `전체 문제`) · UX7-BANK 개정 2026-11-01 (전체 문제 페이지 폐기: 직접 추가는 홈 위 dialog, 편집·삭제는 풀이 panel) · UX7-DOCS 개정 2026-11-01 (`PDF 관리` 항목 폐기, 문서 관리로 통합) · UX7-SEARCH 개정 2026-11-01 (문제·본문 검색창 분리) · UX7-BACK 개정 2026-11-01 (닫은 dialog를 뒤로가기로 다시 열지 않음) · UX7-DOCS-2 개정 2026-11-01 (`문제` 버튼은 편집 권한이 없어도 보이고 항목은 이유와 함께 비활성)
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
   - `문제` 메뉴(Radix DropdownMenu, `aria-haspopup="menu"`, 화살표·Enter·Escape 키보드 조작): `직접 추가`(홈 위에 "문제 등록" dialog를 연다: `?panel=question-create`, AC12) · `변형 출제`(문제 생성 dialog `?panel=generate`, QGEN-01-AC05). `문제` 버튼은 편집 권한이 없어도(보기 권한, 보관된 Workspace) 숨기지 않는다(UX7-DOCS-2 2026-11-01, 사용자 결정 "문제 버튼: Do not hide"; UX7-DOCS의 숨김 제안 기각). `직접 추가`·`변형 출제`는 편집 권한에만 쓸 수 있으므로 그 밖에는 비활성 항목(`aria-disabled="true"`, 화살표 키는 건너뜀, 골라도 아무 일 없음)으로 보이고, 그 아래 글자로 이유를 보인다: 보기 권한 "편집 권한이 있어야 사용할 수 있습니다", 보관된 Workspace "보관된 Workspace는 읽기 전용입니다"(보관이 우선). 이유는 색이나 흐림만이 아니라 글자로 보이며(touch에는 tooltip이 없으므로 tooltip에만 두지 않는다), 비활성 항목과 메뉴의 `aria-describedby`로 연결된다. 보기 권한자도 쓸 수 있는 항목(이후 `모의고사`·`문제 풀기`)이 생기면 같은 메뉴에 활성 항목으로 함께 둔다. `PDF 관리`(문제 PDF 관리 dialog `?panel=question-pdfs`) 항목은 없다(UX7-DOCS 2026-11-01, 사용자 "문제 Pdf 관리를 문서 관리로 통합": 문제 PDF는 `문서 n`의 문서 관리 dialog에서 다룬다, DOC-01-AC09; 이전 URL은 `?panel=documents`로 redirect). `전체 문제` 항목과 전체 문제 페이지(QBANK-01)는 없다(UX7-BANK 2026-11-01, 사용자 결정 "'전체 문제' 페이지 삭제. 문제 편집/삭제만 홈으로 옮기면 될듯. 나머지는 이미 홈에 있음" — 폐기 기록 [questions-bank.md](questions-bank.md)). 이전 URL `/questions/bank`는 홈으로 redirect한다(`?question=`만 유지).
   - **문제 등록 dialog (UX7-BANK):** `직접 추가`와 빈 Heatmap의 `문제 등록`은 같은 "문제 등록" dialog(기존 문제 편집기: 유형·문제 내용·보기·정답·챕터·문제 번호·출처)를 홈 위에 연다. 입력 중 다른 곳을 실수로 누르지 않도록 modal dialog이고 URL에 `?panel=question-create`를 남긴다(다른 dialog와 달리 쌓기·옆으로 비키기 대상이 아니다). 챕터·출처 문서 목록은 dialog가 열린 뒤 불러온다. 저장하면 확정 문제로 등록되고 dialog가 닫히며 Heatmap이 새로 읽혀 그 챕터에 점이 생긴다. 닫으면(취소·Escape·저장) `question-create`가 URL에서 빠진다. 보기 권한·보관된 Workspace에서는 열리지 않는다(`?panel=question-create`도 무시).
   - 버튼 문구는 줄바꿈하지 않는다. 좁은 화면(375px)에서는 묶음과 버튼이 버튼 단위로 다음 줄로 넘어가고 페이지 가로 스크롤은 없다.
2. **본문 검색**(기본 접힘, UX7-SEARCH): 펼치면 header 아래, Heatmap 위에 본문 검색 입력란·검색 버튼·"본문 설정"이 나타나고, 검색하면 그 아래 "본문 검색 결과" 영역이 나타나며 "검색 결과 닫기"로 지운다. 결과 항목을 누르면 오른쪽 "본문 발췌" panel에 검색어 주변 내용을 보인다(SEARCH-01-AC11).
3. **문제 영역**(기존 QOV-01 내용): 도구 줄에 상태 필터 펼치기 버튼(기본 접힘, 위/아래 화살표 아이콘, `aria-expanded`·`aria-controls`)만 둔다. 문제 수 문구("현재 필터의 문제 n개")와 `문제 PDF 관리`·`문제 생성` 버튼은 없다(UX4; header의 `문제` 메뉴로 옮김). 접힌 상태에서 상태 필터가 적용 중이면 "상태 필터 적용 중" 문구를 보인다. 펼치면 상태 필터(색 견본 + 상태 텍스트, 즐겨찾기만·다시 풀기만, 필터 초기화); 칩은 크기를 유지한 채 칩 단위로 줄바꿈하며 좁은 화면에서도 찌그러지거나 가로 스크롤되지 않는다. 그 아래 Heatmap. 상태 범례와 상태별 집계(문제 상태 요약)는 두지 않는다 — 상태는 marker의 접근성 이름·preview popover·상태 필터의 텍스트로 전달하고 색만으로 전달하지 않는다. 문제가 없을 때 빈 상태의 버튼은 `문제 등록`(홈 위의 문제 등록 dialog, UX7-BANK) 하나이며 홈의 다른 "PDF 가져오기" 버튼은 없다.
4. **Floating dialog**: 문서 관리(DOC-01; 문제 PDF 관리는 UX7-DOCS에서 여기로 통합), 문제 생성(QGEN-01), 이력(HISTORY-01), 링크 공유(WS-SHARE-01)는 모두 공통 `FloatingSidePanel`(non-modal)로 홈 위에 뜨고 URL `?panel=`에 반영된다(딥링크·이전 경로 redirect). 여러 개를 열 수 있고 나중에 연 dialog가 위에 온다. 문제 풀이 panel(QPLAY-01, `?question=`)도 같은 규칙.
   - **뒤로가기 (UX7-BACK 2026-11-01, 사용자: "floating 영역(예: 문서 관리)를 열기 -> 닫기 -> 뒤로(back button) 했을 때 floating dialog가 열리지 않게"):** dialog·panel(문서 관리·문제 생성·이력·링크 공유·정리 노트·문서 요약·문제 등록 dialog `?panel=question-create`·문제 풀이 panel `?question=`)을 열면 기록 항목이 하나 생기고(풀이 panel의 이전/다음, 다른 문서의 요약, 다른 장의 정리 노트도 하나씩), 열려 있는 동안 뒤로가기는 그 열기를 되돌린다(dialog가 닫힌다; 풀이 panel의 이전/다음은 앞 문제로 돌아간다 — QPLAY-01-AC05). 닫기 버튼·Escape·저장·삭제로 닫으면 그 dialog를 연 기록 항목들은 사라진다: 홈은 처음 dialog를 열기 전의 기록 항목으로 돌아가 지금 URL 상태(필터·검색어 등)를 그 항목에 쓰고, 아직 열려 있는 다른 dialog가 있으면 그것들을 연 기록 항목 하나를 다시 만든다. 그래서 닫은 뒤의 뒤로가기는 닫은 dialog를 다시 열지 않고, 남은 dialog가 있으면 그것을 닫고, 없으면 홈에 오기 전 페이지로 간다. 딥링크·새로 고침으로 dialog가 열린 채 들어온 경우처럼 되돌릴 기록 항목이 없으면 닫기는 지금 항목만 고쳐 쓴다(사이트를 떠나지 않음). (제안 — 사용자 확인 필요: 닫은 뒤 앞으로가기는 일반 브라우저처럼 닫기 전 기록을 다시 연다; 남은 dialog가 있을 때 앞으로 기록은 없어진다; 홈에 오기 전 기록이 없으면 닫은 뒤 뒤로가기는 브라우저 기본 동작이다.) AC14.
5. **정리 노트 (DOCSUM-SPEC 2026-10-29):** Heatmap의 각 챕터 그룹 header("챕터 없음" 제외) 오른쪽에 `정리 노트` 버튼(접근성 이름 "<장 제목> 정리 노트", 모든 구성원)이 있고 정리 노트 panel(`?panel=chapter-note&chapter=<id>`, non-modal, 4의 쌓기 규칙)을 연다. 버튼은 그룹의 marker grid 위치·크기를 바꾸지 않는다(grid shift 없음). 동작과 AC는 [CHNOTE-01](chapter-notes.md).
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
- **Then:** `문서 n` 오른쪽의 `문제` 버튼이 메뉴(`role="menu"`)를 열고, 편집 권한에는 `직접 추가`·`변형 출제` 두 항목이 활성으로 보인다. 보기 권한과 보관된 Workspace에도 `문제` 버튼이 보이고 같은 두 항목이 비활성(`aria-disabled="true"`)으로 보이며, 메뉴 안에 이유 문구(보기 권한 "편집 권한이 있어야 사용할 수 있습니다", 보관 "보관된 Workspace는 읽기 전용입니다")가 글자로 보인다. 비활성 항목은 화살표 키 이동에서 건너뛰고, 클릭해도 dialog를 열지 않으며, Escape는 메뉴를 닫고 `문제` 버튼으로 focus를 돌린다(UX7-DOCS-2 2026-11-01, 사용자 결정 "문제 버튼: Do not hide"; UX7-DOCS 2026-11-01~UX7-DOCS-2 전에는 보기 권한에 `문제` 버튼이 없었다. UX7-DOCS에서 `PDF 관리` 항목이 문서 관리로 통합되어 없어짐, DOC-01-AC09; 그 전에는 편집 권한 세 항목, 보기 권한 `PDF 관리` 하나). `전체 문제` 항목은 없다(UX7-BANK; UX6-PROGRESS~UX6-BANK에는 전체 문제 페이지 링크였다). `변형 출제`는 문제 생성 dialog(`?panel=generate`)를 열고, `직접 추가`는 홈을 떠나지 않고 "문제 등록" dialog(`?panel=question-create`)를 연다(UX7-BANK). 홈에는 별도의 `문제 PDF 관리`·`문제 생성`(UX4)·`문제은행`(UX6-PROGRESS) 버튼이 없다.

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
- **When:** 문서 관리 dialog, 이력, 링크 공유, 문제 등록 dialog, 문제 풀이 panel(다음 문제로 옮긴 뒤)을 각각 열고 닫은 뒤 뒤로가기를 누르고, 두 dialog(문서 관리 위에 이력)를 쌓아 연 채 아래 dialog를 닫은 뒤 뒤로가기를 두 번 누르고, `?panel=history` 딥링크로 열린 dialog를 닫음
- **Then:** 닫은 dialog·panel은 뒤로가기로 다시 열리지 않는다(URL에 그 `panel`·`question`이 없고 dialog가 보이지 않는다). 닫은 뒤 첫 뒤로가기는 홈에 오기 전 페이지(Workspace 목록)로 간다. 쌓인 경우 첫 뒤로가기는 남은 이력 dialog만 닫고(문서 관리는 다시 열리지 않음), 다음 뒤로가기가 이전 페이지로 간다. dialog가 열려 있는 동안의 뒤로가기는 그 dialog를 닫는다. 딥링크로 열린 dialog를 닫아도 홈에 머문다(URL에서 `panel`만 빠진다). (UX7-BACK)

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.

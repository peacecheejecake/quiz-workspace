# QOV-01 — Questions Heatmap 홈

**상태:** 확정 화면 요구사항 v1.3 · UX3c 개정 2026-10-20 (Workspace 홈 통합)
**Route:** `/workspaces/:workspaceId` (이전 `/workspaces/:workspaceId/questions`는 같은 query로 redirect)
**테스트:** `tests/e2e/questions/questions-overview.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- 상태 토큰: unseen=lightgray, viewed=gray, incorrect=red, correct=green, retry=yellow(최상위 우선순위).
- 일반 마커 rounded square, 즐겨찾기 rounded star(크기 동일). Hover/focus scale=1.18, 고정 Grid 셀, 키보드/스크린리더 대응.
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.

## Workspace 홈 레이아웃 (UX3c 2026-10-20)

이 화면이 Workspace의 유일한 홈이다. Workspace 왼쪽 메뉴(문서/검색/문제/이력/공유 설정)는 없다.

1. **Workspace header**(홈 최상단, 화면 제목·설명 없음; 접근성 `h1`은 Workspace 이름을 시각적으로 숨겨 둔다)
   - 왼쪽: 통합 검색창(SEARCH-01-AC07). 입력란 + 검색 아이콘 버튼(접근성 이름 "검색"), 아래 작은 글씨 "검색 옵션" 버튼.
   - 오른쪽 버튼 순서: `문서 n`(등록된 책 문서 수, 문서 관리 dialog) · `문제은행`(QBANK-01 페이지 링크) · `이력`(아이콘 버튼, 이력 dialog) · `공유하기`(Owner만, 링크 공유 dialog).
2. **통합 검색 결과**: 검색 대상에 "내용"이 포함된 검색을 실행하면 header 아래에 원문 검색 결과 영역이 나타나며 "검색 결과 닫기"로 지운다.
3. **문제 영역**(기존 QOV-01 내용): 도구 줄에 상태 필터 펼치기 버튼(기본 접힘, 위/아래 화살표 아이콘, `aria-expanded`·`aria-controls`)과 현재 필터의 문제 수, 오른쪽에 `문제 PDF 관리`(문제 PDF 관리 dialog, QIMPORT-01-AC05)·`문제 생성`(문제 생성 dialog, QGEN-01-AC05; 편집 권한). 펼치면 상태 필터(색 견본 + 상태 텍스트, 즐겨찾기만·다시 풀기만, 필터 초기화). 그 아래 Heatmap. 상태 범례와 상태별 집계(문제 상태 요약)는 두지 않는다 — 상태는 marker의 접근성 이름·preview popover·상태 필터의 텍스트로 전달하고 색만으로 전달하지 않는다. 문제가 없을 때 빈 상태의 버튼은 `문제 등록`(문제은행) 하나이며 홈의 다른 "PDF 가져오기" 버튼은 없다.
4. **Floating dialog**: 문서 관리(DOC-01), 문제 PDF 관리(QIMPORT-01), 문제 생성(QGEN-01), 이력(HISTORY-01), 링크 공유(WS-SHARE-01)는 모두 공통 `FloatingSidePanel`(non-modal)로 홈 위에 뜨고 URL `?panel=`에 반영된다(딥링크·이전 경로 redirect). 여러 개를 열 수 있고 나중에 연 dialog가 위에 온다. 문제 풀이 panel(QPLAY-01, `?question=`)도 같은 규칙.
5. **즉시 반응**: 버튼으로 화면이 바뀌면 먼저 화면을 바꾸고 skeleton을 보이는 동안 데이터를 불러온다. Workspace 홈·하위 페이지 route는 `loading.tsx` skeleton, dialog는 즉시 열리고 데이터를 불러오는 동안 내용 skeleton을 보인다.

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
- **Then:** Workspace 왼쪽 메뉴 없이 Workspace header(통합 검색창, `문서 n`, `문제은행`, `이력`, Owner에게만 `공유하기`) 바로 아래에 문제 Heatmap이 보이고, 화면 제목·설명 header는 없다. `문서 n`의 n은 등록된 책 문서 수(문제 PDF 제외)다. 이전 경로는 홈으로 redirect되며 해당 dialog(`?panel=documents|history|share`)나 검색 상태(`q`, `scope`, 필터)를 그대로 연다. Owner가 아닌 멤버가 `?panel=share`로 와도 공유 dialog는 열리지 않고 공유 API는 거부된다(UX3c).

### QOV-01-AC08

- **Given:** 확정 문제가 있는 Workspace 홈
- **When:** 문제 영역을 보거나 상태 필터 펼치기 버튼을 누름
- **Then:** 상태 범례와 상태별 집계(문제 상태 요약)는 표시하지 않는다. 상태 필터는 기본으로 접혀 있고, 위/아래 화살표 아이콘 버튼(접근성 이름 "상태 필터", `aria-expanded`, `aria-controls`)으로 펼치고 접는다. 펼친 필터의 각 상태는 색 견본과 텍스트를 함께 보이며, 상태 필터를 고르면 지금처럼 URL과 Heatmap에 반영된다. 필터가 적용된 동안 접어도 필터는 유지된다(UX3c).

### QOV-01-AC09

- **Given:** Workspace 홈
- **When:** header나 문제 영역의 버튼으로 dialog를 열거나 하위 페이지로 이동
- **Then:** dialog는 데이터 응답을 기다리지 않고 바로 열리며, 불러오는 동안 `aria-busy` 영역에 skeleton과 "불러오는 중" 상태 문구를 보인 뒤 내용으로 바뀐다. 하위 페이지로의 이동은 route `loading.tsx` skeleton을 먼저 보인다(UX3c).

### QOV-01-AC10

- **Given:** Workspace 홈에서 floating dialog 하나가 열린 상태
- **When:** 다른 floating dialog(문서 관리·이력·링크 공유·문제 PDF 관리·문제 생성)를 연다
- **Then:** 두 dialog가 함께 열려 있고 나중에 연 dialog가 위에 온다(더 높은 쌓임 순서). 이미 열려 있지만 가려진 dialog의 버튼을 다시 누르면 그 dialog가 다시 위로 온다. 데스크톱에서는 열린 dialog 옆으로 홈 내용(header 버튼 포함)이 비켜서 다른 dialog를 열 수 있다. 각 dialog는 닫기 버튼과 Escape(focus가 안에 있을 때)로 닫히고, 닫히면 해당 `?panel=` 값이 URL에서 빠진다(UX3c).

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.

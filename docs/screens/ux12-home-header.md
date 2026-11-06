# UX12-HEADER — 홈 상단 줄과 `문서 N` 메뉴

**상태:** 구현 중 · [UX12 계획](../implementation/ux12/index.md) · [QOV-01](questions-overview.md)
**Route:** `/workspaces/:workspaceId`
**테스트:** `tests/e2e/quality/ux12-home-header.spec.ts`
**Phase:** UX12-HEADER.0

사용자 피드백(2026-11-06): 문서 검색과 문서 관리를 dropdown 안으로 옮기고, dropdown 버튼에 `문서 N` 문구를 넣어 풀기 왼쪽에 두며, 이 줄을 문제 검색 위로 올려 상단에 고정한다. 결정 D-7: 메뉴는 `문서 N ▾` 하나로 통합하고 항목 이름은 `본문 검색`이다.

**상단 줄:** `[문서 N ▾][풀기]   [AI 질문][이력][공유하기]`. `AI 질문`은 쓸 수 있을 때만, `공유하기`는 Owner에게만 보인다. 문제 검색은 이 줄 아래로 내려간다.

**`문서 N` 메뉴(세 묶음):** `문서 관리`·`본문 검색` | `직접 추가`·`중복 문제 정리`·`챕터 재분배` | `보관·초안 문제`. N은 본문이 있는 PDF 수다(DOC-01). 메뉴의 접근성 이름은 trigger 이름 `문서 N`이다.

## 수용 기준

### UX12-HEADER-AC01

상단 줄은 왼쪽부터 `문서 N`(메뉴 버튼, 글자와 chevron), primary `풀기`, 오른쪽 정렬된 `이력`·`공유하기` 순서로 한 줄에 있고, 문제 검색은 그 아래에 있다. 홈 본문에 `문제 메뉴` 버튼과 `본문 검색` 링크는 없다. 메뉴 항목은 위 순서이고 묶음 사이에 구분선이 둘이다.

### UX12-HEADER-AC02

`문서 관리`와 `본문 검색`은 보기 권한과 보관된 Workspace에서도 활성이다. `문서 관리`는 문서 관리 dialog(`?panel=documents`)를 열고, 닫으면 focus가 `문서 N` 버튼으로 돌아온다. `본문 검색`은 `/workspaces/:workspaceId/search` 링크다. click과 Enter로 이동하고, 뒤로가기는 들어오기 전 홈 주소로 돌아오며, 수정키 click은 새 탭으로 열고 홈은 그대로 둔다.

### UX12-HEADER-AC03

page를 내려도 상단 줄은 app header 바로 아래(`top: var(--app-header-height)`)에 고정되고 문제 검색은 함께 올라간다. 상단 줄의 배경은 불투명하고, Heatmap marker는 그 뒤로 지나가며, 상단 줄은 app header 아래 층이다.

### UX12-HEADER-AC04

Heatmap dot이 상단 줄 뒤에 있을 때 화살표 키로 dot에 focus가 옮겨 가면, 그 dot은 상단 줄 아래로 scroll되어 가려지지 않는다.

### UX12-HEADER-AC05

375px 폭에서 상단 줄의 모든 버튼은 한 줄에 있고 page에 가로 scroll이 없다.

### UX12-HEADER-AC06

page를 내린 상태에서 `문서 N` 메뉴로 dialog를 열고 닫아도 scroll 위치와 상단 줄 위치가 바뀌지 않는다(HOMEDLG-01-AC03).

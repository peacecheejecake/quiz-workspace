# UX10-HOME — 홈 진입점과 필터

linked_tests: `tests/e2e/questions/ux10-home.spec.ts`

### UX10-HOME-AC01

`문서 N` 메뉴 버튼 뒤의 primary `모의고사` 버튼으로 모의고사 목록에 진입하고([UX12-MOCKNAV](ux12-mock-nav.md)), 그 메뉴에 중복 풀이 및 AI 질문 항목이 없다. (UX12 HOME-4: 아이콘 전용 `문제 메뉴`는 `문서 N` 메뉴로 합쳐졌다, [UX12-HEADER](ux12-home-header.md).)

> **UX10-HOME-AC02 폐기 (UX12 HOME-5 2026-11-06):** 챕터·유형은 검색 아래 펼침 영역이 아니라 필터 popover에 있다([UX12-FILTER](ux12-home-filter.md)). 상태 필터가 항상 보인다는 내용은 UX12-FILTER-AC01이 잇는다.

### UX10-HOME-AC03

상태는 기본 전체 선택이며 전체 해제는 결과 0건이다. 생략, none, 부분 선택이 URL과 API에서 일치한다.

### UX10-HOME-AC04

상태 변경은 즉시 표시하고 마지막 선택을 350ms 후 반영한다. 검색 및 이동과 겹쳐도 오래된 결과가 반영되지 않는다.

### UX10-HOME-AC05

장별 개수에 시각적인 문제 단위를 표시하지 않고 모바일에서 넘치지 않는다.

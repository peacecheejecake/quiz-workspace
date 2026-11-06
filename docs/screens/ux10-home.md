# UX10-HOME — 홈 진입점과 필터

linked_tests: `tests/e2e/questions/ux10-home.spec.ts`

### UX10-HOME-AC01

`문서 N` 메뉴 버튼 뒤의 primary 풀기 버튼으로 통합 풀이에 진입하고, 그 메뉴에 중복 풀이 및 AI 질문 항목이 없다. (UX12 HOME-4: 아이콘 전용 `문제 메뉴`는 `문서 N` 메뉴로 합쳐졌다, [UX12-HEADER](ux12-home-header.md).)

### UX10-HOME-AC02

검색 아래 챕터와 유형은 기본 펼침이며 접어도 선택이 유지된다. 상태 필터는 항상 보인다.

### UX10-HOME-AC03

상태는 기본 전체 선택이며 전체 해제는 결과 0건이다. 생략, none, 부분 선택이 URL과 API에서 일치한다.

### UX10-HOME-AC04

상태 변경은 즉시 표시하고 마지막 선택을 350ms 후 반영한다. 검색 및 이동과 겹쳐도 오래된 결과가 반영되지 않는다.

### UX10-HOME-AC05

장별 개수에 시각적인 문제 단위를 표시하지 않고 모바일에서 넘치지 않는다.

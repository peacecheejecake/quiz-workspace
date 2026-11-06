# UX12-HILITE — 하이라이트 메뉴 선택 유지와 재클릭 닫기

**E2E:** `tests/e2e/questions/ux12-highlight.spec.ts`

**Phase:** `UX12-HILITE.0`

공통 하이라이트 도구의 동작은 [HILITE-01](highlights.md)이 정한다. 이 문서는 UX12-HILITE-1에서 더한 AC만 둔다.

### UX12-HILITE-AC01
글자를 골라 메뉴가 뜨면, focus가 메뉴에 있고 항목 사이를 옮겨 가도(마우스·키보드) 선택 범위가 그대로 남는다.

### UX12-HILITE-AC02
저장된 하이라이트를 눌러 메뉴를 연 뒤 같은 하이라이트를 다시 누르면 메뉴만 닫히고, 그다음 누르면 다시 열린다. 다른 하이라이트를 누르면 그 하이라이트의 메뉴로 바뀐다. 마우스와 터치가 같다.

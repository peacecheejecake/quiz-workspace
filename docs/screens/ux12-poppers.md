# UX12-POPPERS — tooltip 안전 여백과 trigger 재누름 닫기

**E2E:** `tests/e2e/quality/ux12-poppers.spec.ts`

**Phase:** `UX12-DESIGN.0`

**상태:** UX12 DESIGN-2 신규 2026-11-06 (사용자 피드백 "tooltip(전 화면 공통): 안전 margin 필요", "dropdown 버튼 다시 누르면 닫기"). **연계:** [디자인 시스템](../design-system.md) §4, [UX12 계획](../implementation/ux12/index.md) §4.1.

## 규칙

- trigger 기준으로 뜨는 tooltip·미리보기는 화면 가장자리와 16px(`POPPER_COLLISION_PADDING`) 이상 떨어진다. trigger가 화면 끝에 붙어 있어도 같다.
- 열린 popper의 trigger를 다시 누르면 닫힌다. 닫힌 뒤 다시 열리지 않고, 한 번 더 누르면 다시 열린다. 마우스·터치 모두 같다.

## 수용 기준

### UX12-POPPERS-AC01
**Tooltip 가장자리 여백:** trigger가 화면 왼쪽 또는 오른쪽 끝에 붙어 있어도 `Tooltip` 표면과 화면 가장자리 사이가 16px 이상이다.

### UX12-POPPERS-AC02
**Tooltip 좁은 화면:** 긴 문구의 `Tooltip`은 폭이 `min(280px, 100vw - 32px)`을 넘지 않고, 폭이 좁은 화면에서도 양쪽 여백 16px을 지킨다.

### UX12-POPPERS-AC03
**문제 미리보기 여백:** Heatmap 문제 미리보기(`QuestionPreviewPopover`)도 marker가 화면 끝에 붙어 있을 때 화면 가장자리와 16px 이상 떨어진다.

### UX12-POPPERS-AC04
**Dropdown 메뉴 마우스:** `modal={false}` Dropdown 메뉴(홈 `문서 N` 메뉴, Workspace 목록 더보기)의 trigger를 마우스로 다시 누르면 메뉴가 닫히고 다시 열리지 않으며, 세 번째 누름에 다시 열린다.

### UX12-POPPERS-AC05
**Dropdown 메뉴 터치:** 같은 메뉴를 터치로 다시 탭해도 AC04와 같다.

### UX12-POPPERS-AC06
**Popover:** `UserMenu`와 본문 검색 설정 Popover의 trigger를 마우스·터치로 다시 누르면 닫히고 다시 열리지 않으며, 세 번째 누름에 다시 열린다.

### UX12-POPPERS-AC07
**Select:** `Select`의 trigger를 마우스·터치로 다시 누르면 목록이 닫히고 값은 바뀌지 않으며, 세 번째 누름에 다시 열린다.

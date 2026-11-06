# UX12-CONTROLS — 버튼 경계, hover 배경, 버튼 묶음 간격

**E2E:** `tests/e2e/quality/ux12-controls.spec.ts`

**Phase:** `UX12-CONTROLS.0`

**상태:** UX12 DESIGN-1 신규 2026-11-06 (사용자 피드백 "버튼 테두리 삭제", "hover: 버튼 배경색 변경", "나란히 있는 버튼 사이 간격 compact하게"). UX10-UI의 "모든 버튼은 경계를 보인다"(UX10-UI-AC01)를 이 문서의 규칙으로 바꾼다. **연계:** [디자인 시스템](../design-system.md) §4·§4.1, [UX12 계획](../implementation/ux12/index.md) §4.1(D-1).

## 규칙

- **경계 없는 버튼은 두 종류뿐이다.** 아이콘 전용 버튼(`IconButton` 모든 variant, toggle 제외, [UX12-GLASSBTN](ux12-glass-buttons.md))과 `borderless` prop을 준 ghost 텍스트 버튼이다. 기능 CSS의 버튼은 제목·접기/펼치기·아이콘 전용 손잡이만 경계를 없앤다.
- **`borderless`는** 뒤로가기, 프로필·Workspace 전환 등 header trigger, 접기/펼치기, `더 보기`, 목록 항목 제목 버튼에만 쓴다. 그 밖의 ghost 텍스트 버튼(AI 질문의 `복사`, `도움이 안 됨` 등)은 경계를 유지한다.
- **나머지 컨트롤은 경계를 유지한다.** primary, secondary, toggle(`aria-pressed`, `data-state="on|off"`), tab, 입력 등 form 컨트롤이다.
- **크기는 바뀌지 않는다.** 경계를 없앤 버튼도 1px 투명 테두리를 유지한다(`button.qz-back-link`는 링크와 같은 테두리 없음).
- **hover 배경이 경계를 대신한다.** 경계 없는 버튼과 제목 버튼·링크는 `@media (hover: hover)`에서 `--color-state-hover` 배경을 얻는다.
- **forced-colors에서는 경계가 돌아온다.** 경계 없는 kit 버튼도 `ButtonText` 테두리를 그린다.
- **버튼만 있는 묶음은 `--control-gap`(4px) 간격이다.** panel footer, PageHeader `actions`, 챕터 header `actions`, 버튼만 담은 기능 행에 쓴다. form 필드·카드 간격에는 쓰지 않는다.

## 수용 기준

### UX12-CONTROLS-AC01
**아이콘 ghost 경계 없음:** 목록의 `더보기`, 패널 닫기(X)는 테두리가 투명한 1px이고, 크기는 기존 IconButton 크기(sm 28px, md 36px)를 유지한다.

### UX12-CONTROLS-AC02
**Text 버튼·링크 경계 없음:** 프로필 버튼과 뒤로가기 링크, 본문 검색의 `설정` 버튼은 기본 상태에서 보이는 테두리가 없다.

### UX12-CONTROLS-AC03
**나머지 경계 유지:** light·dark 모두, 화면의 `Button`·`IconButton` 중 기본 상태에 배경과 테두리가 모두 없는 것은 아이콘 전용 버튼 또는 `borderless`뿐이다. `복사` 같은 일반 ghost 텍스트 버튼과 tab은 테두리가 보인다. AI 질문의 `새 대화`와 `질문 범위`는 UX12-ASK에서 FAB와 아이콘 버튼이 되었다.

### UX12-CONTROLS-AC04
**Hover 배경:** 경계 없는 kit 버튼, 목록 제목 링크, 본문 검색 `설정` 버튼에 pointer를 올리면 `--color-state-hover` 배경이 생긴다.

### UX12-CONTROLS-AC05
**버튼 묶음 간격:** Workspace 만들기 dialog의 취소·만들기 사이 간격과 PageHeader `actions`, panel footer의 간격은 4px이고, 각 버튼 높이는 24px 이상이다.

### UX12-CONTROLS-AC06
**Forced colors:** `forced-colors: active`에서 경계 없는 kit 버튼의 테두리가 보인다.

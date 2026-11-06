# UX12-GLASS — floating 표면 gradient·복귀 bar 모양

**E2E:** `tests/e2e/quality/ux12-glass.spec.ts`

**Phase:** `UX12-GLASS.0`

**상태:** UX12 DESIGN-4·SHELL-2 신규 2026-11-06 (사용자 피드백 "glassmorphism 개선: gradation 색상 입히기", 복귀 bar "버튼 padding 축소", "floating 영역 padding 더 넓게(최종적으로 width 더 넓게, height 지금과 동일)", "배경 glassmorphism 적용", "floating 영역 테두리 둥글게"). **결정:** D-3(파랑→라벤더 옅은 tint). **연계:** [디자인 시스템](../design-system.md) §1·§3·§4, [UX11-RETURN](ux11-return.md) AC05, [UX12 계획](../implementation/ux12/index.md). X 버튼 테두리는 UX12 DESIGN-1에서 없앴다.

## 규칙

- **층:** `.glass-surface`는 `--color-glass` 배경색 위에 테마별 `--glass-gradient`(파랑→라벤더, 135도)를 `background-image`로 얹는다. 표면을 쓰는 곳(side panel·popover·menu·select·toast·top bar·복귀 bar)은 코드를 바꾸지 않아도 같은 층을 받는다.
- **색 한도:** gradient 두 끝 모두 `contrast.test.ts`가 고정한다. 글자 4.5:1 이상, 비텍스트 3:1 이상, hover 배경과의 차이 1.1 이상(양 테마).
- **불투명 표면:** 모바일 sheet와 full-screen paired dialog는 blur 없는 `--color-glass-solid` 위에 같은 gradient를 얹는다. 읽기 영역을 가려도 불투명하다.
- **제외:** PDF·본문 위에 뜨는 태블릿 목차 panel은 gradient 없이 단색 `--color-glass-solid`다. reduced transparency와 blur 미지원 환경도 단색이다.
- **복귀 bar:** 높이 52px는 그대로다. `.control`은 좌우 padding 24px(폭 360px 미만 12px), 모서리 `--radius-xl`, `glass-surface`다. 버튼 좌우 padding은 8px이고, 터치 대상 44px을 유지한다. `.message`도 같은 표면이다. `.notice`(연결 불안정)는 그대로 둔다.

## 수용 기준

### UX12-GLASS-AC01
**gradient 층:** 넓은 화면의 top bar, menu, side panel은 light와 dark에서 각각 그 테마의 파랑→라벤더 gradient를 `--color-glass` 위에 그린다. 두 테마의 gradient 값은 서로 다르다.

### UX12-GLASS-AC02
**모바일 sheet:** 폭 390px의 side panel은 불투명한 `--color-glass-solid` 위에 gradient를 유지하고 blur는 쓰지 않는다.

### UX12-GLASS-AC03
**PDF 위 표면 제외:** 폭 834px에서 PDF와 본문 위에 겹쳐 뜨는 목차 panel은 gradient와 blur 없이 불투명한 단색이다.

### UX12-GLASS-AC04
**복귀 bar 모양:** 폭 390px의 복귀 bar는 높이 52px, 좌우 padding 24px, 모서리 20px, glass 표면이고, 복귀 버튼의 좌우 padding은 8px이며 복귀 버튼과 닫기 버튼은 44px 이상이다. 닫기 버튼에는 테두리가 없다. light와 dark 모두 같다.

### UX12-GLASS-AC05
**320px:** 폭 320px에서 복귀 bar의 좌우 padding은 12px로 줄고, 높이는 52px를 유지하며 화면 안에 들어오고 페이지 가로 스크롤이 생기지 않는다.

### UX12-GLASS-AC06
**복귀 안내 문구:** 복귀에 실패해 나타나는 안내 문구는 복귀 bar와 같은 glass 표면과 모서리를 쓰고, 복귀 bar 위에 겹치지 않게 놓인다.

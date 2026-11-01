# Design System v1.2.7 — Minimal Glass (Platform v1.2)

**상태:** 디자인 시스템 초기 명세 확정 · 2026-10-16 · v1.2 상호작용 상태·glass 개정 2026-10-19 · v1.2.1 버튼 hover 개정 2026-10-19 · v1.2.2 밀도(compact)·스위치·메뉴·Dropzone·Breadcrumb·패널 쌓기 개정 2026-10-20 · v1.2.5 floating glass 불투명도 개정 2026-11-01 · v1.2.6 Toast 왼쪽 bar 제거·CopyButton·객관식 채점 결과 테두리 2026-11-01 · v1.2.7 `SplitView`·docked `FloatingSidePanel`·`--outline-panel-width` 2026-11-02  
**적용:** 전역 Workspace UI, 문서 뷰어, 검색, Questions heatmap, floating side panels  
**키워드:** minimalism, restrained glassmorphism, readability, focus, consistent semantics

## 1. 원칙

1. **Content first:** 책 본문과 문제의 읽기 경험이 최우선. 장식용 그라데이션·과도한 blur·지속 애니메이션 지양.
2. **Glass at interaction layers:** 기본 리스트와 텍스트 페이지는 깔끔한 표면. floating panel/popover/top bar 등 겹쳐 보이는 계층에만 반투명·blur 적용.
3. **Semantic tokens only:** 상태·의미·계층은 token을 통해 표현. 서비스 기능 코드에서 raw hex, 임의 shadow, 임의 radius 사용 금지.
4. **Keyboard + touch parity:** 마우스 hover만으로 제공되는 기능이 있어서는 안 됨.
5. **One interaction pattern:** 문서 검색, 문제 풀이, 편집, 문제 생성 검토는 공통 floating panel primitives 사용.
6. **Themeable:** Light 우선 설계, Dark 및 고대비 환경에서도 정보 유지.

## 2. 기술 구현

- React / Next.js + Tailwind CSS utilities (배치·간격) + **CSS variable 기반 semantic token**.
- Radix Primitives로 Dialog, Popover, Tooltip, Dropdown, Tabs, Focus 관리를 구현하고 외형은 자체 컴포넌트로 만든다.
- `packages/design-tokens`: 토큰 데이터(source), 생성된 CSS/TS의 기준.
- `packages/ui`: 공통 primitives, composed patterns, 도메인 시각화 컴포넌트.
- Storybook: states, interactions, light/dark, responsive 사례 문서.
- Accessibility QA: WCAG 2.2 AA를 목표로, 색상만으로 상태 전달하지 않기, pointer target, keyboard navigation 및 focus 복구 점검.

### 2.1 kit CSS 클래스 명명 (UX3a)

`packages/ui` 스타일시트는 BEM(`block__element--modifier`)을 쓰지 않고 계층형 이름을 쓴다.

- **block만 `qz-` 접두사**를 가진다(`qz-panel`, `qz-button`, `qz-select-content`). 다른 block 안에 놓이는 컴포넌트(예: `qz-radio`, `qz-question-marker`)도 자기 block 이름을 유지한다.
- **element는 접두사 없는 짧은 이름**(`header`, `title`, `body`)이며 CSS에서는 부모 block 아래 native CSS nesting과 자식 결합자(`>`)로만 선택한다. 짧은 이름이 안쪽에 중첩된 다른 컴포넌트의 같은 이름 element에 새지 않도록 descendant 선택자 대신 DOM 경로 그대로의 `>` 체인을 쓴다.

  ```css
  .qz-panel {
    > .header { … }
    > .header > .heading > .title { … }
    &[data-size='wide'] { … }
  }
  ```

- **modifier는 클래스가 아니라 `data-*` 속성**(`data-size`, `data-tone`, `data-multiline`)이거나 Radix가 주는 `data-state`/`aria-*`를 쓴다.
- 유틸리티(`qz-focus-ring`, `qz-visually-hidden`, `qz-theme-scope`, `glass-surface`)는 그대로 둔다.
- 여러 block의 element를 묶는 규칙(focus 경계, hover)은 기존 cascade 순서를 유지해야 하므로 specificity를 바꿀 때는 `:where()`로 보존하고 이유를 주석으로 남긴다.
- 기능 코드(`apps/web`)의 스타일은 kit element 클래스를 재사용하거나 덮어쓰지 않고 CSS Modules(camelCase)를 쓴다. kit 스타일은 block 루트의 `className`으로만 조정한다.

참조: https://www.radix-ui.com/primitives/docs/components/dialog  
참조: https://www.w3.org/TR/WCAG22/  
참조: https://www.w3.org/WAI/WCAG22/Understanding/use-of-color

## 3. Color tokens

### 3.1 Light theme

| Token | 값 | 사용 |
|---|---|---|
| `--color-canvas` | `#F7F8FA` | 페이지 배경 |
| `--color-surface` | `#FFFFFF` | 카드·읽기 화면 |
| `--color-surface-muted` | `#F0F3F7` | subtle group |
| `--color-text-primary` | `#172033` | 기본 텍스트 |
| `--color-text-secondary` | `#636D82` | 보조 텍스트(surface-muted 위에서도 4.5:1 이상) |
| `--color-border` | `#E6E9EF` | 표면 경계·구분선(장식용, 필수 경계는 `--color-border-strong`) |
| `--color-accent` | `#5268D8` | primary action, navigation |
| `--color-accent-hover` | `#4A5EC1` | primary(accent 채움) 버튼·체크된 선택 컨트롤 hover |
| `--color-accent-pressed` | `#4355AD` | primary 버튼 누르는 동안(`:active`) |
| `--color-focus` | `#356CFF` | focus outline |
| `--color-glass` | `rgba(246,248,252,.97)` | floating glass surface(아주 옅은 tint, 거의 불투명) |
| `--color-glass-solid` | `#F6F8FC` | glass의 불투명 대응색(reduced transparency·blur 미지원 fallback, 모바일 sheet) |
| `--color-glass-stroke` | `rgba(255,255,255,.66)` | inset/translucent border |
| `--question-status-unseen` | `#D9DEE5` | 보지 않은 문제 |
| `--question-status-viewed` | `#858E9B` | 보기만 한 문제 |
| `--question-status-incorrect` | `#E0525E` | 틀린 문제 |
| `--question-status-correct` | `#26865C` | 맞은 문제 |
| `--question-status-retry` | `#E9B447` | 다시 풀기 |
| `--color-border-strong` | `#7D8799` | 입력 컨트롤 경계(표면 대비 3:1 이상) |
| `--color-on-accent` | `#FFFFFF` | accent 채움 위 텍스트·아이콘 |
| `--color-danger` | `#C42B3A` | 오류·파괴적 동작 피드백(텍스트 대비 4.5:1 이상) |
| `--color-success` | `#1E7A52` | 성공 피드백(텍스트 대비 4.5:1 이상) |
| `--color-warning` | `#8F5F00` | 경고 피드백(텍스트 대비 4.5:1 이상) |
| `--color-scrim` | `rgba(247,248,250,.64)` | modal·drawer backdrop |
| `--color-state-hover` | `#ECEFF4` | 버튼·메뉴 항목·탭 hover 배경 |
| `--color-state-pressed` | `#E3E7EE` | 누르는 동안(`:active`) 배경 |
| `--color-state-selected` | `#E4E9FB` | 선택·켜짐 상태(`aria-pressed="true"`, `data-state="on"`) 배경 — hover와 다른 accent tint |
| `--color-state-selected-hover` | `#D2DAF7` | 선택·켜짐 상태 위 hover 배경 |
| `--color-switch-track` | `#7D8799` | 꺼진 스위치 track 채움(표면 대비 3:1 이상, 컨트롤 경계) |
| `--color-switch-track-hover` | `#687285` | 꺼진 스위치 track hover 채움 |
| `--color-switch-track-border` | `#B9C0CC` | 꺼진 스위치 track 테두리(채움보다 연함) |
| `--color-switch-track-checked-border` | `#8C9CE6` | 켜진 스위치 track 테두리(accent 채움보다 연함) |

**v1.1.1 추가:** `--color-border-strong`, `--color-on-accent`, `--color-danger`/`success`/`warning`, `--color-scrim`, typography scale(`--font-size-*`, `--line-height-*`, `--font-weight-*`), breakpoint(`--breakpoint-*`). feedback 색은 question-status 토큰을 재사용하지 않으며(의미가 다름), canvas·surface 위 텍스트로 4.5:1 이상을 만족한다.

**v1.1.2 (M7.2):** `--color-text-secondary` light `#667085` → `#636D82`. 보조 텍스트가 선택·현재 항목, 메타 정보 등 `--color-surface-muted` 위에도 쓰여 4.47:1로 AA에 미달했다(axe 전 화면 검사). 같은 색조로 4.67:1(muted)·4.89:1(canvas)·5.2:1(surface)을 만족한다. 앱은 별도 선택이 없으면 OS `prefers-color-scheme`을 따라 Dark token을 적용한다(`[data-theme]`가 있으면 그 값이 우선).

**v1.2 (UX1, 2026-10-19 사용자 피드백):** glass는 더 불투명하게(light `.78`→`.9`, dark `.79`→`.9`), 순백 대신 아주 옅은 tint(`#F6F8FC` 계열)를 쓰고 불투명 fallback은 같은 색의 `--color-glass-solid`다. `--color-border`는 더 옅게(light `#DEE3EB`→`#E6E9EF`, dark `#364251`→`#2D3745`): 장식용 구분선 전용이며, 입력 필드·체크박스·라디오처럼 경계가 유일한 식별 수단인 컨트롤은 계속 `--color-border-strong`(3:1)을 쓴다. 상호작용 상태 배경 `--color-state-hover`/`-pressed`/`-selected`를 추가했다(§4.1). 대비: text-primary는 세 상태 배경 모두에서, text-secondary는 hover 배경에서 4.5:1 이상(`contrast.test.ts`).

**v1.2.1 (UX2, 2026-10-19 사용자 피드백):** 모든 버튼 종류에 보이는 hover를 둔다(§4.1). accent 채움(primary)용 `--color-accent-hover`/`--color-accent-pressed`(light는 더 어둡게, dark는 더 밝게)와 켜진 toggle용 `--color-state-selected-hover`를 추가했다. 대비: `--color-on-accent`는 accent·hover·pressed 채움 모두에서, text-primary는 selected-hover에서 4.5:1 이상이며, hover·pressed 채움은 기본 accent와 서로 구분된다(`contrast.test.ts`).

**v1.2.2 (UX3b, 2026-10-20 사용자 피드백):** 스위치 track 테두리를 채움보다 연한 색으로 바꿨다. 꺼진 track은 옅은 회색 + 진한 테두리 대신 `--color-switch-track` 채움(표면·canvas·muted·glass 대비 3:1 이상)이 컨트롤 경계를 맡고, 테두리 `--color-switch-track-border`는 그 채움보다 밝다. 켜진 track은 accent 채움 + 더 밝은 `--color-switch-track-checked-border`. thumb은 두 상태 모두 `--color-on-accent`(track 대비 3:1 이상)이며 켜짐/꺼짐은 thumb 위치·`aria-checked`·상태 문구로 전달한다(색만으로 구분하지 않음). 꺼진 track hover는 테두리가 아니라 채움이 `--color-switch-track-hover`로 바뀐다(`contrast.test.ts`).

**v1.2.5 (UX-GLASS, 2026-11-01 사용자 피드백):** floating 계층(side panel·popover·menu·select·toast·top bar)의 glass를 아래 내용이 거의 보이지 않을 만큼 더 불투명하게 했다(light·dark 모두 `.9`→`.97`). tint와 blur(`--glass-blur` 16px)는 그대로이고, reduced transparency·blur 미지원·모바일 sheet fallback은 계속 같은 색의 `--color-glass-solid`다. 대비: 반투명 glass를 가장 나쁜 배경(순흑·순백) 위에 합성해도 text-primary·text-secondary가 4.5:1 이상이다(light text-secondary 최저 4.59:1; `.96`은 4.47:1로 미달, `contrast.test.ts`).

**v1.2.6 (UX7-QDISPLAY, 2026-11-01 사용자 피드백):** 객관식 제출 뒤 보기 행 테두리(§4.1 "채점 결과 테두리")는 새 토큰 없이 기존 의미 토큰을 쓴다: 맞힌 보기 `--color-success`, 오답일 때 고른 보기 `--color-border-strong`(회색), 오답일 때 정답 보기 `--color-danger`(사용자 결정: 정답 보기를 빨간 테두리로). 셋 모두 풀이 panel이 놓이는 표면(surface·canvas·surface-muted·glass-solid) 대비 비텍스트 3:1 이상이다(light/dark 최저: success 4.76/6.45, danger 5.03/5.84, border-strong 3.25/3.61 — muted 위; `contrast.test.ts`). 테두리 색은 의미를 보강할 뿐이고 각 행의 "정답"·"내 선택" 글자가 의미를 전달한다.

**상태 점은 기본 표면과 충분히 구분되도록** 최소 얇은 outline을 갖고, 상태 필터(색 견본 + 상태 텍스트)가 범례 역할을 한다(UX3c 2026-10-20: 상시 범례·상태 요약 삭제, 사용자 결정). 작고 색만 있는 점으로 WCAG 텍스트 대비를 충족하는 것으로 오해하지 않는다. 색 외 상태 설명을 tooltip, 텍스트 요약, screen reader label로 제공한다.

### 3.2 Dark theme (초안)

```css
[data-theme="dark"] {
  --color-canvas: #11151D;
  --color-surface: #1B222D;
  --color-surface-muted: #27313E;
  --color-text-primary: #F2F5F9;
  --color-text-secondary: #ACB7C5;
  --color-border: #2D3745;
  --color-accent: #8CA0FF;
  --color-accent-hover: #9AACFE;
  --color-accent-pressed: #A7B6FD;
  --color-focus: #A2B3FF;
  --color-glass: rgba(30, 38, 51, 0.97);
  --color-glass-solid: #1E2633;
  --color-glass-stroke: rgba(255,255,255,.12);
  --question-status-unseen: #4E5967;
  --question-status-viewed: #9EA7B4;
  --question-status-incorrect: #F17B84;
  --question-status-correct: #4BC68E;
  --question-status-retry: #F4C763;
  --color-border-strong: #7A8799;
  --color-on-accent: #11151D;
  --color-danger: #FF8A93;
  --color-success: #4FCB92;
  --color-warning: #F2C14E;
  --color-scrim: rgba(17, 21, 29, 0.64);
  --color-state-hover: #2A3442;
  --color-state-pressed: #334051;
  --color-state-selected: #2E3958;
  --color-state-selected-hover: #39456C;
  --color-switch-track: #6E7A8C;
  --color-switch-track-hover: #808C9E;
  --color-switch-track-border: #8A95A6;
  --color-switch-track-checked-border: #B4C1FF;
}
```

다크 모드에서도 unseen/viewed의 상대적인 시각 구분이 필요하다. 실제 화면에서 대비를 측정해 필요한 경우 token 수준에서 조정한다.

### 3.3 실사용 CSS 예시

```css
:root {
  color-scheme: light;
  --color-canvas: #F7F8FA;
  --color-surface: #FFFFFF;
  --color-surface-muted: #F0F3F7;
  --color-text-primary: #172033;
  --color-text-secondary: #636D82;
  --color-border: #E6E9EF;
  --color-accent: #5268D8;
  --color-accent-hover: #4A5EC1;
  --color-accent-pressed: #4355AD;
  --color-focus: #356CFF;
  --color-glass: rgba(246,248,252,.97);
  --color-glass-solid: #F6F8FC;
  --color-glass-stroke: rgba(255,255,255,.66);
  --question-status-unseen: #D9DEE5;
  --question-status-viewed: #858E9B;
  --question-status-incorrect: #E0525E;
  --question-status-correct: #26865C;
  --question-status-retry: #E9B447;
  --color-border-strong: #7D8799;
  --color-on-accent: #FFFFFF;
  --color-danger: #C42B3A;
  --color-success: #1E7A52;
  --color-warning: #8F5F00;
  --color-scrim: rgba(247,248,250,.64);
  --color-state-hover: #ECEFF4;
  --color-state-pressed: #E3E7EE;
  --color-state-selected: #E4E9FB;
  --color-state-selected-hover: #D2DAF7;
  --color-switch-track: #7D8799;
  --color-switch-track-hover: #687285;
  --color-switch-track-border: #B9C0CC;
  --color-switch-track-checked-border: #8C9CE6;

  --font-sans: "Pretendard", "Inter", system-ui, -apple-system, sans-serif;
  --font-size-label-sm: 12px;
  --font-size-label: 13px;
  --font-size-body: 14px;
  --font-size-body-lg: 16px;
  --font-size-section-title: 18px;
  --font-size-page-title: 26px;
  --line-height-tight: 1.2;
  --line-height-snug: 1.4;
  --line-height-normal: 1.5;
  --line-height-relaxed: 1.6;
  --font-weight-regular: 400;
  --font-weight-semibold: 600;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-xl: 20px;
  --radius-pill: 999px;
  --glass-blur: 16px;
  --shadow-floating: 0 18px 56px rgba(30, 39, 59, .15);

  --control-height-sm: 28px;
  --control-height-md: 36px;
  --app-header-height: 56px;
  --app-sidebar-width: 232px;
  --content-max-width: 1440px;
  --breakpoint-md: 768px;
  --breakpoint-lg: 1024px;
  --floating-panel-width: 500px;
  --outline-panel-width: 20rem; /* v1.2.7 (DOCVIEW-PORT): 탐색 panel(size="narrow")·docked 목차 panel 폭 */
  --heatmap-cell: 24px;        /* v1.2.3 (UX5-UI): 28px → 24px */
  --heatmap-cell-touch: 32px;
  --heatmap-gap: 0px;          /* v1.2.3 (UX5-UI): 4px → 0 */
  --heatmap-dot: 16px;         /* 장식용 marker(legend·요약·preview). heatmap 점은 셀 크기로 그린다 */
  --heatmap-marker-hover-scale: 1.18;
}

.glass-surface {
  background: var(--color-glass);
  border: 1px solid var(--color-glass-stroke);
  box-shadow: var(--shadow-floating);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
}

/* 적은 투명도를 선호하거나 blur 지원이 없는 환경의 fallback */
@supports not (backdrop-filter: blur(1px)) {
  .glass-surface { background: var(--color-glass-solid); }
}
@media (prefers-reduced-transparency: reduce) {
  .glass-surface { background: var(--color-glass-solid); backdrop-filter: none; }
}
/* 짧은 duration이 아니라 끈다(UX7-CSS 2026-11-02): transition-property 기본값이 all이라 0.01ms는 모든 스타일 변경을 1 frame transition으로 만들어 computed style이 한 frame 동안 시작 값을 보였다. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation: none !important; transition: none !important; }
}
```

reduced motion에서는 transition·animation이 전혀 실행되지 않으므로 상태 변화(색·테두리·크기)는 같은 frame에 computed style에 반영된다. 종료 animation에 기대는 overlay(Radix dialog·popover·menu·toast, `FloatingSidePanel`)는 `animation-name: none`이면 Radix presence가 바로 unmount하므로 그대로 닫히고, kit에서 `transitionend`를 기다리는 `useAnimatedHeight`는 reduced motion에서 전환을 시작하지 않는다. `transitionend`/`animationend`에 의존하는 새 코드는 reduced motion에서도 끝나는 경로(타이머 또는 즉시 완료)를 둔다. 품질 suite `A11Y-10`이 같은 frame 반영과 overlay 닫힘을 검사한다.

## 4. Typography / Layout / Elevation

| 분류 | 권장 |
|---|---|
| Body | 14–16px; 긴 본문은 16px/1.6 이상 |
| Label | 12–13px, secondary text |
| Page title | 24–28px/1.2, 굵기 600 |
| Section title | 16–18px, 굵기 600 |
| Typography token | label `--font-size-label-sm`(12)/`--font-size-label`(13), body `--font-size-body`(14)/`--font-size-body-lg`(16, 긴 본문은 `--line-height-relaxed` 1.6), section `--font-size-section-title`(18), page title `--font-size-page-title`(26)/`--line-height-tight`, 굵기 `--font-weight-semibold`(600) |
| Breakpoint | mobile `< 768px`(`--breakpoint-md`), tablet 768–1023px, desktop `≥ 1024px`(`--breakpoint-lg`, sidebar 표시). CSS 변수는 media query 안에서 쓸 수 없으므로 media query는 같은 px 값을 range 문법(`(width >= 768px)`)으로 쓰고, `packages/ui` 테스트가 토큰 값과 일치하는지 검사한다. TS는 `@quiz/design-tokens`의 `breakpoints`/`mediaQueries`를 사용한다 |
| Global header | 56px 높이(`--app-header-height`, v1.2.2에서 64→56) |
| Control height (v1.2.2) | md `--control-height-md` 36px(Button·IconButton·입력·Select trigger·tab·메뉴/Select 항목), sm `--control-height-sm` 28px(작은 버튼·IconButton, BackLink). 모두 WCAG 2.2 target size 24px 이상. heatmap 셀(24/32px)은 §6 규격 그대로 |
| Density (v1.2.2) | 버튼 좌우 padding md 12px; 입력 세로 padding 4px; 여러 줄 입력 최소 80px; panel header 12/12/8/20px · body 16/20px · footer 8/20/12px; modal body 16/20px; popover 12px; 메뉴·Select 항목 36px; Surface padding sm 8 / md 12 / lg 20px; EmptyState 세로 24px; PageHeader 간격 12px·아래 20px·뒤로가기/breadcrumb 줄과 제목 사이 12px(UX5-UI); sidebar 12/8px; heatmap 챕터 간격 20px |
| Left navigation | 232px 고정(데스크톱), 모바일 drawer |
| Content area | max-width 1440px, padding 20px(태블릿 이상, v1.2.2에서 24→20) / 16px(모바일) |
| Border radius | 기본 10px, 떠 있는 패널 16–20px |
| Layering | 기본 카드 0–1, popover 20, side panel 40, modal 60, toast 70 |
| Animation | panel enter/exit 약 180–240ms, transform+opacity, reduced-motion 대응. 컴포넌트 상태 전환(hover·active·selected·focus 배경/색)은 `--duration-state`(120ms) `--easing-standard`로 전환하고, reduced-motion에서는 즉시 변경 |

Panel이 떠 있어도 본문을 읽기 쉬워야 하므로 배경 glass 효과를 과용하지 않는다. 기본 표면은 opaque white/dark surface다.

### 4.1 상호작용 상태·경계 (v1.2, UX1 · v1.2.1, UX2)

- **Hover와 선택은 다른 배경:** hover `--color-state-hover`(중립 회색), 누르는 동안 `--color-state-pressed`, 선택·켜짐(`aria-pressed="true"`, `data-state="on"`) `--color-state-selected`(accent tint) + 굵기·아이콘 변화. 선택 상태에만 생기는 테두리는 쓰지 않는다.
- **선택 표시 bar 없음 (UX4, 2026-10-21):** 버튼·tab·목록 항목 버튼의 선택/현재 상태를 왼쪽이나 아래쪽 accent 테두리(bar, `border-bottom`, inset `box-shadow`)로 그리지 않는다. 선택은 `aria-pressed`/`aria-selected`/`aria-current`와 배경(selected 채움 또는 muted 표면)·굵기로 전달한다.
- **버튼 문구는 줄바꿈하지 않는다 (UX4):** `Button`은 `white-space: nowrap`이고 줄어들지 않는다(`flex-shrink: 0`). 좁은 화면(375px)에서는 버튼 묶음이 버튼 단위로 다음 줄로 넘어가거나(flex-wrap) 묶음 안에서 가로 스크롤되며, 페이지 전체 가로 스크롤은 생기지 않게 한다.
- **Toggle 버튼:** 꺼진 상태에 테두리·배경이 없다(ghost). 켜짐은 배경 채움 + `aria-pressed`(또는 바뀌는 label) + 굵기/아이콘으로 전달하며 색만으로 구분하지 않는다. `Button`/`IconButton` primitive가 `aria-pressed`/`data-state`를 보고 처리하므로 기능 코드는 테두리·배경을 따로 지정하지 않는다.
- **테두리 최소화:** Badge·tab 수 표시에는 테두리·원형 배경을 두지 않는다. 구분선은 1px `--color-border`. 2px는 오류 입력(`aria-invalid`)과 focus ring에만 쓴다. 입력 필드·체크박스·라디오의 평소 경계는 `--color-border-strong`이고 스위치 track은 `--color-switch-track` 채움이 경계를 맡으며(테두리는 채움보다 연함, v1.2.2), focus 중에는 아래 규칙대로 focus 색으로 바뀐다.
- **채점 결과 테두리 (v1.2.6, UX7-QDISPLAY 2026-11-01):** 풀이 panel(QPLAY-01)의 객관식 보기 행은 제출 전부터 2px 투명 테두리를 갖고, 제출 결과가 오면 테두리 색만 바뀐다(두께가 그대로라 레이아웃이 움직이지 않는다). 정답이면 고른 보기가 `--color-success`, 오답이면 고른 보기가 `--color-border-strong`(회색)이고 정답 보기가 `--color-danger`다(복수 정답 오답에서 고른 정답 보기도 정답 보기이므로 빨간 테두리). 각 표시 행에는 "정답"·"내 선택"·"정답 · 내 선택" 글자가 붙고 radio/checkbox의 `aria-describedby`로 읽힌다(색만으로 전달하지 않음). forced-colors에서는 표시 행 테두리가 `Highlight`(정답 보기·맞힌 보기)·`GrayText`(오답으로 고른 보기)이고 표시 없는 행은 `Canvas`로 보이지 않는다. 이 테두리는 "2px는 오류 입력과 focus ring에만" 규칙의 예외이며, 정답 보기 표시(문제 상세의 2px `--color-success` 정답 테두리)와 같은 두께다.
- **Focus:** `:focus-visible` ring은 2px `--color-focus`(forced-colors에서는 `Highlight`)이며, 메뉴·Select 항목의 ring도 키보드 focus(`:focus-visible`)에서만 그린다(pointer hover는 배경만).
- **Focus 경계는 하나:** 테두리가 있는 요소는 자기 테두리와 별도의 focus ring이 겹쳐 이중 테두리로 보이지 않게 한다. focus 중에는 테두리 색을 `--color-focus`로 바꾸고 ring을 그 위에 그린다. 테두리 두께는 바꾸지 않으므로 레이아웃 이동이 없다.
  - 입력 필드(`Input`·`Textarea`·`Select` trigger), secondary 버튼, tab, 테두리가 있는 카드·버튼·입력(기능 CSS 포함), heatmap 선택 dot: ring을 안쪽(`outline-offset: -2px`)에 그려 테두리를 덮는다. 테두리가 있는 그룹 안의 버튼(segmented view switch)도 그룹 테두리와 붙지 않게 안쪽 ring을 쓴다.
  - 체크박스·라디오·스위치: 체크 상태의 accent 채움 위에서는 안쪽 ring이 보이지 않으므로 ring을 테두리 바로 바깥(`outline-offset: 0`)에 붙여 바뀐 테두리와 하나의 경계로 이어지게 한다.
  - 오류 입력이 focus되면 ring이 우선한다(오류 테두리는 ring에 덮이고 blur 시 돌아온다). 오류 문구·아이콘·`aria-invalid`가 계속 남으므로 오류 여부는 색에 의존하지 않고 인식된다.
  - 테두리가 없는 요소(링크, primary·ghost 버튼, toggle 버튼)는 기존처럼 2px 바깥 간격(`outline-offset: 2px`)으로 ring을 그린다.
- **모든 버튼에 hover (v1.2.1, UX2):** 버튼 종류마다 hover가 눈에 보이고, 누르는 동안(pressed)·선택(selected)과 다른 모습이다.

  | 종류 | 기본 | hover | pressed(`:active`) | 켜짐/선택 |
  |---|---|---|---|---|
  | primary(`Button`·`IconButton`) | `--color-accent` 채움 | `--color-accent-hover` | `--color-accent-pressed` | — |
  | secondary | `--color-surface` + 1px `--color-border` | `--color-state-hover` | `--color-state-pressed` | — |
  | ghost(`IconButton` 기본 포함) | 투명 | `--color-state-hover` | `--color-state-pressed` | — |
  | toggle 꺼짐(`aria-pressed="false"`, `data-state="off"`) | 투명, 테두리 없음 | `--color-state-hover` | `--color-state-pressed` | — |
  | toggle 켜짐(`aria-pressed="true"`, `data-state="on"`) | `--color-state-selected` + 굵기/아이콘 | `--color-state-selected-hover` | `--color-state-pressed` | 기본이 곧 켜짐 |
  | tab trigger | 투명 | `--color-state-hover` + text-primary | `--color-state-pressed` | `--color-state-selected` 배경 + text-primary + `aria-selected` (하단 bar 없음, UX4) |
  | 체크박스·라디오 | `--color-border-strong` 경계 | 꺼짐: 경계 `--color-text-primary`, 켜짐: 채움·경계 `--color-accent-hover` | — | accent 채움 |
  | 스위치 | `--color-switch-track` 채움 + 더 연한 `--color-switch-track-border` | 꺼짐: 채움 `--color-switch-track-hover`, 켜짐: 채움 `--color-accent-hover` | — | accent 채움 + `--color-switch-track-checked-border` |
  | 기능 CSS의 버튼(segmented view switch, 목록 항목 버튼, outline tree 항목) | 각자 | `--color-state-hover`(view switch 꺼진 칸은 text-primary도) | view switch: `--color-state-pressed` | 표면·배경·굵기 + `aria-pressed`/`aria-current` (왼쪽/아래 accent bar 없음, UX4) |
  | 텍스트 버튼(`linkButton`)·링크 | 밑줄 | 밑줄이 굵어지거나(텍스트 버튼) 밑줄 표시(링크) | — | — |

  hover는 `@media (hover: hover)` 안에서만 적용해 터치 후 hover가 남지 않게 하고, 비활성(`:disabled`)에는 적용하지 않는다. pressed는 모든 입력에 적용한다. focus 중인 테두리 컨트롤은 hover 중에도 focus 경계 하나를 유지한다(아래 "Focus 경계는 하나"). 기능 코드는 kit `Button`/`IconButton`을 쓰고, 부득이한 버튼형 클래스도 위 토큰만 쓴다.
- **Dropdown 메뉴 (v1.2.2, UX3b):** 성격이 다른 항목은 `DropdownMenuGroup` + `DropdownMenuLabel`(그룹 이름, `aria-labelledby`로 연결)과 `DropdownMenuSeparator`로 나눈다(예: Workspace 전환 메뉴의 "내 Workspace" 목록과 "모든 Workspace 보기"). 링크로 렌더링되는 항목(`asChild` + `<a>`/Next `Link`)은 방문·hover·focus·누름 어느 상태에서도 밑줄이 없고 메뉴 글자색(`--color-text-primary`, danger 항목은 `--color-danger`)을 유지하며, kit의 항목 스타일이 이를 보장하므로 기능 코드는 따로 지정하지 않는다. 현재 항목(`aria-current`)은 굵기로 표시한다.
- **열린 목록의 현재 항목은 닫기 (UX7-SELECT, 2026-11-01):** 열린 `Select` 목록이나 Dropdown 메뉴에서 현재 선택된(체크·`aria-current`) 항목을 누르면 값은 그대로 두고 목록이 닫히며 focus는 trigger로 돌아간다. 마우스 클릭, 터치 탭(iPhone Safari 포함), 키보드 Enter/Space 모두 첫 입력에 닫힌다. `Select`는 터치·펜으로 열 때 Radix의 "여는 동작의 pointerup 무시" 보호를 쓰지 않는다: 탭은 pointerup 뒤에 click으로 열리므로 그 보호가 다음 탭(목록 맨 위의 선택 항목)의 pointerup을 취소했고, iOS Safari는 취소된 터치 pointerup의 click을 보내지 않아 첫 탭이 무시됐다. 마우스로 열 때는 보호를 유지해 trigger를 누른 포인터가 떼어지는 순간 항목이 골라지지 않는다.
- **전환:** 상태 전환은 `--duration-state`/`--easing-standard`(kit 변수 `--qz-transition-fast`), `prefers-reduced-motion: reduce`에서는 transition 없이 즉시(`@quiz/design-tokens/base.css`, §3.3).
- **메뉴·선택 항목 설명은 Tooltip:** 선택지 옆 설명 문구는 항상 보이는 텍스트 대신 공통 `Tooltip`(hover·키보드 focus)으로 보여 주고(hover 지연: 일반 tooltip `TOOLTIP_DELAY_MS` 300ms, 선택지 설명 `TOOLTIP_DESCRIPTION_DELAY_MS` 700ms — 포인터가 선택지 목록을 지나갈 때 설명이 연달아 뜨지 않게 함. 키보드 focus는 지연 없이 즉시, v1.2.2), 같은 문구를 숨김 텍스트로 `aria-describedby`에 연결한다. hover가 없는 기기(`(hover: none)`)에서는 설명을 인라인 텍스트로 계속 표시한다. 오답·정답 표시, 비활성 사유처럼 필수 정보는 tooltip으로 옮기지 않는다.

## 5. Floating Side Panel

### 5.1 공통 패턴

- Desktop right panel: width `min(500px, calc(100vw - 32px))`, top/right/bottom margin `16px`, rounded `20px`, glass surface, shadow, viewport 내부 독립 scroll.
- `QuestionPracticePanel`: **modal** 기본. 정답을 제출하거나 뒤로/다음 이동하는 명확한 흐름. backdrop 클릭/ESC 처리 정책 정의, 닫을 때 trigger dot로 focus 복귀.
- `DocumentExcerptPanel`: **non-modal** 기본. PDF·검색 결과와 동시에 볼 수 있음.
- **`QuestionViewer` (MOCK-SPEC 2026-11-01):** 문제를 하나씩 보이는 모든 곳의 공통 컴포넌트. 방식 `practice`(위 `QuestionPracticePanel` 규칙: modal, 한 문제, 이전·다음) · `sequence`(범위 풀이: modal, 진행 `ProgressBar`·`이전`·`다음`·`건너뛰기`·결과 요약) · `manage`(정답·해설·출처·수정 이력과 호출 위치가 넘긴 동작; 풀이 panel 메뉴·보관·초안 문제 행에서는 UX7-BANK-2의 modal "문제 상세" `ModalDialog` 안) · `read-only`(공유 게스트, non-modal). 범위 고르기 부품 `QuestionRangePicker`(tri-state `전체 선택`·장·문제 checkbox)는 모의고사 만들기와 같이 쓴다. 호출 위치·동작·AC는 [QVIEW-01](screens/question-viewer.md).
- **왼쪽·좁은·docked panel (DOCVIEW 2026-11-01, v1.2.7 DOCVIEW-PORT 2026-11-02 — API 하나로 정리):** `FloatingSidePanel`의 위치·크기 prop은 다음 넷뿐이다.
  - `side`: `end`(기본, LTR 오른쪽) · `start`(왼쪽; 데스크톱에서 왼쪽 16px margin, 들어오고 나갈 때 왼쪽에서 움직임). 모바일(< 768px) viewport panel은 어느 쪽이든 같은 bottom sheet/full-height 레이아웃이다.
  - `size`: `default`(`min(--floating-panel-width, 100vw - 32px)`) · `wide`(비교 drawer, ≥ 600px) · `narrow`(탐색용 열, `min(--outline-panel-width, 100vw - 32px)`).
  - `placement`: `viewport`(기본; viewport에 고정, 16px margin) · `docked`(지정한 `container` — position이 있는 요소 — 의 `side` 쪽 위에 붙어 container 높이 전체를 쓰는 panel. 항상 non-modal(`modal`은 무시)이고 폭은 `narrow`와 같은 `--outline-panel-width`(docked에서는 `size`를 쓰지 않음), container가 없으면 렌더하지 않는다. 모든 폭에서 container 안에 붙으며 glass surface·`--shadow-floating`·radius·header/close·독립 scroll은 같다).
  - `dockMode`(docked에서만): `inset`(기본, 넓은 container — 열린 동안 container에 `data-qz-dock-inset="start|end"`를 두어 그쪽 padding을 panel 폭만큼 늘려 옆 내용이 비켜선다) · `overlay`(좁은 container — 내용 위에 겹쳐 뜬다. 읽기 영역(PDF·텍스트)을 가리므로 화면 쪽에서 불투명 `--color-glass-solid`, blur 없음).
  - `id`: panel 요소 id. Radix `trigger`가 아닌 panel 밖 toggle은 `aria-expanded` + `aria-controls`로 이 id를 가리키고, 그 toggle은 돌아갈 opener가 없을 때(저장된 상태로 열린 채 mount된 panel) 닫힘 뒤 focus를 받으며 non-modal panel에서 Tab이 나갈 기준이 된다. `trigger`가 있고 `id`를 주면 trigger의 `aria-controls`도 같은 id를 가리킨다.
  - docked panel이 열린 채 mount되면(저장된 상태 복원) focus를 옮기지 않고, 사용자가 열 때만 안으로 옮긴다. Escape는 focus가 panel 안에 있을 때만 닫는다(non-modal 규칙).
  - 쓰는 곳: DOCVIEW-01 목차 panel — 데스크톱 `side="start" placement="docked" dockMode="inset"`, 태블릿 `dockMode="overlay"`, 좁은 화면 `placement="viewport" mobileLayout="full"`. DOC-02 v1.4의 PDF 도구 막대 목차(viewport `side="start" size="narrow"`)는 DOCVIEW-PORT에서 이것으로 바뀌었다(DOC-02-AC06 폐기). 이전 브랜치의 `side="left"/"right"` 이름은 쓰지 않는다(`start`/`end`가 같은 뜻).
- `QuestionGenerationReviewPanel`: 충분한 공간이 필요하므로 desktop에서는 600px 이상 비교 drawer 또는 전체 page 모드 제공(500px 강제 금지).
- Mobile: full width bottom sheet 또는 full-height panel, safe-area inset, `max-height: 90dvh`; 화면이 좁다면 문제 상세 전체 페이지로 전환 가능.
- URL query: `?question=<id>` 또는 `?panel=...`로 열림 상태/딥링크 복원. 뒤로가기와 동기화(열면 기록 항목 하나, 열린 동안 뒤로가기는 닫기). 닫기 버튼·Escape로 닫으면 연 기록 항목을 되돌려 닫은 뒤 뒤로가기가 그 panel을 다시 열지 않는다(UX7-BACK, Workspace 홈 규칙은 [QOV-01](screens/questions-overview.md) "뒤로가기"·AC14).
- Panel Header: title / breadcrumb / action icons(즐겨찾기·다시 풀기) / close.
- Panel Footer: submit, self-grade, next/previous, loading/error 상태.
- Modal focus trap, title/description, Escape and focus restore는 Radix 기반으로 구성. Non-modal은 배경과 panel 간 키보드 이동을 허용.
- **높이 변화 (v1.2.3, UX5-UI):** 내용에 따라 높이가 정해지는 overlay(ModalDialog·ConfirmDialog, 모바일 bottom sheet)는 내용이 늘거나 줄면(경고·결과가 나타남, 로딩 → 내용) 이전 높이에서 새 높이로 `--duration-panel-enter` `--easing-standard`로 부드럽게 바뀐다(공통 `useAnimatedHeight`: ResizeObserver로 재고 전환 중에만 inline 높이, 끝나면 CSS가 다시 높이를 정함). 높이가 고정된 데스크톱 side panel과 모바일 full 레이아웃은 그대로다. 전환 중 body에 스크롤바를 보이지 않고 focus·스크롤 위치는 유지하며, `prefers-reduced-motion`에서는 즉시 바뀐다.
- **여러 패널 쌓기 (v1.2.2, UX3b):** floating panel·dialog가 여러 개 열려 있으면 **나중에 연 것이 위**에 온다(portal DOM 순서와 무관). 열린 순서의 rank r에 대해 z-index는 `min(--z-side-panel + 2r, --z-modal - 2)`이고, 그 안에서 portal로 뜨는 popover·tooltip·menu는 +1(`LayerProvider`/`useLayerStyle`)이다. 닫았다가 다시 연 패널은 맨 위로 올라온다. 가운데 modal dialog(`--z-modal`)는 항상 모든 패널 위다. 사이드 패널이 아닌 floating dialog도 kit 내부 `useFloatingLayer(open)`을 써서 같은 순서에 참여한다.

## 6. QuestionDot / Heatmap 컴포넌트 계약

```ts
type QuestionDotStatus =
  | 'unseen' | 'viewed' | 'incorrect' | 'correct' | 'retry';

type QuestionDotProps = {
  questionId: string;
  status: QuestionDotStatus;
  isFavorite: boolean;
  questionNumber: string;
  questionType: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
  chapterTitle: string;
  preview: string;
  isSelected?: boolean;
  onOpen: (questionId: string) => void;
};
```

- 기본 marker는 **rounded square**, 즐겨찾기는 **rounded five-point star SVG**(부드러운 꼭짓점: `stroke-linejoin="round"`, 넉넉한 stroke width 또는 rounded SVG path); 두 모양 모두 semantic status color를 채우고 subtle stroke를 적용한다.
- 셀 `24×24px`(mobile·coarse pointer `32×32px`), 셀 간 grid gap `0`. heatmap 점의 marker SVG box는 셀과 같은 크기라 그려진 사각형은 viewBox 18/24 = `18px`(touch `24px`)이고, 이웃 marker 사이 보이는 간격은 `6px`(touch `8px`) = **marker 폭의 1/3 이하**(v1.2.3, UX5-UI 사용자 요청 "점 사이 간격을 점 width의 1/3 이하로"). 장식용 marker(legend·상태 요약·preview)는 `--heatmap-dot` 16px box. favorite는 **크기 확대가 아니라 사각형→별 모양 전환**이다. hover 및 `:focus-visible` 시 marker만 `scale(var(--heatmap-marker-hover-scale))`; transition은 transform 150ms, reduced-motion시 즉시 변경한다.
- favorite는 별 silhouette로 표시하며 상세 텍스트에서도 별 아이콘을 제공. hover/focus scale을 적용해도 고정 셀과 grid 위치는 바꾸지 않는다.
- 선택된 dot는 focus ring/outline으로 강조하고 상태 색은 그대로 유지.
- 점은 `<button>`으로 구현하고 label에 챕터·번호·유형·상태·favorite·retry를 포함.
- roving tabindex 또는 명확한 Tab/Arrow navigation을 제공하여 수백 개의 버튼이 키보드 사용자에게 부담이 되지 않게 한다.
- hover/focus에는 Tooltip/Popover로 preview, click/Enter/Space에는 Floating Question Panel.
- 색맹 등 색상 인지가 어려운 사용자도 구별할 수 있도록 marker label·preview popover·상태 필터에 상태 텍스트를 제공한다. 상시 legend·상태 요약은 UX3c(2026-10-20, 사용자 결정)로 없애고, 상태 필터를 펼치면(기본 접힘, chevron 버튼 `aria-expanded`) 색 견본과 텍스트가 함께 보인다.
- 24 CSS px 이상의 클릭 타깃을 기준으로 하고, 모바일에는 더 넓게 제공한다.

### 6.1 Marker 렌더링 구현 규칙

```tsx
// 모든 마커의 SVG viewBox와 렌더링 크기는 동일하다.
// 화면 색은 status semantic token에만 의존한다.
function Marker({ favorite }: { favorite: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="question-marker" data-testid="question-marker"
      data-shape={favorite ? 'star' : 'square'} aria-hidden="true">
      {favorite ? (
        <path d="M12 2.5 15.1 8.5 21.6 9.45 16.8 14.1 17.95 20.65 12 17.5 6.05 20.65 7.2 14.1 2.4 9.45 8.9 8.5Z"
          fill="currentColor" stroke="currentColor" strokeWidth="1.1"
          strokeLinejoin="round" strokeLinecap="round" />
      ) : (
        <rect x="3" y="3" width="18" height="18" rx="4.5" fill="currentColor" />
      )}
    </svg>
  );
}
```

```css
.question-cell { width: var(--heatmap-cell); height: var(--heatmap-cell); display: grid; place-items: center; }
.question-marker { width: var(--heatmap-cell); height: var(--heatmap-cell); transition: transform 150ms ease-out; transform-origin: center; }
.question-cell:is(:hover, :focus-visible) .question-marker {
  transform: scale(var(--heatmap-marker-hover-scale));
}
@media (hover: none) { .question-cell:hover .question-marker { transform: none; } }
@media (prefers-reduced-motion: reduce) { .question-marker { transition: none; } }
```

- 실제 CSS에서 `.question-cell`의 배경색은 사용하지 않고, 부모가 상태 클래스/`data-status`를 통해 `color: var(--question-status-...)`를 지정한다. hover 확대가 이웃 marker를 가리지 않도록 충분한 그리드 간격과 stacking order를 검증한다.
- `:focus-visible`은 키보드 사용자에게 상태 확인과 outline을 함께 제공한다. mobile tap은 hover 팝오버 대신 곧바로 문제 풀이 패널로 이동한다.
- 별 형태의 꼭짓점을 더 둥글게 만들고 싶다면 path를 cubic quadratic rounded path로 대체할 수 있지만 시각 회귀 테스트의 기준 SVG를 반드시 갱신한다.

## 7. UI Component Inventory

### Foundation

`ThemeProvider`, `Tokens`, `Typography`, `Icon`, `FocusRing`, `Surface`, `GlassSurface`, `Divider`, `Button`, `IconButton`, `Badge`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `SegmentedControl`, `Tabs`, `Tooltip`, `Popover`, `Dropdown`, `Dropzone`, `Skeleton`, `ProgressBar`, `StepProgress`, `Toast`.

`ProgressBar` (v1.2.3, UX5-UI): 한 단계 작업(변형 생성·묶음 생성·등록·Fork)의 진행률은 모두 이 공통 컴포넌트다(여러 단계인 업로드·처리·가져오기는 아래 `StepProgress`, UX6-PROGRESS; `role="progressbar"`, 이름 필수, `value` 없음 = indeterminate로 `aria-valuenow` 없음). 값이 바뀌면 fill 폭이 `--duration-progress`(600ms) `--easing-standard`로 부드럽게 이어진다 — 서버가 보고하는 단계(예: 2→40→60→90%) 사이를 끊김 없이 잇기만 하고 보고되지 않은 진행률을 지어내지 않는다. `prefers-reduced-motion`에서는 transition 없이 바로 바뀐다. indeterminate는 fill이 아니라 막대 안을 천천히 지나는 반투명 줄(reduced motion에서는 멈춘 줄)이고 fill은 0%에 머문다 — 그래서 값이 생길 때(예: 준비 중 → 10%) fill이 앞으로만 움직인다(UX6-PROGRESS 2026-10-28; 이전 30% 고정 fill은 10%로 뒤로 갔다).

`StepProgress` (v1.2.4, UX6-PROGRESS 2026-10-28): 여러 단계를 차례로 거치는 작업(문서 업로드·처리 `업로드 → 분석 → 색인`, 문제 PDF 가져오기 `업로드 → PDF 분석 → 문제 추출`)의 진행 표시. 순서 목록(`<ol>`, 이름 "<label> 단계")의 각 단계는 완료(체크 아이콘)·진행 중(단계 번호, 굵은 글씨, `aria-current="step"`)·대기(단계 번호, 보조 텍스트 색)이고 상태를 시각적으로 숨긴 텍스트("완료"/"진행 중"/"대기")로도 읽어 색만으로 구분하지 않는다. 그 아래 하나의 `role="progressbar"`가 단계 수만큼 같은 폭의 칸으로 나뉜다: 완료 칸은 가득, 현재 칸은 그 단계의 진행률(`value`, 없으면 indeterminate 줄무늬), 대기 칸은 빈 칸. 결정: 단계마다 0→100%를 다시 채우는 막대 대신 칸으로 나눈 전체 막대를 쓴다 — 전체 막대는 뒤로 가지 않고(이전 피드백: "다 찼다가 줄어들었다"), 현재 단계의 진행도 그 칸에서 그대로 보인다. `aria-valuenow`는 전체 진행률((완료 단계 수 + 현재 단계 비율) / 단계 수), `aria-valuetext`는 "2/3단계: 분석 중, 30%". 칸 fill은 `transform: scaleX`를 `--duration-progress` `--easing-standard`로 전환하고 `prefers-reduced-motion`에서는 전환·줄무늬 움직임이 없다. 단계가 하나뿐인 작업(Fork·변형 생성·묶음 생성·등록)은 `ProgressBar`를 그대로 쓴다.

`Toast` (v1.2.6, UX7-SHARE-EXPIRY 2026-11-01): glass 표면 + 제목/설명 + 닫기 버튼. 왼쪽 accent 테두리(UX1의 3px 색 bar)는 없앴다 — "선택 표시 bar 없음"(§4.1)과 같은 이유로 색 bar로 상태를 전하지 않는다. 종류는 색이 아니라 맨 앞 아이콘과 숨김 텍스트로 구분한다: `success` 체크 아이콘(`--color-success`) + "성공", `error` 경고 아이콘(`--color-danger`) + "오류", `neutral` 아이콘 없음. 숨김 텍스트는 제목 앞에 붙어 함께 읽힌다(`role="status"`/assertive 안내 그대로).

`CopyButton` (v1.2.6, UX7-SHARE-EXPIRY): 클립보드 복사 버튼의 공통 패턴. `onCopy`가 성공하면 버튼 안 복사 아이콘이 체크 아이콘으로, 이름이 `copiedLabel`(기본 "복사 완료", UX7-COPY-LABEL 사용자 결정 2026-11-02)로 바뀌고, 버튼 안의 시각적으로 숨긴 polite live region이 `announcement`를 한 번 알린다(성공 toast를 따로 띄우지 않아 두 번 읽히지 않음). 약 2초(`COPY_FEEDBACK_MS`) 뒤 돌아온다. 두 이름·두 아이콘을 같은 grid 칸에 겹쳐 두고 보이지 않는 쪽은 `visibility: hidden`이라 바뀌어도 버튼 크기·위치가 변하지 않는다. 교체는 애니메이션 없이 즉시다. 실패(`onCopy`가 reject 또는 `false`)하면 체크를 표시하지 않고 오류 안내는 호출한 화면이 한다(링크 공유: 링크 칸 선택 + 오류 toast). 사용처: 링크 공유 dialog의 `링크 복사`(WS-SHARE-01-AC08). DOC-02 `전체 복사`는 버튼이 아니라 메뉴 항목이라 기존 상태 문구("복사했습니다")를 유지한다.

`Dropzone` (v1.2.2, UX3b): 파일을 끌어다 놓는 영역. 2px 점선 `--color-border-strong` 테두리, drag-over(`data-dragging`)는 실선 accent 테두리 + `--color-state-selected` 배경 + accent 아이콘(테두리 모양도 바뀌어 색만으로 구분하지 않음). 끌어다 놓기와 별개로 항상 실제 "파일 선택" 버튼(키보드·터치·스크린 리더 경로, 설명 문구는 `aria-describedby`)을 둔다. `accept`·`multiple`·`disabled`를 받고, 선택·드롭한 파일은 `onFiles`, `accept`에 맞지 않는 드롭은 `onReject`로 전달한다.

### Layout

`AppShell`(UX3c: Workspace 화면은 sidebar 없이 header만), `WorkspaceSwitcher`, `SidebarNav`, `PageHeader`, `Breadcrumb`, `BackLink`, `ContentContainer`, `SplitView`, `FloatingSidePanel`, `ModalDialog`, `EmptyState`, `StatusSummary`.

`SplitView` (v1.2.7, DOCVIEW-SPEC 2026-10-29 · DOCVIEW-PORT 2026-11-02; 첫 사용 DOCVIEW-01): 두 pane과 그 사이 크기 조절 막대. props: `orientation`(`horizontal` = 좌우, `vertical` = 상하), `ratio`(앞 pane %, 제어형)·`onRatioChange`(끄는 동안)·`onRatioCommit`(놓을 때·키 입력 때), `minRatio`(기본 20)·`minSize`(px, 축별), `defaultRatio`(Enter·더블클릭 reset, 기본 50), `visible`(`both` · `first` · `second`: 한쪽만 보일 때 다른 pane은 unmount하지 않고 `hidden`, 막대도 숨김), `separatorLabel`, `valueText(ratio)`. 막대는 `role="separator"`·focus 가능·`aria-orientation`(좌우 분할 = `vertical`)·`aria-valuenow/min/max/text`·`aria-controls`(앞 pane); 키보드는 분할 축 화살표 ±5, Home/End = 최소/최대, Enter = reset, 반대 축 화살표 무시. Pointer Events(mouse·touch·pen, `touch-action: none`, pointer capture), 끄는 동안 text 선택 막음. 시각 선 1px `--color-border`, hit 영역 ≥ 24px(coarse pointer 44px), hover·focus-visible·drag 중 굵기·grip으로 강조(색만이 아님), 상태 전환 `--duration-state`·reduced-motion 즉시. 컨테이너가 두 최소 크기 합보다 작으면 50:50 고정(min = max = 50). pane wrapper는 child의 `key`로 keyed라 호출자가 children 순서를 바꾸면(위치 바꾸기) pane이 다시 mount되지 않고 DOM만 옮겨진다; pane header 끌기는 화면 쪽 구현이다. 인벤토리의 `ResizablePanel`은 `SplitView`로 대신한다(별도 컴포넌트 두지 않음; DOC-02 v1.4의 화면 전용 `PaneSplitter`도 DOCVIEW-PORT에서 없앰). Storybook: 좌우·상하, 최소 크기, 키보드, 좁은 컨테이너, 한쪽만 보기.

Workspace 홈(UX3c, 2026-10-20): Workspace 안에는 sidebar가 없다. 홈의 Workspace header(통합 검색 + `문서 n`·`문제`(DropdownMenu: 직접 추가·변형 출제 — `PDF 관리`와 문제 PDF 관리 dialog는 UX7-DOCS에서 문서 관리로 통합; UX6-PROGRESS~UX6-BANK의 `전체 문제` 항목은 그 페이지(QBANK-01)와 함께 UX7-BANK에서 없어졌고, `직접 추가`는 홈 위에 modal "문제 등록" dialog를 연다) 묶음과 오른쪽 정렬된 `이력`·`공유하기` secondary `IconButton` 묶음, UX4)가 진입점이며, 문서 관리·문제 생성·이력·링크 공유는 모두 non-modal `FloatingSidePanel`(§5.1 stacking: 나중에 연 것이 위, 열린 dialog의 버튼을 다시 누르면 `raiseKey`로 다시 위로)로 홈의 `<main>` 안에 portal하고, 데스크톱에서는 dialog가 열린 동안 홈 내용이 dialog 폭만큼 비켜선다. 홈과 dialog에는 `PageHeader` 제목·설명이 없고 `h1`은 시각적으로 숨긴다. 통합 검색 옵션은 "검색 옵션" 텍스트 버튼이 여는 `Popover`다. 새 icon: `SearchIcon`, `TrashIcon`, `HistoryIcon`, `ChevronUpIcon`, `ShareIcon`.

`Breadcrumb`·`BackLink` (v1.2.2, UX3b): 버튼으로 이동한 페이지는 `PageHeader`의 `back` 슬롯에 뒤로가기(`BackLink`: 화살표 + label, `href`가 있으면 링크, 없으면 `onClick`으로 되돌아가는 버튼, `hideLabel`이면 label은 접근 가능한 이름으로만 남음), `breadcrumb` 슬롯에 위치(`Breadcrumb`: `<nav aria-label="위치">` + `<ol>`, 장식용 chevron 구분자, 마지막 항목은 현재 페이지로 링크가 아니며 `aria-current="page"` + 굵기)를 둔다. Next.js에서는 `linkComponent={Link}`를 넘긴다. 링크 hit 영역은 24px 이상이다. 뒤로가기·breadcrumb 줄 아래는 제목과 12px 띄운다(줄 간격 `--space-1` + 아래 여백 `--space-2`, v1.2.3 UX5-UI).

### Domain components

`AuthLayout`, `SignInForm`, `SignUpForm`, `PasswordResetForm`, `VerificationNotice`, `SessionExpiredDialog`, `DocumentOutlineTree`, `PdfViewer`, `TextBlockEditor`, `SearchResultList`, `SearchExcerpt`, `QuestionMarker`, `QuestionDot`, `QuestionHeatmap`, `HeatmapLegend`, `QuestionPreviewPopover`, `QuestionPracticePanel`(→ `QuestionViewer` `practice` 방식, MOCK-SPEC), `QuestionViewer`, `QuestionRangePicker`, `QuestionOptionList`, `QuestionAnswerField`, `FavoriteToggle`, `RetryToggle`, `QuestionGenerationForm`, `VariationDiffViewer`, `QuestionDraftReview`, `ImportJobProgress`.

## 8. 컴포넌트 상태·문서화 규칙

각 컴포넌트 Storybook 문서에 다음을 포함한다.

- 목적, props, accessibility/keyboard behavior, token dependency.
- `default`, `hover`, `focus`, `active`, `disabled`, `loading`, `error`, `empty` 중 해당되는 상태.
- 라이트/다크 및 desktop/tablet/mobile 사례.
- `QuestionDot`: 다섯 가지 상태 × favorite(square/star) × hover/focus/selected on/off. 별 shape는 시각적 회귀 검증 대상.
- `FloatingSidePanel`: modal/non-modal, close/backdrop behavior, focus return, viewport overflow.
- 잘못된 사용 예: 상태 hex 하드코딩, 모든 surface에 backdrop blur, color-only status 전달, panel 아래 숨은 콘텐츠 접근 불가.
- 시각적 변경은 token version과 스크린샷 회귀 테스트를 통해 검증.

## 9. 문서 트리와 관리 규칙

```text
docs/
  architecture.md          # 시스템/모듈/DB/API/로드맵
  questions.md             # 학습 상태/변형 문제/heatmap/수용 기준
  design-system.md         # 디자인 원칙/토큰/레이아웃/상호작용/접근성
  auth.md                  # 인증 화면 및 JWT 인가
  deployment.md            # Supabase/Worker/CI/CD/운영
  e2e-strategy.md          # 화면명세·E2E traceability
  screens/                 # 화면별 요구사항 (Spec-first)

packages/
  design-tokens/
    tokens.json            # 단일 소스
    build-tokens.ts        # css/ts 생성
  ui/
    src/primitives/
    src/layout/
    src/feedback/
    src/questions/
    .storybook/
```

**Governance:** component 추가 전 기존 primitive/pattern 재사용 여부 검토 → semantic token 정의 → Storybook/예제 작성 → 시각 회귀 및 접근성 확인 → export. UI에 직접 raw color/spacing 값이 확산되지 않도록 lint와 코드 리뷰 규칙을 둔다.

## 10. 검수 체크리스트

- [ ] 모든 status color는 토큰으로만 지정
- [ ] favorite의 square→rounded-star 변경과 hover/focus scale 시에도 셀 충돌·grid 이동 없음
- [ ] 상태 필터 텍스트·tooltip·aria-label로 상태 정보 제공
- [ ] hover가 없는 touch 인터페이스에서 동일 기능 접근 가능
- [ ] 모달 focus trap 및 닫힌 뒤 focus 원위치 복구
- [ ] light/dark contrast, forced-colors, reduced-motion 확인
- [ ] CSS blur 미지원 시 불투명한 fallback surface 유지
- [ ] PDF 읽기 영역을 glass blur로 가리지 않음
- [ ] Storybook 상태 예제와 스크린샷 회귀 테스트 포함
- [ ] pointer target WCAG 2.2 최소 기준 확인


## Workspace 공유·Fork 화면 컴포넌트 (v1.3 추가)
- `WorkspaceSharingPanel`: owner 공유 링크 생성/철회/재발급, 만료일, Fork 허용 스위치. Floating Side Panel 적용.
- `SharedWorkspaceView`: read-only watermark가 아니라 명확한 '읽기 전용' 상태, 문서·검색·문제 조회. 수정/풀이 저장 CTA는 숨기고 API도 차단한다.
- `ForkWorkspaceDialog`: 로그인 필요, Fork 허용 상태, 복제 범위, 개인정보 미복제 안내, 새 Workspace 이름 및 작업 상태.
- 공유 토큰은 toast·clipboard 성공 문구 이외의 접근성/분석 로그에 포함하지 않는다. 보안 에러는 링크 접근 불가로 간결하게 표현한다.
- 기존 Question Heatmap 규칙 유지: 일반 문제는 상태 색상의 rounded-square, 즐겨찾기는 동일 색상의 rounded-star, hover/focus 시 transform scale 확대, grid reflow 없음.

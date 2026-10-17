# Design System v1.1 — Minimal Glass (Platform v1.2)

**상태:** 디자인 시스템 초기 명세 확정 · 2026-10-16  
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
| `--color-text-secondary` | `#667085` | 보조 텍스트 |
| `--color-border` | `#DEE3EB` | 표면·필드 경계 |
| `--color-accent` | `#5268D8` | primary action, navigation |
| `--color-focus` | `#356CFF` | focus outline |
| `--color-glass` | `rgba(255,255,255,.78)` | floating glass surface |
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

**v1.1.1 추가:** `--color-border-strong`, `--color-on-accent`, `--color-danger`/`success`/`warning`, `--color-scrim`, typography scale(`--font-size-*`, `--line-height-*`, `--font-weight-*`), breakpoint(`--breakpoint-*`). feedback 색은 question-status 토큰을 재사용하지 않으며(의미가 다름), canvas·surface 위 텍스트로 4.5:1 이상을 만족한다.

**상태 점은 기본 표면과 충분히 구분되도록** 최소 얇은 outline과 범례를 갖는다. 작고 색만 있는 점으로 WCAG 텍스트 대비를 충족하는 것으로 오해하지 않는다. 색 외 상태 설명을 tooltip, 텍스트 요약, screen reader label로 제공한다.

### 3.2 Dark theme (초안)

```css
[data-theme="dark"] {
  --color-canvas: #11151D;
  --color-surface: #1B222D;
  --color-surface-muted: #27313E;
  --color-text-primary: #F2F5F9;
  --color-text-secondary: #ACB7C5;
  --color-border: #364251;
  --color-accent: #8CA0FF;
  --color-focus: #A2B3FF;
  --color-glass: rgba(27, 34, 45, 0.79);
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
  --color-text-secondary: #667085;
  --color-border: #DEE3EB;
  --color-accent: #5268D8;
  --color-focus: #356CFF;
  --color-glass: rgba(255,255,255,.78);
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

  --app-header-height: 64px;
  --app-sidebar-width: 232px;
  --content-max-width: 1440px;
  --breakpoint-md: 768px;
  --breakpoint-lg: 1024px;
  --floating-panel-width: 500px;
  --heatmap-cell: 28px;
  --heatmap-gap: 4px;
  --heatmap-dot: 16px;
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
  .glass-surface { background: var(--color-surface); }
}
@media (prefers-reduced-transparency: reduce) {
  .glass-surface { background: var(--color-surface); backdrop-filter: none; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
```

## 4. Typography / Layout / Elevation

| 분류 | 권장 |
|---|---|
| Body | 14–16px; 긴 본문은 16px/1.6 이상 |
| Label | 12–13px, secondary text |
| Page title | 24–28px/1.2, 굵기 600 |
| Section title | 16–18px, 굵기 600 |
| Typography token | label `--font-size-label-sm`(12)/`--font-size-label`(13), body `--font-size-body`(14)/`--font-size-body-lg`(16, 긴 본문은 `--line-height-relaxed` 1.6), section `--font-size-section-title`(18), page title `--font-size-page-title`(26)/`--line-height-tight`, 굵기 `--font-weight-semibold`(600) |
| Breakpoint | mobile `< 768px`(`--breakpoint-md`), tablet 768–1023px, desktop `≥ 1024px`(`--breakpoint-lg`, sidebar 표시). CSS 변수는 media query 안에서 쓸 수 없으므로 media query는 같은 px 값을 range 문법(`(width >= 768px)`)으로 쓰고, `packages/ui` 테스트가 토큰 값과 일치하는지 검사한다. TS는 `@quiz/design-tokens`의 `breakpoints`/`mediaQueries`를 사용한다 |
| Global header | 64px 높이 |
| Left navigation | 232px 고정(데스크톱), 모바일 drawer |
| Content area | max-width 1440px, padding 24px(데스크톱) / 16px(모바일) |
| Border radius | 기본 10px, 떠 있는 패널 16–20px |
| Layering | 기본 카드 0–1, popover 20, side panel 40, modal 60, toast 70 |
| Animation | panel enter/exit 약 180–240ms, transform+opacity, reduced-motion 대응 |

Panel이 떠 있어도 본문을 읽기 쉬워야 하므로 배경 glass 효과를 과용하지 않는다. 기본 표면은 opaque white/dark surface다.

## 5. Floating Side Panel

### 5.1 공통 패턴

- Desktop right panel: width `min(500px, calc(100vw - 32px))`, top/right/bottom margin `16px`, rounded `20px`, glass surface, shadow, viewport 내부 독립 scroll.
- `QuestionPracticePanel`: **modal** 기본. 정답을 제출하거나 뒤로/다음 이동하는 명확한 흐름. backdrop 클릭/ESC 처리 정책 정의, 닫을 때 trigger dot로 focus 복귀.
- `DocumentExcerptPanel`: **non-modal** 기본. PDF·검색 결과와 동시에 볼 수 있음.
- `QuestionGenerationReviewPanel`: 충분한 공간이 필요하므로 desktop에서는 600px 이상 비교 drawer 또는 전체 page 모드 제공(500px 강제 금지).
- Mobile: full width bottom sheet 또는 full-height panel, safe-area inset, `max-height: 90dvh`; 화면이 좁다면 문제 상세 전체 페이지로 전환 가능.
- URL query: `?question=<id>` 또는 `?panel=...`로 열림 상태/딥링크 복원. 뒤로가기와 동기화.
- Panel Header: title / breadcrumb / action icons(즐겨찾기·다시 풀기) / close.
- Panel Footer: submit, self-grade, next/previous, loading/error 상태.
- Modal focus trap, title/description, Escape and focus restore는 Radix 기반으로 구성. Non-modal은 배경과 panel 간 키보드 이동을 허용.

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
- 셀 `28×28px`, 기본·favorite marker visual bound `16×16px`. 셀 간 gap `4px`; 모바일 최소 `32px`. favorite는 **크기 확대가 아니라 사각형→별 모양 전환**이다. hover 및 `:focus-visible` 시 marker만 `scale(var(--heatmap-marker-hover-scale))`; transition은 transform 150ms, reduced-motion시 즉시 변경한다.
- favorite는 별 silhouette로 표시하며 상세 텍스트에서도 별 아이콘을 제공. hover/focus scale을 적용해도 고정 셀과 grid 위치는 바꾸지 않는다.
- 선택된 dot는 focus ring/outline으로 강조하고 상태 색은 그대로 유지.
- 점은 `<button>`으로 구현하고 label에 챕터·번호·유형·상태·favorite·retry를 포함.
- roving tabindex 또는 명확한 Tab/Arrow navigation을 제공하여 수백 개의 버튼이 키보드 사용자에게 부담이 되지 않게 한다.
- hover/focus에는 Tooltip/Popover로 preview, click/Enter/Space에는 Floating Question Panel.
- 상태별 텍스트 요약과 legend를 상시 제공하여 색맹 등 색상 인지가 어려운 사용자도 구별 가능해야 한다.
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
.question-marker { width: var(--heatmap-dot); height: var(--heatmap-dot); transition: transform 150ms ease-out; transform-origin: center; }
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

`ThemeProvider`, `Tokens`, `Typography`, `Icon`, `FocusRing`, `Surface`, `GlassSurface`, `Divider`, `Button`, `IconButton`, `Badge`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `SegmentedControl`, `Tabs`, `Tooltip`, `Popover`, `Dropdown`, `Skeleton`, `Toast`.

### Layout

`AppShell`, `WorkspaceSwitcher`, `SidebarNav`, `PageHeader`, `ContentContainer`, `SplitView`, `ResizablePanel`, `FloatingSidePanel`, `ModalDialog`, `EmptyState`, `StatusSummary`.

### Domain components

`AuthLayout`, `SignInForm`, `SignUpForm`, `PasswordResetForm`, `VerificationNotice`, `SessionExpiredDialog`, `DocumentOutlineTree`, `PdfViewer`, `TextBlockEditor`, `SearchResultList`, `SearchExcerpt`, `QuestionMarker`, `QuestionDot`, `QuestionHeatmap`, `HeatmapLegend`, `QuestionPreviewPopover`, `QuestionPracticePanel`, `QuestionOptionList`, `QuestionAnswerField`, `FavoriteToggle`, `RetryToggle`, `QuestionGenerationForm`, `VariationDiffViewer`, `QuestionDraftReview`, `ImportJobProgress`.

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
- [ ] 색상 범례·tooltip·aria-label로 상태 정보 제공
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

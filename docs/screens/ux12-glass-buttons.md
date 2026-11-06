# UX12-GLASSBTN — 실제 blur, 더 투명한 glass, 유리 위 버튼

**E2E:** `tests/e2e/quality/ux12-glass-buttons.spec.ts`

**Phase:** `UX12-GLASS2.0`

**상태:** UX12 DESIGN-5 신규 2026-11-06 (사용자 피드백 "투명도가 너무 낮음", "보던 문제로 돌아가기, 각 목록 항목의 배경 제거", "회색을 흰색으로", "아이콘 버튼 테두리 제거", "모든 버튼에 hover 색", "cell hover 확대", "global header gradation 제거", 하단 고정 영역·홈 sticky 영역·ConfirmDialog 구분선 추가 요청). **결정:** D-1, D-12. **연계:** [디자인 시스템](../design-system.md) §1·§3·§4·§4.1, [UX12-GLASS](ux12-glass.md), [UX12-CONTROLS](ux12-controls.md), [UX12 계획](../implementation/ux12/index.md) §4.1a.

## 원인 — Chromium에서 blur가 없던 이유

`backdrop-filter` 뒤에 `-webkit-backdrop-filter`를 쓰면 Next의 CSS minifier(Lightning CSS)가 값에 `var()`가 있을 때 둘을 한 속성으로 보고 마지막만 남긴다. 그래서 배포 CSS에는 `-webkit-backdrop-filter`만 있었고 Chromium은 이것을 읽지 않는다. 부모의 `filter`·`transform`·`overflow`나 다른 규칙의 덮어쓰기가 아니다. **규칙:** 두 선언은 언제나 `-webkit-`을 먼저 쓴다. `none`으로 끄는 선언도 같다. `packages/design-tokens/test/base-css.test.ts`가 저장소의 CSS를 검사한다.

## 규칙

- **표면:** `--color-glass` alpha는 light `.7`, dark `.65`, `--glass-gradient` alpha는 light `.2`, dark `.05`, `--glass-blur`는 24px이다. 새 테마별 값 `--glass-brightness`(light 1.3, dark .7)가 blur한 배경을 표면 쪽 밝기로 밀어 글자 대비를 지킨다.
- **Fallback:** reduced transparency·blur 미지원·모바일 sheet·full-screen paired dialog·태블릿 PDF 위 목차는 지금처럼 불투명 `--color-glass-solid`이고 blur가 없다.
- **PDF 위:** PDF viewer가 화면에 있는 동안 모든 `glass-surface`는 gradient와 blur 없는 `--color-glass-solid`다. DOC-02 데스크톱의 side panel은 목차(inset, PDF를 덮지 않음)뿐이지만, 복귀 bar(`--z-side-panel` - 1, viewer는 `--z-popover`)·메뉴·toast는 PDF 위에 뜬다. `PdfPageDialog`와 `원본 비교`처럼 panel 안에 PDF가 있어도 같다. 옆의 풀이 panel도 그동안 단색이다.
- **유리 안 토큰:** `.glass-surface` 안에서 `--color-surface-muted`는 `--color-surface-raised`(light 흰색, dark `#27313E`)로, `--color-accent`는 `--color-accent-on-glass`로 바뀐다. 회색 영역을 기능별로 고치지 않고 한 줄로 흰색이 된다. primary hover는 `--color-accent-pressed`로 한 단계 내려간다.
- **유리 위 버튼:** secondary 버튼은 채움이 없고 경계는 유지한다. hover·pressed는 그대로 채운다. 목록 항목(AI 질문 출처·각주, 모의고사 목록·문제 행)도 채움이 없다. 입력·primary·toggle은 그대로다. 비활성 입력은 채움이 없다.
- **하단·상단 고정 영역:** panel `.footer`와 `.pinned`, 풀이 footer에는 채움이 없다. body는 footer 뒤로 지나가지 않고 위에서 잘리므로(같은 flex column) hairline 구분선만 남긴다. AI 질문 composer는 `glass-surface`다. 뒤로 메시지가 지나가므로 blur가 글자를 지운다.
- **아이콘 전용 버튼:** 모든 variant가 테두리를 투명하게 한다(toggle 제외). 크기는 그대로다.
- **Hover:** `cursor: pointer`인 모든 버튼·버튼처럼 쓰는 링크는 `@media (hover: hover)`에서 색이 바뀐다. 터치에서 hover가 남지 않는다. 텍스트 링크는 `--color-accent-hover`, 나머지는 `--color-state-hover`다. `packages/ui/test/button-hover.test.ts`가 검사한다.
- **Header:** global header는 `glass-surface`이고 gradient 층만 없다.
- **홈 sticky 영역:** sticky인 것은 global header와 홈 toolbar(`문서`·`모의고사`·`AI 질문`·`이력`·`공유하기`)다. Heatmap 챕터 머리글은 sticky가 아니다. toolbar는 canvas 색조의 glass라 내용이 지나갈 때만 보이고, 버튼 모양은 그대로이며, fallback에서는 불투명 canvas다.
- **ConfirmDialog:** 머리글과 동작 행 사이의 구분선이 없다. `ModalDialog`와 panel의 구분선은 그대로다.
- **Heatmap:** `--heatmap-marker-hover-scale`은 D-12로 이미 1.3이다. hover·focus-visible만 확대하고 격자는 움직이지 않으며 잘리지 않는다.

## 유리 위 버튼·영역 목록

| 대상 | 표면 | 분류 | 처리 |
|---|---|---|---|
| `보던 문제로 돌아가기` | 복귀 bar | 배경 제거 | secondary 규칙 |
| panel·dialog footer의 secondary 버튼 | side panel, toast | 배경 제거 | secondary 규칙 |
| AI 질문 출처 버튼, 각주 | side panel | 배경 제거 | `ask.module.css` |
| 모의고사 목록 항목, 문제 행 | side panel | 배경 제거 | `mock-exams.module.css` |
| 비활성 입력 | side panel | 배경 제거 | 입력 규칙 |
| 메뉴·select 항목, 닫기(X) | menu, popover, panel | 원래 배경 없음 | 없음 |
| panel `.footer`, `.pinned`, 풀이 footer, panel 머리글 | side panel | 원래 채움 없음 | hairline 유지 |
| 해설(`.reveal`), 풀이 안내, 지문·보기 묶음, 첨부 chip, 공유 링크 발급 결과, 요약 오래됨 안내, 표 머리글 | side panel | 회색→흰색 | `--color-surface-muted` 재지정 |
| 오류 안내(`.alert`), 요약 챕터, 접기 영역, 그림 | side panel | 원래 흰색, 유지 | 없음(dark는 `--color-surface`) |
| 입력, 라디오, 체크박스 | side panel | 유지 | 없음 |
| primary 버튼 | 모든 표면 | 유지 | 없음 |
| toggle | 모든 표면 | 유지 | 없음 |
| 선택된 사용자 말풍선, 선택된 chip | side panel | 유지 | 없음 |
| AI 질문 composer | side panel 안 floating | 흰색→glass | `glass-surface` |
| global header | sticky | gradient 제거, glass 유지 | `layout.css` |
| 홈 toolbar | sticky | 불투명→glass | canvas 색조, 버튼 유지 |

## 대비

Chromium에서 실제 토큰과 Lightning CSS를 거친 CSS로 그린 표면의 픽셀을 쟀다. 배경은 빽빽한 Heatmap 색, primary 버튼, 굵은 글자다. 표는 가장 나쁜 픽셀 기준이다.

| 표면 | primary | secondary | accent(유리) | danger | success | warning |
|---|---|---|---|---|---|---|
| light panel | 14.27 | 4.84 | 5.03 | 5.03 | 4.69 | 4.82 |
| light header(gradient 없음) | 14.15 | 4.80 | 4.99 | 4.99 | 4.65 | 4.78 |
| dark panel | 10.74 | 5.78 | 4.80 | 4.65 | 5.45 | 8.12 |
| dark header(gradient 없음) | 11.79 | 6.34 | 5.27 | 5.11 | 5.98 | 8.91 |

**한계:** 패널 뒤에 큰 단색 면(360×200px의 text-primary 색 면)이 있으면 그 자리의 작은 색 글자는 4.5:1 아래로 떨어진다(light secondary 3.20, dark secondary 3.45). 본문 글자(primary)는 light 9.44, dark 6.41을 유지하고, 순흑·순백 배경에서도 4.5:1 이상이다.

## 수용 기준

### UX12-GLASSBTN-AC01
**실제 blur:** 넓은 화면의 top bar, menu, side panel은 light와 dark에서 `blur(24px)`가 계산값으로 적용되고 배경색이 반투명하다(light alpha .7, dark .65). top bar에는 gradient 층이 없고 menu와 side panel에는 있다.

### UX12-GLASSBTN-AC02
**불투명 fallback:** 폭 390px의 side panel은 불투명하고 blur가 없다.

### UX12-GLASSBTN-AC03
**유리 위 버튼:** 복귀 bar의 `보던 문제로 돌아가기`와 panel footer의 secondary 버튼은 기본 상태에 채움이 없고 테두리가 보이며, pointer를 올리면 `--color-state-hover` 배경이 생긴다. panel footer에도 채움이 없다.

### UX12-GLASSBTN-AC04
**흰색 영역:** panel의 해설 영역은 `--color-surface-raised` 배경이다. 같은 토큰이 light에서 흰색이고, dark에서는 glass보다 밝은 표면이다.

### UX12-GLASSBTN-AC05
**아이콘 전용 버튼:** 홈의 secondary 아이콘 버튼(`이력`)은 테두리가 투명한 1px이고 크기는 36px을 유지한다. 즐겨찾기 같은 toggle은 테두리가 보인다.

### UX12-GLASSBTN-AC06
**Heatmap 확대:** cell에 pointer를 올리면 marker가 1.3배가 되고 cell 위치는 변하지 않는다. 부모가 marker를 자르지 않는다.

### UX12-GLASSBTN-AC07
**홈 sticky 영역:** 홈 toolbar는 sticky이고 blur가 적용되며 배경이 반투명하다.

### UX12-GLASSBTN-AC08
**ConfirmDialog 구분선 없음:** 확인 dialog의 머리글과 동작 행에는 구분선이 없고, 동작 행 위아래 간격은 유지된다.

### UX12-GLASSBTN-AC09
**Composer:** AI 질문 composer는 glass 표면이고 blur가 적용된다.

### UX12-GLASSBTN-AC10
**PDF 위 glass 없음:** PDF가 보이는 문서 화면에서 메뉴는 불투명 단색이고 gradient와 blur가 없다.

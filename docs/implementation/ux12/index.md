# UX12 — 피드백 TODO 정리·실행 계획

상태: 구현 진행 중 · 2026-11-06 · 기준 커밋 `develop` e39b5533. 대상은 사용자가 2026-11-06에 넘긴 TODO 목록 전체다. 완료 판정은 체크 표시가 아니라 `develop`의 코드로 했다. 대부분 정적 코드 읽기 결과이며, 브라우저에서 재현하지 않은 항목은 표에 표시했다.

**요약**

| 구분 | 항목 수 |
|---|---:|
| 전체 항목 | 96 |
| 완료(제외) | 21 |
| 남은 작업(부분 완료 포함) | 75 |
| 큰 Task(Epic) | 12 |
| 구현 Task | 48 |

## 1. 실행 규칙

- **역할:** main thread는 코드를 쓰지 않는다. Task 선택, brief 작성, 결과 검수, 재검증, 통합, Codex 리뷰 게이트, 진행 현황 갱신만 맡는다.
- **구현 subagent:** Task마다 **Opus 5.5 subagent 1개**(`model: "opus"`, `effort` 생략 = default)를 배정한다. 이 프로젝트의 UX12 작업에 적용하며 기존 "구현은 Sonnet" 규칙보다 우선한다. 리뷰 수정도 같은 모델로 한다.
- **Task 수명주기:** AGENTS.md §3을 따른다. 명세 수정 → 해당 Task 직전에 RED → GREEN → 커밋 → Codex 리뷰(`HERDR_ENV=0`, 불가 시 Opus 리뷰 subagent) → main thread 재검증·merge.
- **브랜치:** Epic 묶음마다 `feature/ux12-<topic>`, Task마다 `task/UX12-<ID>-<slug>`. 파일 범위가 겹치지 않는 Task만 병렬로, 각자 worktree에서 실행한다.
- **점검(사용자 지시 2026-11-06, 개정):** Task가 끝나면 구현 subagent가 로컬에서 `make lint`, `make typecheck`, unit test만 돌린다. E2E와 visual은 자기 Task의 새 test만 RED → GREEN으로 확인하고, 전체 실행은 PR CI가 맡는다. PR에서 실패하면 해당 Task의 구현 subagent가 고친다.
- **Wave PR(사용자 지시 2026-11-06):** 앞 Wave PR이 없으면 Wave PR을 바로 올린다. 앞 Wave가 대기 중이면 통합 브랜치에 모으고, 앞 PR이 `develop`에 병합되면 통합 브랜치를 PR 하나로 올린다. 그다음 Wave는 새 통합 브랜치에 모으거나 바로 Wave PR이 되며, 이를 반복한다. `feature/ux12-integration`은 PR #81로 올렸고, 이후 Task는 `feature/ux12-next`에 모은다.
- **AC 등록:** 새 AC는 `docs/screens/ux12-*.md`와 새 phase(`UX12-<EPIC>.0`)에 둔다. 이미 GREEN인 phase에 새 AC를 넣지 않는다(§7 UX9-SPEC 해석).
- **Visual baseline:** Task마다 재생성하지 않는다. 묶음의 마지막 QA Task에서 고정 Linux Playwright 이미지로 한 번만 재생성한다. 테두리·glass 변경은 baseline 170장 대부분을 바꾼다.
- **Migration:** timestamp는 production 적용분(`20261106110000`) 뒤여야 한다. 공유 DB 적용은 main thread만 한다.
- **실제 PDF:** 저장소 루트의 시험지·교재 PDF는 저작권 자료다. 분석은 메모리 안에서 구조 수치만 보고, fixture에는 넣지 않는다.

## 2. 완료 항목 필터링

**제외한 항목 (21개)**

| 원문 항목 | 체크 | 근거 |
|---|---|---|
| Heatmap 보기 섞기 설정/고정 | ☑ | `shuffle_options` 기본 false, web이 보내지 않음(UX10-QVIEW-AC01) |
| 이미 푼 문제 해설 다시 보기 | ☑ | UX10-QVIEW-AC03 |
| 색상 palette 재조정 | ☑ | `tokens.json` question-status, marker stroke 없음 |
| 챕터별 문제 수의 '문제' 삭제 | ☐ | 화면에는 숫자만, `aria-label`만 "n문제" 유지(UX10-HOME-AC05) |
| cell hover 시 크기 확대 | ☐ | `scale(var(--heatmap-marker-hover-scale))`. 배율 조정 여부는 D-12 |
| 상태 필터 접기/펼치기 삭제 | ☑ | UX10-HOME-AC02. 주석·QOV-01-AC08 문구만 낡음 |
| 본문 검색 | ☐ | SEARCH-02 페이지 존재. 원문에 세부 내용이 없어 추가 작업 없음으로 처리 |
| notes | ☐ | CHNOTE-01·02, HILITE-01 출시, 미완 표시 없음. 원문에 세부 내용 없음 |
| (가)(나)(다) 리스트 표시 | ☑ | STEM-ITEMS, UX11-STEM |
| pdf에서 보기 패널 위치 | ☑ | QSRC paired panel. 본문 발췌의 `PDF에서 보기`는 D-13 |
| `AI 해설` 버튼 문구 | ☑ | `lib/ai-explanations/model.ts` |
| AI 해설 버튼·내용 영역 분리 | ☑ | `ai-explanation.tsx` |
| 모의고사 진행 막대 구분 | ☐ | 선택 단계는 단계 목록, 생성 중만 ProgressBar |
| 아무것도 선택 안 해도 전체 범위 | ☐ | `shuffleOnly = !ai` |
| 문항 수·난이도 폭 맞춤, 모바일 1열 | ☐ | `.formRow`. 기하 검증 test만 없음 → PLAY-1 |
| 다음 버튼 최하단 | ☐ | sticky footer, 짧은 화면 fixed |
| 문제 풀기에 변형 유형·문항 수·난이도 | ☐ | 통합 풀기 폼 |
| 이름 변경 저장/취소 배치, 풀기 disabled | ☐ | `rename-field.tsx` |
| 문서보기 원본 기본 | ☐ | UX10-DOC-AC01 |
| 원본·변환본 checkbox | ☐ | UX10-DOC |
| 문서보기 전체 높이 | ☐ | UX10-DOC-AC03 |

**체크되어 있지만 덜 끝난 항목 (3개, 작업으로 넘김)**

| 항목 | 남은 것 |
|---|---|
| AI 해설 보기 옆에 AI 질문하기 | 해설이 있으면 `AI 해설 보기`가 toolbar 아래 영역에 있어 나란히 있지 않다 |
| AI 해설 접기/펼치기를 관련 본문과 같은 디자인으로 | 기본 펼침은 됐고, 모양은 여전히 ghost 버튼이다 |
| 챕터 계층별로 | 문서 목차와 재분배 대상만 계층이다. Heatmap·범위 선택·홈 필터·`문제 편집`은 평면이다(D-9) |

**다른 브랜치 확인:** `feature/qparse-fix`, `feature/import-refine-parallel`, `feature/chap-match`의 작업은 다른 커밋으로 `develop`에 들어와 있다. `feature/errata`는 미병합이지만 이 목록과 무관하다. `task/HOMEDROP.0-red`는 미병합 RED이며 홈 header fixture와 충돌할 수 있다.

## 3. 카테고리 계층

"dnd"는 편집과 챕터에, "업로드" 두 묶음은 하나로, 평면 목록은 해당 영역으로 합쳤다.

| Epic | 묶은 원문 카테고리 | 남은 항목 |
|---|---|---:|
| DESIGN 공통 UI | 디자인 공통, 버튼 테두리, 간격, dropdown, tooltip, glass, modal 스와이프 | 7 |
| SHELL 앱 셸·세션·설정 | 재진입 문구, 보던 문제 돌아가기, 테마, 설정, 가상키보드, 도움말 | 12 |
| HOME 홈·Heatmap·본문 검색 | heatmap, 홈, 검색 | 9 |
| VIEW 문제 보기·편집 | 문제보기(일반), dnd 보기 순서 | 13 |
| EXPL AI 해설 | 문제보기 > AI 해설 | 5 |
| HILITE 하이라이트 | 문제보기 > 하이라이트, 해설 하이라이트 | 4 |
| ASK AI 질문 | AI 질문 리스트·대화 | 7 |
| PLAY 모의고사 | 모의고사(검증만) | 0 + test |
| DOCS 업로드·원본 | 업로드 2묶음, 원본 링크 | 6 |
| CHAPTER 챕터 | 챕터, 챕터 관리, 챕터 dnd, 교재 번호 | 6 |
| SHARE 공유 | 공유 설정 | 1 |
| EXTRACT 추출 품질 | 이미지·테이블, 표 보기, 테이블 인식, 파싱 오류, 문제 범위 | 5 |

## 4. Epic별 구현 계획

크기는 S/M/L이다. "개정"은 함께 고쳐야 하는 기존 명세다. 결정 번호 D-n은 §6을 본다.

### 4.1 DESIGN — 공통 UI

| Task | 항목 | 구현 | 개정·test | 크기·의존 |
|---|---|---|---|---|
| DESIGN-1 컨트롤 | 버튼 테두리 삭제, hover 배경, 간격 compact | `controls.css`: 아이콘 ghost는 `border-color: transparent`(크기 유지, 토글류 제외). text ghost용 `borderless` prop은 사용자 목록 항목에만(뒤로가기, 프로필, 접기/펼치기, 제목 버튼). `button.qz-back-link` 테두리 제거. raw button에 `--color-state-hover`. `--control-gap` 토큰을 버튼 묶음에만 적용 | **UX10-UI 설계와 AC01을 뒤집는다.** ui.md, ux10-ui, design-system §4. `swipe-dismiss.test.ts`, `ux10-overlays.spec.ts`의 불변식을 "목록 외 컨트롤은 경계 유지"로 변경. D-1 | M·없음 |
| DESIGN-2 팝업 | dropdown 재클릭 닫기, tooltip 안전 margin | `Tooltip`에 `collisionPadding` 16, 공용 상수, `.qz-tooltip` max-width. dropdown은 정적으로는 재현 안 됨(Radix가 trigger 토글). Chromium·WebKit·touch RED를 먼저 쓰고 실패한 경로만 고친다 | 새 AC. 재현 실패 시 사용자에게 화면을 묻는다 | S·없음 |
| DESIGN-3 제스처 | modal 스와이프 + 관성, 복귀 bar 스와이프 | `swipe-dismiss.ts`를 `useDragDismiss`로 재작성. CSS `translate` 추적, release 속도로 WAAPI 퇴장, 거부되면 복귀, `data-swiped`로 Radix 퇴장 애니메이션 끔. 방향: 768px 미만은 아래, 넓으면 side 방향, 중앙 dialog는 아래. drawer 추가, header 전체에서 시작 | 현재 close-on-release만 있다. 중앙 dialog가 폰에서 left로 판정되는 버그와 제목 글자에서 시작 안 되는 버그를 함께 고친다. UX10-UI AC03·04, UX11 AC03 개정. D-2 | L·SHELL-1 |
| DESIGN-4 Glass | gradation 색상 | `.glass-surface`에 테마별 gradient 층 추가. 모바일 sheet의 `background` shorthand가 gradient를 지우므로 수정. PDF 위 표면은 제외 | design-system §3. 양 테마 대비 test. D-3 | M·DESIGN-1 |

### 4.2 SHELL — 앱 셸·세션·설정

| Task | 항목 | 구현 | 개정·test | 크기·의존 |
|---|---|---|---|---|
| SHELL-1 신원 재확인 | 재진입 문구, 복귀 버튼 깜빡임 | 원인 확인: `verifyIdentity`가 창 `focus`·`pageshow`·복귀 클릭마다 `identityPending`을 켜고, `globals.css`가 앱 전체를 `visibility: hidden`으로 만든다. **문구만 지우면 빈 화면 깜빡임이 남는다.** `silent` 모드를 추가해 계정 불일치가 확정될 때만 가린다. 활동 buffer는 유지한다 | ux11-return AC04 개정. `practice-return-provider.test.tsx` RED "same user focus → pending 없음". D-4 | M·없음 |
| SHELL-2 복귀 bar 모양 | padding, 둥근 모서리, glass, X 테두리 | `practice-return.module.css`. 버튼 padding 축소, 외곽 padding 확대, `--radius-xl`, `glass-surface`. 높이 유지, 320px 대응. X 테두리는 DESIGN-1로 해결 | AC05 44px 유지 | S·DESIGN-1,4 |
| SHELL-3 테마 | light/dark 버튼 | `ThemeProvider`가 kit에만 있고 앱에 안 쓰인다. `quiz-theme` cookie를 RootLayout이 읽어 `data-theme` 지정(깜빡임 없음, CSP 영향 없음). 사용자 메뉴에 시스템/라이트/다크 | design-system §3.2. 저장 유지 E2E. D-5 | M·DESIGN-1 |
| SHELL-4 설정 | 드래그 자동 복사 | `/settings/preferences` 추가, Switch 기본 꺼짐. `useAutoCopyOnSelect`: pointer 선택만, 입력란 제외. `HighlightableText`의 선택 메뉴와 공존, 복사 내용은 `rangeText` 재사용. iOS는 clipboard 제약으로 데스크톱 우선 | 새 화면 명세. D-5 | M·SHELL-3 |
| SHELL-5 가상키보드 | 키보드 때 헤더·본문 고정 | `interactiveWidget: 'resizes-content'` + `useKeyboardInset`(`visualViewport`). sticky header, panel, 복귀 bar 보정 | overlay-scroll.md. Playwright로 실제 키보드를 못 띄우므로 **실기기 확인이 DoD**. iOS는 최선 노력 | M·SHELL-3 |
| SHELL-6 도움말 | Release note / help center | 사용자 메뉴에서 여는 `도움말` 정적 페이지, 릴리스 노트는 그 한 절 | D-6 | S·SHELL-3 |

### 4.3 HOME — 홈·Heatmap·본문 검색

| Task | 항목 | 구현 | 개정·test | 크기·의존 |
|---|---|---|---|---|
| HOME-1 Heatmap | 닫은 뒤 preview 잔상, cell 28px | 잔상 원인(코드 추론): modal을 닫으면 `focusAfterPanel`이 cell로 focus를 되돌리고, Radix tooltip이 focus에서 열린다. `focusQuestionDotQuietly`로 이 경우만 막는다. Tab focus·hover 미리보기는 유지. `heatmap-cell` 28px, touch는 24px 유지 | **UX5-UI 결정(28→24)을 뒤집는다.** tokens test, design-system, questions.md, §7. D-12 | S·없음 |
| HOME-2 AI off 정리 | LLM off 잔여 UI | 남은 것: 문서 행 `요약`, 노트 전송 안내와 "사용할 수 없습니다", 요약·해설의 이유 문구. workspace 단위 summary capability 노출 | UX10-AI-AC01, DOCSUM-01, CHNOTE-01. `make contracts`. D-14 | M·없음 |
| HOME-3 본문 검색 | AI에게 묻기를 header로, 본문 없으면 입력 disabled | `PageHeader actions`로 이동, `extraAction` 제거. Input `disabled` + `aria-describedby` | ASK-01, SEARCH-02-AC04, search.md | S·HOME-2와 순서 조정 |
| HOME-4 Header | 문서 검색·문서 관리 dropdown 이동, `문서 N` 버튼화, sticky | `question-menu.tsx` trigger를 `문서 N ▾`로, 풀기 왼쪽 배치. 메뉴: 문서 관리·본문 검색 / 직접 추가·중복 정리·재분배 / 보관·초안. sticky는 `.home`을 grid에서 flex로 바꿔야 동작한다. dot에 `scroll-margin-top` | UX10-HOME-AC01, SEARCH-02 AC01, QOV-01 AC11. `fixtures/workspace-ui.ts` 공통화(스펙 약 20개 영향). D-7 | L·없음 |
| HOME-5 검색·필터 줄 | 검색 아이콘 펼침, 필터 popover, 레이블 삭제, 칩 삭제 | `question-search.tsx` 재작성. `grid-template-columns 0fr→1fr` + opacity, 닫힌 input `inert`, `ChevronLeftIcon`·`FilterIcon` 추가. 필터 활성 표시 필수. `다시 풀기만`은 `다시 풀기` 상태 칩과 같은 값이라 삭제해도 기능 손실이 없다. `?retry=true`는 `status=retry`로 변환. **빈 결과의 필터 초기화는 유지**(없으면 탈출 경로가 없다) | UX10-HOME-AC02 폐기, SEARCH-01 AC09·12. D-7 | L·HOME-4 |

### 4.4 VIEW — 문제 보기·편집

| Task | 항목 | 구현 | 개정·test | 크기·의존 |
|---|---|---|---|---|
| VIEW-1 컨트롤 | 화살표 버튼(sequence), 다시 풀기 스타일, 초기화 숨김, 항상 표시, 스크롤 최상단 | practice는 끝났고 sequence 남음. `NavButton` 공유. 초기화는 결과가 있을 때만. 스크롤 원인: 재오픈 때 `outcomeId` effect가 결과로 focus를 옮겨 내려간다. live 제출 뒤에만 focus, `FloatingSidePanel`에 `scrollKey` 추가 | UX10-QVIEW-AC02, RETRY-01. D-8 | M·없음 |
| VIEW-2 보기 표시 | radio hover, 결과 문구 삭제, 즐겨찾기 아이콘, 보기 줄바꿈 | 행 hover가 원·굵기를 구동(`@media (hover:hover)`). 별칭 토큰 추가. 문구는 visually hidden 유지. `.qz-study-toggle`의 selected 배경 제거. answer 모드 `pre-wrap` | QPLAY-01-AC12, design-system §4.1. `#E7ECF0`을 그대로 쓰면 대비 약 1.2:1이라 기준 미달. D-8 | M·없음 |
| VIEW-3 편집 | 보기 순서 dnd, 보기 줄바꿈 입력 | `@dnd-kit` 추가, `QuestionContentFields`에 handle. 위로/아래로 유지(WCAG 2.5.7). 보기 ID는 함께 이동하므로 채점 안전. 입력을 Textarea로 | ID·정답 불변 Vitest, 순서 변경 후 제출 E2E | M·없음 |
| VIEW-4 원문 보기 메뉴 | 더보기 메뉴의 원문 보기 | `Preview`를 hook과 view로 분리, `headerExtra`로 전달. 본문 버튼도 유지 | QSRC-01 새 AC. 기본: 진입점 둘 다 유지 | M·VIEW-1 |
| VIEW-5 로딩 속도 | 문제 로딩 개선 | 측정 먼저(Server-Timing, client mark). 열기마다 server action 2회가 직렬로 돈다. `POST …/practice-open` 한 트랜잭션 + BFF route로 통합. 미제출 payload 유출 test·리셋 경합 유지 | ux10/qview.md, `make contracts`. hover prefetch는 측정 뒤 결정 | L·VIEW-1 |
| VIEW-6 탐색 반응 | breadcrumb 지연 | 코드만으로 원인 미확정. `useLinkStatus` pending 표시, `documents/[documentId]/loading.tsx` 추가. 측정 후 확정 | D-13 | S–M·없음 |

### 4.4a VIEW 추가 — 제시문 구분(사용자 요청 2026-11-06)

| Task | 항목 | 구현 | 개정·test | 크기·의존 |
|---|---|---|---|---|
| VIEW-7 제시문 | 제시문 내 줄바꿈, 제시문 사이 구분, 제시문마다 영역 구분 | `<제목>` 형태의 제시문과 `(가)` 항목을 나누어 각각 박스로 표시한다. `∙`, `-` 항목은 줄을 나눈다. 표시 단계에서 처리해 이미 등록된 문제에도 적용하고, 추출기에도 같은 규칙을 넣는다 | QPLAY-01, questions.md §4. TS/Python parity | M·없음 |

### 4.5 EXPL — AI 해설

| Task | 항목 | 구현 | 개정·test | 크기·의존 |
|---|---|---|---|---|
| EXPL-1 UI | 나란히 배치, 관련 본문 디자인, "작성중..." | `RelatedShell` heading을 공용 disclosure로 추출, `AI 해설 보기` 버튼 제거. 문구는 원문 그대로 | AIEXPL-01, `fixtures/ai-explanations.ts`, VISUAL-09 | S–M·없음 |
| EXPL-2 프롬프트 | 해설 원본 참조 제거 | `explain/prompts.py`의 `기존 해설` 줄, `ExplainQuestion.explanation`과 SQL 삭제, `PROMPT_VERSION` v2, 안내 문구 수정. AI 질문 프롬프트는 범위 밖 | AIEXPL-01 C04. D-14 | S–M·없음 |
| EXPL-3 취소 | 만들기·다시 만들기 실행 취소 | `POST …/ai-explanation/cancel`(요청자 또는 editor, 좁은 권한의 migration 추가), worker stream에 ask의 `stopped()` 방식 추가, `취소` 버튼. 다시 만들기 취소 시 기존 해설로 복귀. 취소분도 한도에 계산 | 새 AC, cross-user 403, `make contracts` | L·EXPL-1 |

### 4.6 HILITE — 하이라이트

| Task | 항목 | 구현 | 개정·test | 크기·의존 |
|---|---|---|---|---|
| HILITE-1 | selection 유지, 재클릭 닫기, 복사 토스트, 안내 토스트화 | 메뉴 focus 뒤 `selection.restore()`, 실패 시 CSS Custom Highlight API. `activeHighlightId`로 재오픈 방지. 복사 성공 시 닫고 토스트 `복사했습니다.`. `정리 노트의 내 하이라이트에 모았습니다` 문구는 새 하이라이트 토스트로 이동 | HILITE-01 문구·AC. 2개 브라우저 E2E. touch OS handle은 위험 요소 | M·없음 |

### 4.7 ASK — AI 질문

A1~A7은 `ask-panel.tsx`의 같은 render block을 고치므로 Task 하나로 묶는다.

| Task | 항목 | 구현 | 개정·test | 크기·의존 |
|---|---|---|---|---|
| ASK-1 명세·RED | 7개 전체 | `docs/screens/ux12-ask.md`, ASK-01 개정. **AI 생성 표시·다시 생성은 2026-11-01 사용자 결정을 뒤집으므로** §7에 기록 | D-10 | S·D-10 |
| ASK-2 구현 | 목록 테두리, 입력창 삭제, FAB, 대화창 재구성, 뒤로가기, 범위 popover, 레이블 삭제 | 목록에서 footer 제거. 단 `role=status`는 content로 옮기고, 삭제 실패·보관 상태 안내는 목록에도 표시, 작성 중 draft 유지. FAB 56px 원형 sticky(새 `PlusIcon`), 마지막 행 메뉴가 가리지 않게 여백. **대화창(사용자 설계 수정 2026-11-06):** 입력창은 대화 화면 하단 floating UI다. 입력창 안 오른쪽에 왼쪽부터 제출, 질문 범위 순으로 둔다. 질문 범위는 필터 아이콘(`FilterIcon`, 이름 `질문 범위`) 버튼이며 범위가 좁혀지면 활성 표시를 한다. popover는 `side="top"`. 답을 기다리는 동안 제출 버튼이 중단 버튼으로 바뀐다. 마지막 메시지가 floating 입력창에 가리지 않게 여백을 둔다. `FloatingSidePanel`에 `headerStart` 추가. RadioGroup 삭제, 768px 미만 전체 폭 | `fixtures/ask.ts`의 `ask()`가 composer를 먼저 열도록. `ask-panel.test.tsx` 18곳, `a11y-ask.spec.ts`. HOME-5와 `FilterIcon` 공유 | L·ASK-1, DESIGN-1 |

### 4.8 PLAY — 모의고사

| Task | 항목 | 구현 | 크기·의존 |
|---|---|---|---|
| PLAY-1 검증 보강 | 항목은 모두 완료 | 문항 수·난이도 기하 E2E, 상세 화면·저장 실패 이름 수정 E2E, MOCK-01의 낡은 `StepProgress` 문구 수정, 변형 0개일 때 `이름` 숨김 | S·없음 |

### 4.8a PLAY 추가 — 모의고사 흐름(사용자 요청 2026-11-06)

구현 전 점검: 아래 요청은 현재 코드에 없다. 하단 버튼에는 sticky 스타일이 있지만 사용자가 고정 안 됨을 보고했으므로 재현부터 한다.

| Task | 항목 | 내용 | 비고 | 크기·의존 |
|---|---|---|---|---|
| MOCKUX-1 만들기 화면 | step UI, 제목, 스크롤, 범위 필터 | 만들기와 설정 바꾸기의 `문제 풀기` 제목과 단계 목록을 지우고 업로드와 비슷한 step UI를 패널 안 상단에 고정한다. 패널 제목은 `모의고사`. 좌우 스크롤 흔들림과 하단 버튼 고정 문제를 재현해 고친다. 범위 단계: `상태 필터` 접기를 지워 필터를 항상 보이고, 상태 chip에 홈과 같은 색 표시를 넣는다. `유형` 드롭다운은 체크박스 묶음(복수 선택)으로 바꾼다. `이전` 버튼을 지우고 step 표시의 1단계를 눌러 돌아간다 | 사용자 결정(2026-11-06): 체크박스는 문제 형식 필터. `모의고사 목록` 뒤로가기는 유지 | L·없음 |
| MOCKUX-2 진입·상세·용어 | 홈 `풀기`, 상세 메뉴, 용어 | 홈 `풀기`는 모의고사 목록을 연다. 상세는 `풀기`만 버튼으로 두고 `설정 바꾸기`, `다시 만들기`, `이름 바꾸기`, `삭제`는 더보기 드롭다운으로 옮긴다. 화면 문구와 문서의 `문제 풀기`를 `모의고사`로 정리한다 | 홈 버튼 이름은 이후 요청으로 `모의고사`(MOCKUX-4) | M·없음 |
| MOCKUX-3 풀이 버튼 | 제출, 이전/다음 | 범위 풀이 panel의 `제출`, 이전/다음 버튼을 Heatmap 셀로 연 풀이 panel과 같게 맞춘다(이름, 순서, 모양) | 마지막 문제의 `결과 보기`는 범위 풀이에만 있다 | M·없음 |
| MOCKUX-4 챕터별 풀기 | 홈 챕터의 `풀기` | 홈 Heatmap의 챕터마다 `풀기` 버튼을 둔다. 누르면 저장 없는 풀이로 바로 들어간다. `보기 섞기`와 `문제 순서 무작위`만 고르고 확인한 뒤 시작한다. 범위 고르기 단계와 `모의고사 목록` 버튼은 없다 | 사용자 요청(2026-11-06). 범위는 그 챕터의 확정 문제 전체. 모든 멤버 사용 가능 | M·MOCKUX-1, 2, 3 |
| MOCKUX-5 다시 풀기 열기 | 해설 먼저 보임 | `다시 풀기` 상태의 문제는 이미 풀었더라도 열 때 이전 결과와 해설 없이 풀이 화면부터 보인다 | 사용자 요청(2026-11-06). MOCKUX-2의 "홈 버튼 이름 `풀기` 유지"는 같은 날 요청으로 `모의고사`로 바뀌어 MOCKUX-4에서 처리한다 | M·MOCKUX-3 |

### 4.9 DOCS — 업로드·원본

| Task | 항목 | 구현 | 개정·test | 크기·의존 |
|---|---|---|---|---|
| DOCS-1 업로드 | step 폭 고정, 숫자 정렬, 문구, 취소 버튼 | `.steps` 고정 basis, `%`는 `5ch` tabular. `.marker` `line-height: 1`, 한 단계 작게. `processingLabel`이 단계명만 반환. `structuring`→`구조 분석 중`, `chunking`→`색인 준비 중`으로 바꿔 `분석 중` 중복을 막는다. 취소는 `IconButton` + `TrashIcon` | DOC-01-AC05, `workspace-ui.ts` locator | S·없음 |
| DOCS-2 원본 패널 | 원본 링크 → floating dialog | 현재 같은 탭 이동 지점: 가져오기 초안, 문제 상세 출처, 관련 본문 PDF, 검색 발췌, 요약 쪽 링크, 공유 화면 4곳. `SourceComparePanel`에 `initialPage`, 공용 `PdfPageDialog`. 풀이 화면은 전체 PDF 금지(QSRC-01) | QIMPORT-01·02, RELSRC-01, QVIEW-01. D-13 | M·CHAPTER-1과 순서 조정 |

### 4.10 CHAPTER — 챕터

사실: 챕터는 parser가 만들고 document revision에 속한다. 발행 revision은 `revision_content_guard`로 동결되어 있다. 사용자 편집은 제목 블록 교정뿐이다. 문제 FK에 ON DELETE가 없으므로 삭제 전 문제 이동이 필수다.

| Task | 항목 | 구현 | 개정·test | 크기·의존 |
|---|---|---|---|---|
| CHAPTER-1 Picker | dropdown → popover 트리 | 새 `ChapterPicker`(Popover, 접기/펼치기, 입력 필터, 키보드 tree). 호출처 6곳: 홈 필터, 문제 편집, 초안, 재분배, Ask 범위, 검색. **열린 동안에만 렌더**(초안 752 × 챕터 300 탭 크래시 재발 방지). Ask·검색은 하위 챕터까지 선택 가능해진다 | design-system §7, CHREDIST-01 외. 규모 test | L·없음 |
| CHAPTER-2 | 1 | 완료 | Codex 반영, 번호 라벨 전 화면 통일, PR #80 병합 |
| CHAPTER-3 명세·RED | 챕터 관리 | `chapter-management.md`(CHMAN-01), DOC-02-AC02 개정, questions §14, architecture §5, workspace-sharing §11 | D-9 | M·D-9 |
| CHAPTER-4 API | 추가·수정·삭제·이동 | migration: guard에 `chapter_edit` 경로, `documents.chapter_tree_version`, 변경 이력 source 추가. API: tree 조회, 생성, 수정, 일괄 이동(`expected_version`), 삭제(`move_questions_to`). 잠금 순서 Workspace → 문서 → 문제. 사용자 챕터 key는 `user-<uuid>`, 이전 revision 복원 시 이어받기 | pgTAP, 계약, 권한 매트릭스, fork 경합 | L·CHAPTER-3 |
| CHAPTER-5 관리 화면 | dnd 계층 관리, drop | `문제` 메뉴 `챕터 관리`, modal panel, `@dnd-kit` + 키보드 동등 메뉴. 문제를 챕터로 끌어 놓기는 기존 `chapter-assignments` 재사용 | Chromium·WebKit touch | L·CHAPTER-1, 4 |
| CHAPTER-6 필터 계층 | 계층별로(잔여) | `OverviewChapter`에 level 추가, 홈 필터 `ChapterPicker`를 계층으로 표시. Heatmap 배치는 바꾸지 않는다(사용자가 완료로 체크, D-9 미응답) | D-9 | S·CHAPTER-1 |

### 4.11 SHARE — 공유 범위

| Task | 항목 | 구현 | 개정·test | 크기·의존 |
|---|---|---|---|---|
| SHARE-1 제외 선택 | 노트·AI 해설·요약 포함 여부 | `workspace_share_links`에 `include_*`(기본 true, 기존 링크 유지). 모든 shared route에서 검사, 꺼지면 404. fork manifest에 고정 후 commit에서 재검사(`worker_fork_commit` 재정의) | 플래그 × route 권한 매트릭스, pgTAP | L·없음 |
| SHARE-2 Owner 기록 보기 | 풀이 이력·하이라이트 포함 | 링크별 옵션 `include_owner_records`(기본 false). 켜면 게스트가 Owner 본인의 풀이 이력과 하이라이트를 읽기 전용으로 본다. 다른 멤버 기록과 Owner 프로필은 노출하지 않는다. 게스트 쓰기 없음, Fork 복사 없음 | **workspace-sharing §1·§3·§11과 2026-11-02 결정을 사용자 결정(2026-11-06)으로 개정한다.** 옵션 × shared route 권한 매트릭스, 다른 멤버 누출 test, 꺼짐 404, fork 비복사 회귀 | L·SHARE-1 |

### 4.12 EXTRACT — 추출 품질

3개년 A형 PDF 180문항을 메모리에서 파싱한 수치다(3권 전체와 교재는 미실행).

| 측정 | 결과 |
|---|---:|
| 발문 안 표가 경고 없이 버려진 문제 | 21문제, 표 23개 (12%) |
| 문제 안 그림 | 2개 |
| 보기 표 | 2개 |

**확인된 버그:**
- **읽기 순서 역전:** Docling 순서가 페이지 순서와 다르다. 2025 Q12/13은 보기 8개가 한쪽에 붙고 **앞 문제의 정답을 가져간다.** 2023 Q38/39는 경고 없이 잘린다. page + y 정렬 시뮬레이션에서 2025 문제는 모두 해소됐다.
- **스크린샷 문제(3권 37쪽 72번):** 확정. 추출 오류가 아니다. 추출기는 72번을 발문부터 보기까지 정확히 한 문제로 묶는다. 표 안 소제목 두 개가 heading이 되어 목차 구역을 만들고, 문서 뷰어(DOC-02)가 **확정 전 문제**의 목차 행을 누르면 그 구역 상자를 그린다. 스크린샷 두 조각은 이 구역과 일치한다. 3권 750문항 중 34문항이 같은 형태다. EXTRACT-2에서 초안 문제도 문제 전체를 표시하도록 고친다.
- **장식 이미지 혼입:** 여백 장식이 문제 범위에 붙어 73번 영역이 72번까지 덮는다. 3권의 겹침 67쌍과 다쪽 초안 33건이 모두 이 때문이다. 3권 이미지 469개 중 414개가 장식이다.

| Task | 항목 | 구현 | 개정·test | 크기·의존 |
|---|---|---|---|---|
| EXTRACT-1 진단 | pdf 파싱 오류, 문제 범위 | `eval/question_pdfs.py`(수치만 출력): 역전, 보기 수 분포, 공백, 버려진 표, 역순·겹침 region. 3권 72번의 끊긴 범위 원인 확정, 표시 경로 추적 | 사용자 보고 사례를 synthetic fixture로 | S·없음 |
| EXTRACT-2 순서·장식 | 문제 범위 | 공용 `reading_order(blocks)`: 페이지 → y 3pt 행 묶음 → x. 엄격한 2단 판정(양쪽 넓은 블록 4개 이상, 가운데 걸침 3개 이하)일 때만 유지. 본문 영역 밖 이미지 제거를 **같은 변경**에 넣는다(정렬만 하면 악화). `extract`, `llm_requests`, `classify` 모두 적용. 문서 뷰어 `selectionHighlights`가 초안 블록도 사용 | synthetic Block pytest, 3권 기대 결과 대조, 2023–25 복구 확인 | M·EXTRACT-1 |
| EXTRACT-3 명세 | 표·그림 | `QTABLE-01` 화면, questions §4·§6, QSRC-01 | D-11 | S·D-11 |
| EXTRACT-4 표 추출 | 이미지·테이블 가져오기, 표 인식 | 비보기 표를 GFM 블록으로 `stem`에 포함, `_source_lines`에 포함, 프롬프트 `questions.extract/v4`(없으면 모든 표 문제가 `llm_text_rejected`). 붙은 라벨(`①xxx`) 인식, `table_in_stem` 안내 | Python/TS parity | M·EXTRACT-2, 3 |
| EXTRACT-5 표 표시 | 표로 보이기 | `StemText`에 pipe 파싱(소비처 5곳 자동 적용), 375px 가로 스크롤. `optionGrid`: 보기가 같은 칸 수로 나뉘면 열 정렬, 섞기 안전, 등록된 문제도 재추출 없이 개선 | Vitest, synthetic E2E, VISUAL(정답 mask) | M·EXTRACT-3 |
| EXTRACT-6 재추출 | 기존 문제 반영 | 수정은 새 run에만 적용된다. `다시 추출`: 같은 revision에 새 run과 초안, 등록된 문제는 그대로. 교체 경로 필요(변경된 지문은 중복 탐지에 안 걸린다) | D-11 | M·EXTRACT-2 |
| EXTRACT-7 그림 | 이미지 표시 | `source-region`에 `figures[]`, PDF 영역을 보기 위에 lazy 표시. 정답 뒤 이미지 제외 | QSRC-01. D-11 | M·EXTRACT-2 |
| EXTRACT-8 span | 테이블 렌더링 | `TableContent.spans`, API·contract, `colSpan`/`rowSpan`, chunker 중복 제거. 기존 revision은 재파싱 전까지 그대로 | `make contracts` | M·없음 |
| EXTRACT-9 구조화 셀(A안) | 문제 표 병합 셀·표 편집 | `stem`의 GFM은 유지하고 `stem_tables` JSON을 추가한다. `question_revisions`, `mock_exam_question_revisions`, 초안 payload에 저장하고 등록, 수정, 모의고사, Fork 복사 경로로 전달한다. 화면은 맞물리는 구조화 데이터를 우선 사용하고 AI, 검색, 중복 판정은 `stem`을 그대로 읽는다. 문제 편집에서는 표를 표로 편집한다(칸 글자, 행·열 추가와 삭제, 병합 유지와 줄임). 저장 시 구조화 데이터에서 GFM 묶음을 다시 쓴다. pipe 묶음을 직접 고쳐 어긋나면 GFM으로 돌아간다. 칸 병합·해제는 범위 밖 | 사용자 결정(2026-11-06). 기존 문제는 `다시 추출`로만 반영 | L·EXTRACT-4, 8 |
| EXTRACT-10 발문 전체 구조화(B안, 추후) | 발문 블록화 | `stem`을 블록 구조로 교체한다. `stem`을 쓰는 약 120개 파일, 프롬프트, 중복 판정, 지문 해시를 함께 바꾼다 | 이번 범위 밖. 사용자 결정(2026-11-06)으로 기록만 남긴다 | XL·EXTRACT-9 |

## 5. 실행 순서

Wave 안의 Task는 파일 범위가 겹치지 않아 병렬 실행할 수 있다. 각 Wave 끝에 QA·baseline·PR을 한 번 수행하고, 사용자 시각 확인 뒤 다음으로 간다.

| Wave | PR(`feature/ux12-*`) | Task | 이유 |
|---|---|---|---|
| 1 | `fixes` | EXTRACT-1, EXTRACT-2, SHELL-1, DESIGN-2, HOME-1, HILITE-1, DOCS-1, PLAY-1, CHAPTER-2 | 잘못된 정답·깜빡임·잔상 등 결함 우선, 의존 없음 |
| 2 | `controls` | DESIGN-1 후 VIEW-1, VIEW-2, EXPL-1, EXPL-2, HOME-2 → HOME-3 | 공통 버튼 규칙이 먼저 정해져야 화면별 수정이 다시 흔들리지 않는다 |
| 3 | `home` | HOME-4 → HOME-5, ASK-1 → ASK-2 | header 재배치와 AI 질문 재구성. fixture 변경이 넓다 |
| 4 | `tables` | EXTRACT-3 → EXTRACT-4 ∥ EXTRACT-5, EXTRACT-8, EXTRACT-6, EXTRACT-7 | D-11 필요 |
| 5 | `motion` | DESIGN-3, DESIGN-4, SHELL-2, VIEW-3, EXPL-3, VIEW-4 → VIEW-5, VIEW-6, DOCS-2 | 전역 시각 변경은 뒤로 |
| 6 | `shell` | SHELL-3 → SHELL-4, SHELL-5, SHELL-6 | `app/layout.tsx` 공유 |
| 7 | `chapters` | CHAPTER-1, CHAPTER-3 → CHAPTER-4 → CHAPTER-5, CHAPTER-6 | 모델 변경, D-9 필요 |
| 8 | `share` | SHARE-1 → SHARE-2 | 공유 route 전체 권한 검사 |
| 9 | `mock` | MOCKUX-1 ∥ MOCKUX-2 ∥ MOCKUX-3 → MOCKUX-4, MOCKUX-5 | 사용자 추가 요청. `chapters` PR 뒤에 올린다 |

- **DESIGN-1 범위:** 파일이 넓게 겹치므로 Wave 2 시작에 단독 실행한다.
- **순서 고정:** `practice-return-provider.tsx`는 SHELL-1 → DESIGN-3, `practice-viewer.tsx`는 VIEW-1 → VIEW-4 → VIEW-5, `FloatingSidePanel.tsx`는 VIEW-1과 ASK-2가 공유한다.
- **공유 파일:** `contracts/openapi.json`, `packages/api-client`, `packages/ui/src/index.ts`, `icons.tsx`, `e2e-trace.ts`, `@dnd-kit` lockfile은 main thread가 merge 뒤 재생성한다.

**Task brief 공통 형식(10~20줄):** Task ID·branch, 요구와 사용자 결정, 이 문서의 해당 행, 파일·AC 위치, AGENTS.md §8의 관련 함정, 최소 검증 명령, 보고 형식.

## 6. 사용자 결정

**결정됨** 표시와 **미정** 항목 외에는 권장안을 기본값으로 두고 진행한다.

| # | 결정 | 권장 |
|---|---|---|
| D-1 | **결정됨(2026-11-06):** 나열한 버튼을 기본으로 지운다. 목록에 없어도 같은 맥락이면 지운다. DESIGN-1은 지운 버튼 목록을 PR에 첨부한다 | — |
| D-2 | 스와이프 시작 위치: header + grabber만 / 폰에서 본문 맨 위도 | header + grabber만 |
| D-3 | gradient 색: 낮은 alpha의 파랑→라벤더 / 무채색 / 진한 색(불투명도 .97 하향 필요) | 낮은 alpha |
| D-4 | 신원 확인 실패 시: 화면 유지, 재시도, 10초 뒤 작은 안내 / 계속 침묵 / 현재처럼 가림 | 화면 유지 + 안내. 표면상 계정 전환 감지가 짧게 늦어지는 위험 수용 |
| D-5 | 테마: 사용자 메뉴 시스템/라이트/다크 / header 2단 토글. 자동 복사 설정 저장: 브라우저별 / 계정 동기화 | 3단 메뉴, 브라우저별 |
| D-6 | 도움말: 도움말 페이지 + 릴리스 노트 절 / 릴리스 노트만 / 외부 사이트 | 도움말 페이지 |
| D-7 | 홈: 필터 popover에 챕터+유형, 상태 칩은 페이지 유지 / 메뉴는 `문서 N ▾` 하나로 통합, 이름은 `본문 검색`, 검색 닫으면 검색어 지움 | 왼쪽 그대로 |
| D-8 | 다시 풀기 "항상 보이게": footer 버튼 항상 표시(첫 제출 전 비활성) / 토글 항상 표시. 결과 문구 삭제 시 색만 남는 문제: 행에 ✓/✗ 아이콘, 단답은 문구 유지. radio 색: 평소 `viewed`, hover `border-strong` | 각 왼쪽 |
| D-9 | **결정됨(2026-11-06):** 챕터 편집은 활성 revision에 즉시 적용한다. 공유는 제외 선택과 Owner 기록 읽기 전용 옵션을 만들고, Fork에는 복사하지 않는다. **미정:** 삭제 시 문제 이동 대상 필수 여부, Heatmap 계층화 여부 | 대상 필수 |
| D-10 | AI 질문: 대화 화면의 `새 대화` 제거, `다시 시도`는 유지, AI 안내 문구 유지 | 왼쪽 그대로 |
| D-11 | **결정됨(2026-11-06):** 표는 `stem` 안 GFM으로 저장하고, 구조화 셀은 별도 컬럼으로 추가한다(EXTRACT-9). 발문 전체 구조화는 추후 과제다(EXTRACT-10). **미정:** 그림(PDF 영역 인라인 / 저장 crop + signed URL / 버튼만), 기존 문제(`다시 추출` / 재업로드), 교재 번호(접두어만 제거 / 평면 정렬 추가) | 인라인, `다시 추출`, 접두어 제거 |
| D-12 | hover 배율 1.18 유지 / 약 1.3으로 상향 | 약 1.3 |
| D-13 | 원본 패널 범위: 가져오기만 / + 상세·관련 본문·발췌·요약 / + 공유 화면. 체크된 `pdf에서 보기`가 본문 발췌의 버튼까지 뜻하는지. 느린 breadcrumb 화면 | 두 번째 범위, 발췌 포함, 화면은 사용자 지정 필요 |
| D-14 | LLM off 때 저장된 요약 없는 `요약` 버튼 숨김. 기존 AI 해설: 버전 올려 사라짐(건당 약 $0.02–0.03로 재생성) / 계속 표시 | 숨김, 버전 올림 |

## 7. 위험

- **뒤집는 기존 결정:** 버튼 경계(UX10-UI), cell 24px(UX5-UI), AI 생성 표시·다시 생성(2026-11-01), 상태 표시 text(design-system §4.1), 하이라이트·풀이 비공유(2026-11-02, 옵션을 켠 링크에 한해 개정). 각 Task가 §7 결정 기록에 남긴다.
- **접근성 충돌:** 결과 문구 삭제는 색만으로 상태를 전달하게 되고, 연한 radio는 대비 기준에 못 미친다. D-8 권장안이 이를 막는다.
- **테스트 영향:** HOME-4·ASK-2의 fixture 변경이 넓고, DESIGN-1·4는 baseline 대부분을 바꾼다.
- **실기기 필요:** SHELL-5, DESIGN-3 체감, iOS 자동 복사는 사용자 기기 확인이 필요하다.
- **미확인:** VIEW-5·VIEW-6은 측정 전이고, DESIGN-2의 dropdown은 재현 전이며, 

## 8. 진행 현황

상태: 대기 · 진행 · 리뷰 · 완료. 병렬 Task는 Wave 시작 때 함께 착수한다.

| Task | Wave | 상태 | 커밋·리뷰 |
|---|---|---|---|
| EXTRACT-1 | 1 | 완료 | EXTRACT-2에 포함 · Codex P2 1건 수정, 72번 원인 확정 |
| EXTRACT-2 | 1 | 완료 | c55e0835 · Codex P2 2건 수정 후 재리뷰 통과, pytest 164·Vitest 73, 실제 PDF 6개 비교 일치 |
| SHELL-1 | 1 | 완료 | 12cb1e79 · Codex P2 1건 수정(9e71118c), 재리뷰 지적 없음, E2E 22·Vitest 38 GREEN |
| DESIGN-2 | 1 | 완료 | 44b7afcd · Codex P2(CI phase)는 merge에서 반영, tooltip 여백·Select touch 재클릭 수정, E2E 30 GREEN |
| HOME-1 | 1 | 완료 | ddd8b596 · Codex 지적 없음, Vitest ui 448, E2E Chromium·WebKit GREEN. QOV-01-AC14 WebKit flake는 기존 문제, CI에서 확인 |
| HILITE-1 | 1 | 완료 | 652666a9 · Codex 지적 없음, E2E 34·Vitest web 1367·ui 452 GREEN |
| DOCS-1 | 1 | 완료 | b7cc79fb · Codex 지적 없음, Vitest web 1375·ui 446·tokens 186, E2E 14 GREEN |
| PLAY-1 | 1 | 완료 | d9be06c1 · Codex 지적 없음, Vitest 20·E2E 44 GREEN |
| DESIGN-1 | 2 | 완료 | ee5864fa · Codex P2(CI phase)는 merge에서 반영, 경계 규칙·hover·--control-gap, E2E 22·Vitest GREEN |
| VIEW-1 | 2 | 완료 | c1f6235f · Codex P2(CI phase)는 merge에서 반영, 탭 시 비활성 이유 토스트, E2E 14·Vitest 138 GREEN |
| VIEW-2 | 2 | 완료 | 645934b7 · Codex P2(CI phase)는 merge에서 반영, 제출 후 focus 표시 추가, E2E 78·Vitest GREEN |
| EXPL-1 | 2 | 완료 | d99c8c46 · Codex P2(CI phase)는 merge에서 반영, rebase 후 E2E 10·Vitest 31 GREEN |
| EXPL-2 | 2 | 완료 | a52aae6c · Codex P2(옛 ID stream 차단) 수정 후 재리뷰 통과, 통합 18·pytest 18 GREEN |
| HOME-2 | 2 | 완료 | 4fdc3183 · Codex P2 수정 후 재리뷰 통과, E2E·Vitest 40 GREEN |
| HOME-3 | 2 | 완료 | 4fdc3183 · HOME-2와 함께 리뷰, E2E GREEN |
| HOME-4 | 3 | 완료 | cb854650 · Codex P2(375px 넘침) 수정 후 재리뷰 통과, E2E 44 GREEN |
| HOME-5 | 3 | 완료 | a5278ad9 · Codex P2(CI phase)는 merge에서 반영, 검색·필터 줄 재구성, E2E GREEN |
| ASK-1 | 3 | 완료 | |
| ASK-2 | 3 | 완료 | 0d5f7f05 · Codex P2(CI phase)는 merge에서 반영, E2E 88·Vitest 29 GREEN |
| EXTRACT-3 | 4 | 완료 | Codex 리뷰 반영, E2E 20 GREEN |
| EXTRACT-4 | 4 | 완료 | Codex P2 2건 수정 후 재리뷰 통과, pytest 175 GREEN |
| EXTRACT-5 | 4 | 완료 | Codex 리뷰 반영, E2E 20 GREEN |
| EXTRACT-8 | 4 | 완료 | Codex P2(CI phase)는 merge에서 반영, pytest 1415·E2E 8 GREEN |
| EXTRACT-6 | 4 | 완료 | Codex P2(CI phase)는 merge에서 반영, 원문 영역 정답 차단 추가, unit GREEN, WebKit·계약은 PR CI |
| EXTRACT-7 | 4 | 완료 | Codex P2(CI phase)는 merge에서 반영, 원문 영역 정답 차단 추가, unit GREEN, WebKit·계약은 PR CI |
| DESIGN-3 | 5 | 완료 | Codex P2 수정 후 재리뷰 통과, E2E 28 GREEN, 실기기 감각 확인 필요 |
| DESIGN-4 | 5 | 완료 | Codex P2(CI phase)는 merge에서 반영, E2E 28·lint·typecheck·unit GREEN. 라이트 tint는 대비 제약으로 옅음 |
| SHELL-2 | 5 | 완료 | Codex P2(CI phase)는 merge에서 반영, E2E 28·lint·typecheck·unit GREEN. 라이트 tint는 대비 제약으로 옅음 |
| VIEW-3 | 5 | 완료 | Codex P2(CI phase)는 merge에서 반영, 보기 끌어서 순서 변경, E2E 102·Vitest GREEN |
| EXPL-3 | 5 | 완료 | Codex P2 2건 수정 후 재리뷰 통과, migration 20261106120000 공유 DB 적용, E2E 18·계약 26 GREEN |
| VIEW-4 | 5 | 완료 | Codex P2(CI phase)는 merge에서 반영, 더보기의 원문 보기, E2E 10·lint·typecheck·unit GREEN |
| VIEW-5 | 5 | 완료 | Codex P2 수정 후 재리뷰 통과, DB 왕복 19→10·요청 2→1, 체감 속도 A/B는 미측정 |
| VIEW-6 | 5 | 완료 | Codex P2(CI phase)는 merge에서 반영, 링크 대기 표시, 첫 반응 약 450→14ms, 페이지 완료 시간은 변화 없음 |
| DOCS-2 | 5 | 완료 | Codex P2 수정 후 재리뷰 통과, E2E 22·lint·typecheck·unit GREEN |
| SHELL-3 | 6 | 완료 | Codex P2(CI phase)는 merge에서 반영, E2E 24·lint·typecheck·unit GREEN |
| SHELL-4 | 6 | 완료 | Codex P2(CI phase)는 merge에서 반영, E2E 24·lint·typecheck·unit GREEN |
| SHELL-5 | 6 | 완료 | Codex P2(CI phase)는 merge에서 반영, lint·typecheck·unit GREEN, 실기기 확인 필요 |
| SHELL-6 | 6 | 완료 | Codex P2(CI phase)는 merge에서 반영, E2E 24·lint·typecheck·unit GREEN |
| CHAPTER-1 | 7 | 완료 | Codex P2 수정 후 재리뷰 통과, lint·typecheck·unit GREEN, 일부 E2E는 PR CI |
| CHAPTER-3 | 7 | 완료 | Codex P2 수정 후 재리뷰 통과(옛 응답 형식 지적은 미배포라 기각), lint·typecheck·unit GREEN, 통합·E2E는 PR CI |
| CHAPTER-4 | 7 | 완료 | Codex P2 수정 후 재리뷰 통과(옛 응답 형식 지적은 미배포라 기각), lint·typecheck·unit GREEN, 통합·E2E는 PR CI |
| CHAPTER-5 | 7 | 완료 | Codex P2 수정 후 재리뷰 통과(옛 응답 형식 지적은 미배포라 기각), lint·typecheck·unit GREEN, 통합·E2E는 PR CI |
| CHAPTER-6 | 7 | 완료 | Codex P2 수정 후 재리뷰 통과(옛 응답 형식 지적은 미배포라 기각), lint·typecheck·unit GREEN, 통합·E2E는 PR CI |
| SHARE-1 | 8 | 완료 | Codex P2(CI phase)는 merge에서 반영, lint·typecheck·unit GREEN, 통합·E2E는 PR CI에서 확인 |
| SHARE-2 | 8 | 완료 | Codex P2(CI phase)는 merge에서 반영, lint·typecheck·unit GREEN, 통합·E2E는 PR CI에서 확인 |
| VIEW-7 | 5 | 완료 | Codex P2 3건 수정 후 재리뷰 통과, 첫 구현 E2E·화면 확인, 수정분 E2E는 PR CI |
| EXTRACT-9 | 8 | 완료 | a540c198 · Codex P1(span 메모리)·P2(CI phase) 수정 후 재리뷰 통과, 표 편집 포함, 칸 병합·해제 제외, 발문 표 28개 중 병합 18개. migration·pgTAP·E2E는 PR CI에서 확인 |
| MOCKUX-1 | 9 | 완료 | Codex P2(CI phase)는 merge에서 반영, 흔들림·하단 버튼은 Chromium 측정으로 전후 확인, lint·typecheck·unit GREEN, E2E는 PR CI에서 확인 |
| MOCKUX-2 | 9 | 완료 | Codex P1·P2는 MOCKUX-1 합류와 merge에서 반영, 모든 멤버 추가, lint·typecheck·unit GREEN, E2E는 PR CI에서 확인 |
| MOCKUX-3 | 9 | 완료 | Codex P2(CI phase)는 merge에서 반영, 공용 footer, lint·typecheck·unit GREEN, E2E는 PR CI에서 확인 |
| MOCKUX-4 | 9 | 진행 | |
| MOCKUX-5 | 9 | 진행 | |

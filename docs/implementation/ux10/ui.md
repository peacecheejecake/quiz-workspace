# UX10-UI — 공통 버튼·아이콘·스와이프 닫기

## 변경 위치

packages/ui/src/primitives/{Button,IconButton}.tsx, styles/{controls,overlays}.css, layout/{FloatingSidePanel,ModalDialog}.tsx 및 대응 test/story. AI 아이콘은 apps/web/src/components/ask/ask-icons.tsx. 실제 공통 variant를 조사해 기존 ghost/text variant의 기본 경계를 token으로 표시한다. 링크·본문 텍스트를 버튼처럼 바꾸지 않는다.

## 설계

- **개정(UX12 DESIGN-1, 2026-11-06):** 아래 규칙은 아이콘 ghost와 `borderless` ghost 버튼에는 적용하지 않는다([UX12-CONTROLS](../../screens/ux12-controls.md)). 모든 버튼은 기본 상태에서 배경 또는 테두리가 식별돼야 한다. primary는 유지하고 투명 버튼은 border token을 적용한다. hover만 테두리가 생기는 구현은 불가. disabled·selected·focus-visible·dark도 검증한다. 크기는 box-sizing:border-box로 유지한다.
- AI 질문 아이콘은 SVG viewBox와 실제 점 도형의 경계 중심을 일치시키고 inline SVG baseline 영향을 제거한다. 아이콘·문구 간격은 유지한다.
- modal panel/dialog header의 빈 영역 또는 전용 drag handle에서만 touch/pen swipe를 시작한다. 입력·버튼·본문·PDF canvas·splitter에서 시작한 이동은 닫기가 아니다.
- gesture 시작 시 panel 경계와 viewport 네 가장자리 간 거리가 가장 작은 방향을 고정한다. 동률이면 panel placement 방향을 우선하고 centered dialog는 아래 방향을 우선한다. 시작 후 resize 시 취소한다.
- 주축 이동 64px 이상 또는 이동 24px 이상·속도 0.5px/ms 이상, 반대 축 이동보다 주축 이동이 1.5배 이상일 때 닫는다. 미달·pointercancel·다중 touch는 원위치. 수치는 semantic motion/gesture 상수로 한 곳에서 관리한다.
- 최상위 overlay만 반응한다. onOpenChange 등 기존 닫기 경로를 사용해 URL/history·미저장 변경 확인·focus 복귀를 유지한다. 기존 Escape 중첩 닫기 후속 이슈도 회귀 검증한다.
- 닫기 버튼·Escape가 항상 대안이다. reduced-motion은 이동 애니메이션을 생략한다. 일반 스크롤의 preventDefault를 전역 적용하지 않는다.

## 수용 기준

- UX10-UI-AC01: light/dark에서 Button/IconButton의 기본 경계 또는 배경이 보이고(아이콘 ghost·`borderless` 제외, UX12-CONTROLS) 기존 크기·focus가 유지된다.
- UX10-UI-AC02: AI 점 아이콘의 시각 중심이 양 축에서 중앙이며 버튼 label이 유지된다.
- UX10-UI-AC03: 오른쪽 panel·하단 sheet·중앙 dialog를 정해진 방향으로 swipe하면 최상위 하나만 닫히고 시작 요소로 focus가 돌아간다.
- UX10-UI-AC04: 반대 방향·짧은 drag·본문 스크롤·텍스트 선택·splitter/PDF 조작은 닫지 않는다. cancel과 reduced-motion 동작이 정상이다.

## 검증·DoD

packages/ui unit·typecheck·check:rsc·build-storybook, web typecheck, 기존 overlay-scroll 및 panel E2E. 새 E2E 후보 tests/e2e/quality/ux10-overlays.spec.ts. Pointer Events 기반으로 Chromium/WebKit에서 검증하고 CDP는 사용하지 않는다. independent review 통과·커밋·보고까지 완료한다.

## 실행 규칙

- 이 문서의 AC를 구현 직전에 RED로 작성하고 미구현으로 실패함을 확인한 뒤 GREEN으로 만든다. AC 제목은 해당 ID로 시작한다. 기존 화면 AC는 변경된 요구만 갱신하고 나머지는 보존한다.
- 사용자 지시(2026-11-05): Task와 gpt-6.1-terra subagent를 1:1로 배정한다(effort 기본값). 독립 Codex 리뷰 통과 후 커밋하고 main thread에 보고한다. main thread가 재검증·통합·QA하며 QA 수정도 같은 모델 subagent가 수행한다.
- 구현 중 CI 실행은 생략한다. 로컬 format/lint/typecheck·관련 unit/contract/E2E는 생략하지 않는다. 모든 작업을 한 feature PR로 올려 CI GREEN까지 수정 후 develop에 병합한다. 이어 develop → main PR·병합 및 production 배포를 수행한다(사용자 승인 범위).
- 작업 브랜치·worktree를 사용하고 다른 Task scope를 수정하지 않는다. 공통 파일·migration 번호·API client 생성 충돌은 main thread에 보고한다. 공유 DB migration 적용은 main thread만 한다.
- 리뷰는 scripts/codex-review.sh --uncommitted --title "<Task ID>: <summary>"로 커밋 전에 실행한다. 수정 후 재리뷰한다. 기본 모델을 사용한다. RED 및 구현·QA 증거를 보고한다.
- semantic token·Radix·공통 FloatingSidePanel 사용, 한국어 UI, 키보드·터치 동등, reduced-motion 준수. 테스트 skip/fixme 및 API client 수동 편집 금지.

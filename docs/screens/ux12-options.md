# UX12-OPTIONS — 객관식 보기 표시

**E2E:** `tests/e2e/questions/ux12-options.spec.ts`

**Phase:** `UX12-OPTIONS.0`

**상태:** UX12 VIEW-2 신규 2026-11-06 (사용자 피드백 "객관식 보기 hover 시 radio button 더 진하게 / unselected는 더 연하게, heatmap 색상 준용, 보기 텍스트 font-weight도 크게", "정답, 내 선택, 정답입니다/오답입니다, 문구 삭제", "즐겨찾기, 다시풀기 아이콘: 선택됐을 때 아이콘 자체 fill, stroke 반전", "보기 줄바꿈 유지"). 사용자 결정 D-8([UX12 계획](../implementation/ux12/index.md)). **연계:** [QPLAY-01-AC12](questions-practice.md), [QVIEW-01-C08](question-viewer.md), [디자인 시스템](../design-system.md) §3·§4.1.

## 규칙

- **범위:** 답을 받는 `QuestionBody`(`practice`·`sequence`)의 보기 행. 다른 화면의 `Checkbox`·`RadioGroup`은 바뀌지 않는다.
- **선택 안 한 원·상자:** 평소 테두리는 `--color-option-control`(값 = Heatmap `viewed`), 행 hover는 `--color-option-control-hover`(값 = `--color-border-strong`). `--question-status-*`는 marker 전용이므로 별칭 토큰을 쓴다. 고른 보기는 accent 그대로다. `unseen` 색은 흰 표면 대비 약 1.2:1이라 쓰지 않는다(D-8).
- **보기 글자:** 행 hover 때도 굵기가 바뀌지 않는다(사용자 피드백 2026-11-07: 이전의 semibold hover와 숨긴 굵은 사본을 없앴다). 대신 선택 안 한 원·상자는 hover 때 테두리 색이 `--color-option-control-hover`가 되고 `--color-state-hover`로 채워진다(OPTION-HOVER-FILL 2026-11-07 사용자 피드백: OPTION-HOVER의 2px 테두리는 없앴고 테두리는 1px 그대로다. 고른 라디오·체크박스와 focus-visible은 바뀌지 않는다).
- **Hover:** hover가 있는 장치(`@media (hover: hover)`)에서 행 어디든 올리면 동작한다. 비활성 행은 반응하지 않는다. 키보드는 기존 focus ring을 쓴다.
- **채점 결과:** 객관식은 `정답`·`내 선택`·`정답 · 내 선택`·`정답입니다.`·`오답입니다.` 글자가 보이지 않는다. 체크·X 아이콘은 두지 않는다(RESULT-MARKS 2026-11-07 사용자 요청: 정답 보기의 체크 아이콘과 오답으로 고른 보기의 X 아이콘·테두리 제거; `data-option-mark`도 없다). 정답 보기는 색 테두리만 남고, 오답으로 고른 보기는 평범한 행이다. 행 끝 여백은 제출 전부터 그대로라 제출해도 줄바꿈과 행 위치가 그대로다. 글자는 `qz-visually-hidden`으로 남는다: 결과 문장은 `role="status"`이고, 행 표시는 radio/checkbox의 `aria-describedby`다. 숨긴 글자에는 focus ring이 보일 수 없으므로 제출 뒤 focus는 보기 영역으로 간다: 이 영역은 `role="group"`이고 이름이 결과 문장이며 키보드로 제출하면 focus ring이 보인다. 채점 대기·직접 채점 문구와 단답형·서술형의 결과 문구는 보이는 그대로다.
- **즐겨찾기·다시 풀기:** 켜진 toggle(`.qz-study-toggle[data-state='on']`)에는 `--color-state-selected` 채움이 없다. 아이콘의 fill·stroke 반전과 이름 변화가 상태를 전달한다. hover·pressed는 꺼진 toggle과 같다.
- **줄바꿈:** 보기 글자의 줄바꿈을 그대로 보인다(`white-space: pre-wrap`): 답을 받는 보기 행, 정리 노트의 문제 미리보기, 모의고사 문제 미리보기, PDF 가져오기의 원본 비교, 중복 문제 정리. 편집기 입력은 VIEW-3이다.

## 수용 기준

### UX12-OPTIONS-AC01
**행 hover:** 단일 정답·복수 정답 문제 풀이 panel에서 선택 안 한 원·상자의 테두리는 `--color-option-control`이고 글자 굵기는 regular다. 보기 행에 마우스를 올리면 테두리가 `--color-option-control-hover` 색의 1px이 되고 컨트롤이 `--color-state-hover`로 채워지며(사용자 피드백 2026-11-07) 글자 굵기는 그대로이고, 컨트롤의 크기와 행 높이는 그대로다(긴 보기 포함). 마우스가 나가면 채움이 사라지고 테두리 색이 `--color-option-control`로 돌아온다. 접근성 이름은 보기 글자 하나다.

### UX12-OPTIONS-AC02
**비활성 행:** 제출 뒤 비활성 보기 행에 마우스를 올려도 테두리와 글자 굵기가 바뀌지 않는다.

### UX12-OPTIONS-AC03
**객관식 결과 표시:** 객관식 정답 제출 뒤 고른 행에 체크 아이콘, 오답 제출 뒤 고른 행에 X, 정답 행에 체크 아이콘이 보이고 나머지 행에는 없다. `정답`·`내 선택`·`정답입니다.`·`오답입니다.`는 화면에 보이지 않지만 `role="status"`와 각 보기의 접근 가능한 설명으로 읽힌다. 제출 전후로 모든 행의 위치·크기가 같다.

### UX12-OPTIONS-AC04
**단답형·서술형 결과 문구:** 단답형 자동 채점의 `정답입니다.`, 서술형의 채점 대기 문구와 직접 채점 문구는 화면에 보인다.

### UX12-OPTIONS-AC05
**즐겨찾기·다시 풀기 toggle:** 켜면 toggle 배경은 투명 그대로이고 아이콘이 바뀌고 이름이 해제로 바뀐다. 켜진 toggle의 hover 배경은 `--color-state-hover`다.

### UX12-OPTIONS-AC06
**보기 줄바꿈:** 줄바꿈이 있는 보기는 풀이 panel에서 줄이 나뉘어 보이고 제출 뒤에도 같다.

### UX12-OPTIONS-AC07
**객관식 제출 뒤 focus:** 키보드로 객관식 답을 제출하면 focus가 보기 영역으로 옮겨 가고 그 영역에 focus ring이 보인다. 영역의 접근성 이름은 결과 문장이고 결과 문장은 `role="status"` 그대로다. `정답입니다.`·`오답입니다.`는 화면에 보이지 않는다.

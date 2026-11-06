# UX12-GESTURE — overlay를 손가락으로 끌어 닫기

**E2E:** `tests/e2e/quality/ux12-gesture.spec.ts`

**Phase:** `UX12-GESTURE.0`

**상태:** UX12 DESIGN-3 신규 2026-11-06 (사용자 피드백 "modal 스와이프해서 닫기(좁은 화면에서는 아래로, 넓은 화면에서 옆에서 뜬 모달은 사이드로) - 모달 창이 손가락을 따라 움직이다가 관성에 의해 사라지게", "보던 문제 돌아가기 floating 영역을 아래로 스와이프하여 닫기"). **결정:** D-2(시작 위치는 header와 grabber만). **연계:** [UX10-UI](ux10-ui.md) AC03·AC04, [UX11-RETURN](ux11-return.md) AC03, [UX12 계획](../implementation/ux12/index.md).

## 규칙

- **입력:** touch와 pen만. 마우스 드래그는 닫기가 아니다. 닫기 버튼과 Escape는 언제나 대안이다.
- **시작 위치:** header 어디서든(제목 글자 포함) 또는 grabber. `button`, `a`, `input`, `select`, `textarea`, `contenteditable`에서 시작하면 닫기 제스처가 아니다. 본문은 스크롤 영역이므로 시작 위치가 아니다.
- **방향:** 폭 768px 미만은 panel·dialog 모두 아래. 넓은 화면의 side panel은 떠 있는 쪽(`side`), 중앙 dialog는 아래. AppShell drawer는 왼쪽. 복귀 bar는 언제나 아래.
- **따라가기:** 8px를 넘게 움직이면 표면이 손가락을 따라 CSS `translate`로 움직인다. 반대 방향은 고무줄처럼 24px 안에서만 움직인다. 시작 방향이 주축과 어긋나면 표면은 움직이지 않고 닫히지 않는다.
- **닫기 판정:** UX10-UI의 거리·속도 기준(64px, 또는 24px와 0.5px/ms)을 넘거나, 놓는 순간의 속도로 200ms 더 간 위치가 표면 크기의 절반(최소 64px)을 넘으면 닫는다. 놓기 직전에 되돌아오는 중(-0.25px/ms보다 빠름)이면 닫지 않는다.
- **관성:** 놓는 순간의 속도로 이어서 화면 밖까지 움직인 뒤 기존 닫기 경로를 부른다. 미달·취소·거부면 제자리로 튕겨 돌아온다.
- **거부:** 저장하지 않은 입력이 있는 dialog와 panel은 backdrop 클릭처럼 스와이프로도 닫히지 않고 제자리로 돌아온다. 닫기 버튼의 동작은 그대로다.
- **축소 모션:** 따라가기와 관성 없이, 기준을 넘으면 바로 닫는다.
- **겹침:** 맨 위 overlay만 반응한다. 복귀 bar는 overlay 층이 아니고 modal이 열리면 숨겨지므로 층 판정을 하지 않는다.
- **복귀 bar:** 표면 어디서든, 버튼 위에서도 시작할 수 있다. 8px를 넘게 움직인 뒤에는 놓을 때의 click을 한 번 무시한다. 탭은 그대로 버튼을 누른다.
- 실기기 체감(속도, 고무줄, iOS Safari)은 자동 테스트로 판정할 수 없다. 사용자 기기에서 확인한다([UX12 계획](../implementation/ux12/index.md)).

## 수용 기준

### UX12-GESTURE-AC01
**손가락 따라가기:** 폭 390px에서 중앙 dialog의 제목을 아래로 끌면 놓기 전까지 표면의 `translate`가 이동 거리를 따라가고, 놓으면 사라진 뒤 여는 버튼으로 focus가 돌아간다.

### UX12-GESTURE-AC02
**방향:** 넓은 화면의 end side panel은 오른쪽, 중앙 dialog는 아래로 끌어 닫는다. side panel을 아래로 끌면 닫히지 않는다. 폭 390px의 panel은 아래, AppShell drawer는 왼쪽으로 끌어 닫는다. 닫기가 URL을 쓰는 panel은 닫힌 뒤 URL의 `panel` 값이 없다.

### UX12-GESTURE-AC03
**시작 위치:** 제목 글자에서 시작할 수 있고, header의 닫기 버튼과 본문에서 시작하면 표면이 움직이지 않는다.

### UX12-GESTURE-AC04
**돌아오기:** 기준에 못 미치는 이동, 반대 방향 이동, `pointercancel`은 닫지 않고 `translate`를 비운다. 반대 방향 이동은 24px를 넘지 않는다.

### UX12-GESTURE-AC05
**저장 안 한 입력:** 입력을 바꾼 문제 등록 dialog는 아래로 끌어도 닫히지 않고 제자리로 돌아오며 입력이 남는다.

### UX12-GESTURE-AC06
**축소 모션:** `prefers-reduced-motion`이면 끄는 동안 `translate`가 없고, 기준을 넘겨 놓으면 바로 닫힌다.

### UX12-GESTURE-AC07
**Grabber:** 폭 768px 미만의 modal panel header 위쪽 가운데에 grabber가 보이고, 여기서 시작해도 닫힌다. 넓은 화면에는 보이지 않는다.

### UX12-GESTURE-AC08
**복귀 bar:** `보던 문제로 돌아가기` 버튼 위에서 아래로 끌면 bar가 따라오다 사라지고, 풀이 화면은 열리지 않으며 닫기(X)처럼 다음 풀이 활동에서 다시 나타난다. 짧게 끌면 제자리로 돌아오고 놓을 때의 click은 무시된다.

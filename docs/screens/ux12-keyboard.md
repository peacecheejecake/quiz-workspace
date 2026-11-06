# UX12-KEYBOARD — 모바일 가상키보드와 화면 고정

**Route:** 별도 route 없음. 인증된 앱 셸(`AppFrame`)의 모든 화면

**Phase:** UX12-KEYBOARD.0
**테스트:** `tests/e2e/quality/ux12-keyboard.spec.ts` · `apps/web/test/keyboard-inset.test.tsx`

```yaml
id: UX12-KEYBOARD
linked_tests: [UX12-KEYBOARD-AC01, UX12-KEYBOARD-AC02, UX12-KEYBOARD-AC03, UX12-KEYBOARD-AC04, UX12-KEYBOARD-AC05, UX12-KEYBOARD-AC06]
```

**명세:** [UX12 SHELL-5](../implementation/ux12/index.md), [overlay-scroll](overlay-scroll.md), [UX11-RETURN-AC05](ux11-return.md), [design-system §4](../design-system.md)

사용자 피드백 "모바일 가상키보드가 올라올 때, 헤더와 본문이 위로 올라가지 않게".

## 동작 방식

- **Android Chrome 등 `interactive-widget`을 지원하는 브라우저:** `interactive-widget=resizes-content`로 layout viewport 자체가 키보드 위로 줄어든다. `dvh`, sticky, fixed가 그대로 동작하고 보정 값은 0이다.
- **iOS Safari:** `interactive-widget`을 지원하지 않는다(caniuse 기준 26.5까지 미지원, WebKit bug 259770). 키보드는 layout viewport 위를 덮고 Safari는 입력란이 보이도록 visual viewport를 옮긴다. `useKeyboardInset`이 `visualViewport`의 `resize`·`scroll`을 듣고 `--keyboard-inset`, `--keyboard-offset-top`을 넣어 표면을 눈에 보이는 영역으로 되돌린다. Safari의 이동 자체는 막을 수 없어 스크롤 중에는 표면이 잠깐 늦게 따라올 수 있다. **최선 노력**이다.

## 수용 기준

### UX12-KEYBOARD-AC01

모든 페이지의 viewport meta에 `interactive-widget=resizes-content`가 있다.

### UX12-KEYBOARD-AC02

키보드가 열리고 visual viewport가 아래로 밀려도 앱 header는 눈에 보이는 영역의 맨 위에 붙어 있다. 홈의 sticky toolbar는 그 header 아래에 있고 header에 가리지 않는다.

### UX12-KEYBOARD-AC03

모바일 side panel과 AI 질문 panel은 키보드 바로 위에 붙는다. AI 질문의 floating 입력창과 입력란은 키보드에 가리지 않고, panel 윗변은 눈에 보이는 영역 밖으로 나가지 않는다.

### UX12-KEYBOARD-AC04

modal dialog는 눈에 보이는 영역의 가운데에 놓이고 그 영역보다 커지지 않는다.

### UX12-KEYBOARD-AC05

`보던 문제로 돌아가기` 표시는 키보드에 가리지 않고 키보드 위에 뜬다.

### UX12-KEYBOARD-AC06

키보드를 닫으면 보정이 사라져 키보드를 열기 전과 같은 자리로 돌아온다. 사용자가 pinch-zoom으로 확대한 동안에는 visual viewport가 작아도 키보드로 보지 않고 보정하지 않는다.

## 실기기 확인 (Task 완료 조건)

Playwright는 실제 가상키보드를 띄울 수 없다. E2E는 `visualViewport` 값을 흉내 내어 CSS 연결만 확인하고, unit test는 계산만 확인한다. 아래는 **실기기에서만** 확인할 수 있으며 자동 test가 대신하지 않는다.

- iOS Safari(iPhone): 홈 검색란, 문제 패널, AI 질문 입력창에 focus했을 때 header, panel, 입력창 위치. 입력 중 문서 스크롤. 키보드를 닫은 뒤 원위치.
- Android Chrome: 같은 화면에서 header와 본문이 위로 밀리지 않고 레이아웃이 줄어드는지.

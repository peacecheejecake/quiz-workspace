# UX9-SCROLL — Overlay scroll 격리 (dialog·side panel 위 스와이프)

**상태:** 확정 화면 요구사항 v1.0 · UX9-SPEC 신규 2026-11-02 (사용자 피드백 "dialog가 올라와 있을 때, dialog 위를 스와이프했는데 하단에 깔린 페이지에 스크롤이 발생하는 현상 수정(ios safari에서 확인했음)"). 구현 Task UX9-SCROLL(test-first: 이 AC의 test를 먼저 RED로 확인한 뒤 고침)이 만든 test에 맞춘 ID다.
**Route:** 별도 route 없음 — Workspace 홈의 모든 floating 표면(modal dialog, non-modal floating dialog, side panel, 모바일 bottom sheet·full-screen 레이아웃)
**테스트:** `tests/e2e/workspaces/overlay-scroll.spec.ts`
**Phase:** UX9-SCROLL (RED와 구현을 한 Task에서; CI `E2E_PHASES`에는 그 Task가 merge될 때 orchestrator가 넣는다)
**연계:** [디자인 시스템](../design-system.md) §5.3, [QOV-01](questions-overview.md) 4(floating dialog), [QVIEW-01](question-viewer.md)(풀이 panel), [E2E 규칙](../e2e-strategy.md)

```yaml
id: UX9-SCROLL
route: (모든 Workspace 홈 overlay)
actor: any signed-in member
permission: read
status: confirmed
components: [ModalDialog, ConfirmDialog, FloatingSidePanel, Popover, DropdownMenu]
linked_tests: [UX9-SCROLL-AC01 … UX9-SCROLL-AC04]
```

## 규칙

- overlay 안에서 시작한 scroll은 아래 페이지로 이어지지 않는다(design-system §5.3). 공통 overscroll guard가 모든 floating 표면 — `FloatingSidePanel`(docked 제외), `ModalDialog`, `ConfirmDialog`, 모바일 drawer, `Popover`, `DropdownMenu` — 에 적용된다. pinch-zoom과 ctrl+wheel 확대는 건드리지 않는다. docked panel(DOCVIEW-01 목차)은 페이지 배치의 일부라 guard 대상이 아니다.
- overlay 밖에서 시작한 scroll은 non-modal overlay가 열려 있어도 페이지를 움직인다.

## 수용 기준

### UX9-SCROLL-AC01

- **Given:** 페이지가 세로로 scroll되는 Workspace 홈에서 modal dialog가 열린 상태
- **When:** dialog 위를 스와이프한다 — scroll하지 않는 부분(header)에서, 그리고 이미 맨 위/맨 아래에 있는 scroll 영역에서 그 끝을 넘는 방향으로; 또 아직 scroll할 수 있는 scroll 영역에서
- **Then:** 앞의 두 경우 아래 페이지는 절대 scroll되지 않는다. 아직 scroll할 수 있는 영역을 스와이프하면 그 영역만 움직인다.

### UX9-SCROLL-AC02

- **Given:** 페이지가 scroll되는 Workspace 홈에서 non-modal floating dialog(문서 관리, 모의고사 등 홈 dialog; 모바일 full-screen 레이아웃 포함)가 열린 상태
- **When:** AC01과 같은 스와이프를 dialog 위에서 한다
- **Then:** AC01과 같다: dialog의 header나 끝에 닿은 scroll 영역의 스와이프는 페이지를 scroll하지 않고, scroll할 수 있는 영역은 그 영역만 움직인다.

### UX9-SCROLL-AC03

- **Given:** 페이지가 scroll되는 Workspace 홈에서 side panel(문제 보기 panel `QuestionViewer`; 모바일 bottom sheet)이 열린 상태
- **When:** AC01과 같은 스와이프를 panel 위에서 한다
- **Then:** AC01과 같다: 페이지는 scroll되지 않고, scroll할 수 있는 panel 영역만 움직인다.

### UX9-SCROLL-AC04

- **Given:** 데스크톱 Workspace 홈에서 non-modal dialog가 열린 상태(페이지는 scroll 가능)
- **When:** dialog의 header 위에서, 그리고 끝까지 scroll한 dialog 본문 위에서 그 끝을 넘는 방향으로 wheel/trackpad scroll하고; dialog 옆의 페이지 위에서 wheel scroll한다
- **Then:** dialog 위의 wheel/trackpad scroll은 header에서도 본문 끝을 넘어서도 페이지를 scroll하지 않는다. dialog 옆의 페이지는 그대로 scroll된다.

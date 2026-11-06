# UX10-UI — 공통 버튼과 overlay 제스처

**Route:** 공통 UI · **Phase:** UX10-UI.0
**테스트:** `tests/e2e/workspaces/ux10-overlays.spec.ts`

```yaml
id: UX10-UI
route: (공통 UI)
actor: any signed-in member
permission: read
status: confirmed
components: [Button, IconButton, FloatingSidePanel, ModalDialog]
linked_tests: [UX10-UI-AC01, UX10-UI-AC02, UX10-UI-AC03, UX10-UI-AC04]
```

### UX10-UI-AC01

light/dark의 Button과 IconButton은 기본 경계 또는 배경을 표시하고 크기와 focus를 유지한다. **개정(UX12 DESIGN-1, 2026-11-06):** 아이콘 ghost와 `borderless` ghost 버튼만 경계 없이 둘 수 있다([UX12-CONTROLS](ux12-controls.md)). 그 밖의 컨트롤은 그대로 경계를 유지한다.
### UX10-UI-AC02

AI 질문의 기존 말풍선 안 표시 중심은 SVG 중심과 일치하며 label을 유지한다.
### UX10-UI-AC03

modal header를 정해진 방향으로 swipe하면 최상위 overlay 하나만 닫고 focus를 돌려준다. **개정(UX12 DESIGN-3, 2026-11-06):** 시작 위치는 header 전체(제목 글자 포함)와 grabber이고, 방향은 가장 가까운 가장자리가 아니라 폭 768px 미만은 아래, 넓으면 side panel은 `side` 쪽, 중앙 dialog는 아래다. 표면은 손가락을 따라 움직이다 관성으로 사라진다([UX12-GESTURE](ux12-gesture.md)).
### UX10-UI-AC04

반대 방향·짧은 이동·본문 스크롤·선택·splitter/PDF 조작은 닫지 않는다. 취소와 reduced motion도 동작한다. **개정(UX12 DESIGN-3, 2026-11-06):** 닫지 않는 이동은 표면을 제자리로 되돌린다. header 안의 버튼과 입력에서 시작한 이동도 닫지 않는다. 저장하지 않은 입력이 있으면 기준을 넘겨도 닫지 않는다([UX12-GESTURE](ux12-gesture.md)).

세부 조건은 [구현 기준](../implementation/ux10/ui.md)을 따른다.

# UX10-UI — 공통 버튼과 overlay 제스처

**Route:** 공통 UI · **Phase:** UX10-UI
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

light/dark의 Button과 IconButton은 기본 경계 또는 배경을 표시하고 크기와 focus를 유지한다.
### UX10-UI-AC02

AI 질문의 기존 말풍선 안 표시 중심은 SVG 중심과 일치하며 label을 유지한다.
### UX10-UI-AC03

modal header 빈 공간을 가장 가까운 viewport 가장자리 방향으로 swipe하면 최상위 overlay 하나만 닫고 focus를 돌려준다.
### UX10-UI-AC04

반대 방향·짧은 이동·본문 스크롤·선택·splitter/PDF 조작은 닫지 않는다. 취소와 reduced motion도 동작한다.

세부 조건은 [구현 기준](../implementation/ux10/ui.md)을 따른다.

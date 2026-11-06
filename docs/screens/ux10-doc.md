# UX10-DOC — 전체 높이 문서 뷰어

```yaml
id: UX10-DOC
route: (DOC-02) /workspaces/:workspaceId/documents/:documentId · (WS-VIEW-01) /share/:shareId
actor: workspace_member · share_guest
permission: read
status: confirmed
api: []
linked_tests: [UX10-DOC-AC01, UX10-DOC-AC02, UX10-DOC-AC03, UX10-DOC-AC04, UX10-DOC-AC05]
```

**테스트:** `tests/e2e/documents/documents-viewer-layout.spec.ts`

**Phase:** UX10-DOC.0

**연계:** [구현 기준](../implementation/ux10/doc.md), [DOCVIEW-01](documents-viewer-layout.md), [DOC-02](documents-editor.md), [WS-VIEW-01](workspace-shared-view.md)

이 기준은 DOCVIEW-01의 이전 보기 방식·모바일 단일 pane 요구보다 우선한다.

### UX10-DOC-AC01

저장값이 없거나 손상되면 원본만 보인다. 명시된 기존 설정은 유지하며 두 checkbox 중 하나 이상 선택한다. 저장이 차단되어도 현재 탭에서 동작한다.

### UX10-DOC-AC02

모바일에서도 두 pane을 상하로 함께 볼 수 있으며 회전·resize 때 문서 상태와 데스크톱 방향을 유지한다. splitter로 조정한 원본의 비율은 pane 위치를 바꿔도 유지한다. splitter의 양 끝에서도 각 pane header와 읽기 영역이 화면 높이가 허용하는 범위에서 남는다.

### UX10-DOC-AC03

문서와 공유 host에서 viewer가 전체 viewport 높이를 채우고 작은 높이와 safe area에서도 페이지가 불필요하게 scroll되지 않는다. 작은 높이의 모바일·태블릿·데스크톱에서 고정된 chrome은 자체 scroll하며 두 pane과 교정 저장 동작을 사용할 공간을 남긴다. 보관된 Workspace의 읽기 전용·복원 안내는 chrome 안에 유지한다.

### UX10-DOC-AC04

3초 후 도구가 숨고 pointer·touch·keyboard로 복원한다. focus·menu·교정·중요 경고가 있으면 숨지 않는다. 터치 탭과 glass 표면은 [UX12-PDFPREVIEW](ux12-pdf-preview.md)가 정한다.

### UX10-DOC-AC05

목차·PDF/text 동기화·splitter·zoom·교정·발행·고정 revision·공유 읽기 전용 기능을 유지한다.

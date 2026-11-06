# UX12-EXTRACT — 초안 문제 전체 표시

**Route:** `/workspaces/:workspaceId/documents/:documentId`

**Phase:** UX12-EXTRACT.0
**테스트:** `tests/e2e/documents/ux12-extract.spec.ts`

```yaml
id: UX12-EXTRACT
linked_tests: [UX12-EXTRACT-AC01, UX12-EXTRACT-AC02]
```

**명세:** [UX12 EXTRACT](../implementation/ux12/index.md), [DOC-02](documents-editor.md), [questions.md §6](../questions.md)

표 안 소제목처럼 문제 안의 heading은 목차 구역을 만든다. 확정 전 문제는 이 구역 상자만 표시되어 발문이 빠진 조각으로 보였다. 구역 구조는 바꾸지 않고 표시만 고친다.

### UX12-EXTRACT-AC01

확정 전 초안의 출처 블록을 고르면(목차 행, 변환본 블록) PDF 원문 위치는 그 블록이나 구역이 아니라 초안 문제의 발문부터 보기까지 전체를 쪽마다 상자 하나로 표시한다. 초안의 출처가 아닌 블록은 이전과 같다. 초안의 원문 블록은 문제 카드로 바뀌지 않는다(DOC-02-AC11). 문제 영역 옆이나 위의 이미지(여백 장식)는 상자를 늘리지 않는다.

### UX12-EXTRACT-AC02

뷰어가 쓰는 초안 정보는 블록 id뿐이다. `draft-summaries`는 `include_blocks=true`일 때만 `block_ids`를 싣고(없으면 키 자체가 없다) 어느 경우에도 발문, 보기, 정답, 해설을 싣지 않는다. Workspace 구성원이 아니면 404다.

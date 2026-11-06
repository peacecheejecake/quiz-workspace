# UX12-SPANS — 표 병합 셀

**Route:** `/workspaces/:workspaceId/documents/:documentId`

**Phase:** UX12-SPANS.0
**테스트:** `tests/e2e/documents/ux12-spans.spec.ts`

```yaml
id: UX12-SPANS
linked_tests: [UX12-SPANS-AC01, UX12-SPANS-AC02, UX12-SPANS-AC03]
```

**명세:** [UX12 EXTRACT-8](../implementation/ux12/index.md), [DOC-02](documents-editor.md)

파서는 병합 셀을 격자의 모든 칸에 같은 글자로 채운다. 이 격자는 그대로 두고 `table.spans`에 병합 범위를 함께 저장한다. `spans`는 선택 필드다. 이전에 파싱한 revision은 `spans`가 없고 다시 파싱할 때까지 전과 같이 보인다. 파서 버전 변경이 재파싱을 일으키지는 않는다.

### UX12-SPANS-AC01

문서 보기 표는 `spans`에 있는 병합 셀을 한 칸으로 표시한다. 시작 칸 하나만 `colSpan`, `rowSpan`을 갖고 가려진 칸은 그리지 않는다. 같은 글자가 반복되지 않는다. 블록 API는 `table.spans`로 각 병합의 `row`, `col`, `row_span`, `col_span`을 내려준다. `rows`는 전과 같이 직사각형 격자다.

### UX12-SPANS-AC02

`spans`가 없는 표는 전과 같이 모든 칸을 하나씩 표시한다. 블록 API의 `table.spans`는 `null`이다.

### UX12-SPANS-AC03

표 텍스트 편집은 칸을 다시 나누므로 병합 범위를 버린다. 저장한 뒤에는 병합 없는 격자로 표시한다. 글자를 바꾸지 않은 저장은 아무것도 바꾸지 않아 병합이 그대로 남는다.

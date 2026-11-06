# UX12-RUNBAR — 범위 풀이의 제출·이전·다음 버튼

**Route:** `/workspaces/:workspaceId?practice=<id>&i=<k>`

**Phase:** UX12-RUNBAR.0
**테스트:** `tests/e2e/questions/ux12-run-buttons.spec.ts`

```yaml
id: UX12-RUNBAR
linked_tests: [UX12-RUNBAR-AC01 … UX12-RUNBAR-AC04]
```

**명세:** [UX12 MOCKUX-3](../implementation/ux12/index.md) (사용자 요청 2026-11-06), [QVIEW-01](question-viewer.md), [UX12-VIEW](ux12-viewer.md)

범위 풀이와 모의고사 풀이(`sequence`)의 footer는 Heatmap 셀로 연 풀이 panel(`practice`)과 같다. 두 경로는 footer 부품(`question-footer.tsx`의 `QuestionNav`, `AnotherTryButton`)을 같이 쓴다. 범위 풀이에만 있는 것은 마지막 위치의 `결과 보기`다. `초기화`는 풀이 panel에만 있다.

### UX12-RUNBAR-AC01

`sequence`의 footer 순서는 풀이 panel과 같다: `제출`, 직접 채점(`맞음`·`틀림`), `다시 풀기`, 그 뒤 오른쪽 끝의 `문제 이동` 영역에 `이전 문제`·`다음 문제` 화살표. 두 화살표는 이름, 모양(ghost), 크기가 풀이 panel과 같고 제출 뒤에도 강조(primary)가 없다. `이전`, `다음`, `건너뛰기`라는 이름은 없다.

### UX12-RUNBAR-AC02

양 끝에서 화살표는 사라지지 않고 `aria-disabled`로 남아 focus를 유지한다. 첫 위치의 `이전 문제`와 마지막 위치의 `다음 문제`가 그렇다. 마지막 위치에는 `다시 풀기` 뒤에 `결과 보기`가 있고, 화살표의 자리는 다른 위치와 같다. `결과 보기`는 답할 수 있는 동안 기본(secondary), 답한 뒤에는 primary다. 제출이나 직접 채점이 진행 중이면 화살표는 `aria-disabled`, `결과 보기`는 `disabled`다.

### UX12-RUNBAR-AC03

답하지 않은 위치에서 `다음 문제`를 누르면 제출 없이 다음 위치로 가고, 그 위치는 결과 요약에서 "건너뜀"으로 센다. 별도의 `건너뛰기` 버튼은 없다.

### UX12-RUNBAR-AC04

`sequence` footer의 `다시 풀기`는 [UX12-VIEW-AC04](ux12-viewer.md)를 따른다. 결과가 확정되기 전(제출 전, 직접 채점 대기, 제출 중)에는 `aria-disabled`이고 눌러도 아무 일이 없으며, 같은 이유를 접근성 설명, tooltip, toast로 알린다. 결과가 확정되면 같은 패널에서 그 위치를 다시 푼다([UX12-RETRYINPLACE](ux12-retry-in-place.md)). 끝난 묶음에서 건너뛴 위치는 제출할 길이 없으므로 처음부터 활성이다. 보관된 Workspace와 풀 수 없는 위치에는 그리지 않는다.

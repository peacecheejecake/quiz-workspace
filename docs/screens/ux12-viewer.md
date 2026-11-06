# UX12-VIEW — 문제 보기 컨트롤

**Route:** `/workspaces/:workspaceId?question=<id>`, `/workspaces/:workspaceId?practice=<id>&i=<k>`

**Phase:** UX12-VIEW.0
**테스트:** `tests/e2e/questions/ux12-viewer.spec.ts`

```yaml
id: UX12-VIEW
linked_tests: [UX12-VIEW-AC01 … UX12-VIEW-AC06]
```

**명세:** [UX12 VIEW-1](../implementation/ux12/index.md) (결정 D-8), [UX10-QVIEW](ux10-qview.md), [RETRY-01](retry-correct.md), [QVIEW-01](question-viewer.md)

### UX12-VIEW-AC01

범위 풀이·모의고사(`sequence`)의 `이전`·`다음`·`건너뛰기`는 풀이 panel과 같은 화살표 버튼이고(`NavButton` 공유) 높이가 `제출`과 같다. 접근성 이름은 그대로다. 첫 위치의 `이전`은 사라지지 않고 `aria-disabled`로 focus를 유지한다. 답이 있는 위치의 `다음`은 강조(primary) 그대로다. 글자 버튼 `결과 보기`는 글자를 유지하고 높이만 같다. UX10-QVIEW-AC02를 `sequence`로 넓힌다.

### UX12-VIEW-AC02

풀이 panel footer의 `다시 풀기`는 범위 풀이와 같은 기본(secondary) 버튼이다: 배경색과 테두리가 있다.

### UX12-VIEW-AC03

풀이 panel의 `초기화`는 지울 결과가 있을 때만 보인다. 이번 panel의 결과, 마지막 채점 결과, 채점 대기 제출 중 하나가 있어야 한다. 한 번도 제출하지 않은 문제에서는 DOM에 없고, `다시 풀기`로 새로 푸는 동안에는 남는다.

### UX12-VIEW-AC04

풀이 panel footer의 `다시 풀기`(D-8)는 문제를 푸는 동안 항상 보인다. 결과가 확정되기 전(제출 전, 불러오는 중, 직접 채점 대기)에는 `aria-disabled`이고 눌러도 아무 일이 없으며, 이유 "답안을 제출하고 채점이 끝나면 다시 풀 수 있습니다."를 접근성 설명과 tooltip(hover·키보드 focus)으로 알리고, 누르면(탭·클릭) 같은 문구를 실행 버튼 없는 toast로 보인다(터치에는 tooltip이 없다). 상시 보이는 안내 문구는 두지 않는다. 보관된 Workspace에는 풀이가 없으므로 그리지 않는다. header의 `다시 풀기` toggle은 이 AC와 무관하게 RETRY-01을 따른다(정답 뒤에만 렌더링).

### UX12-VIEW-AC05

제출된 문제를 해설이 보이는 상태로 다시 열면 panel 본문은 맨 위에서 시작하고 focus를 결과로 옮기지 않는다. 방금 제출한 경우에는 예전처럼 focus가 결과로 간다(객관식은 UX12-OPTIONS-AC07의 보기 묶음).

### UX12-VIEW-AC06

`sequence`에서 위치를 옮기면 panel 본문은 맨 위에서 시작한다. `FloatingSidePanel`의 `scrollKey`가 바뀔 때 본문 스크롤을 처음으로 돌린다.

**E2E:** `tests/e2e/questions/ux12-viewer.spec.ts`

# UX12-PLAY — 풀기 옵션의 이름

**Route:** `/workspaces/:workspaceId?panel=mock-exams&mock=new`

**Phase:** UX12-PLAY.0
**테스트:** `tests/e2e/questions/ux12-play.spec.ts`

```yaml
id: UX12-PLAY
linked_tests: [UX12-PLAY-AC01]
```

**명세:** [UX12 PLAY-1](../implementation/ux12/index.md), [MOCK-01](mock-exams.md), [UX10-PLAY](ux10-play.md)

### UX12-PLAY-AC01

변형 유형을 하나도 고르지 않은 원본 풀이는 이름을 저장하지 않으므로 `이름`을 보이지 않고 요구하지 않는다. 변형 유형을 고르면 `이름`이 필수로 나타나고, 고른 유형을 모두 풀면 다시 사라지며 `시작`을 막지 않는다(단계 순서는 [UX12-MOCKFORM2](ux12-mock-form-order.md)).

**E2E:** `tests/e2e/questions/ux12-play.spec.ts`

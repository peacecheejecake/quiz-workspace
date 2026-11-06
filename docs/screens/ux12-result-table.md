# UX12-RESULTTABLE — 풀이 결과 표

**Route:** `/workspaces/:workspaceId?practice=<id>&view=results` (원본 풀이, 모의고사 풀이 공통)

**Phase:** UX12-RESULTTABLE.0
**테스트:** `tests/e2e/questions/ux12-result-table.spec.ts` (단위: `apps/web/test/ux12-result-table.test.tsx`)

```yaml
id: UX12-RESULTTABLE
linked_tests: [UX12-RESULTTABLE-AC01, UX12-RESULTTABLE-AC02, UX12-RESULTTABLE-AC03, UX12-RESULTTABLE-AC04, UX12-RESULTTABLE-AC05]
```

**명세:** [UX12 MOCKUX-14](../implementation/ux12/index.md), [QVIEW-01 끝과 결과 요약](question-viewer.md)

사용자 요청(2026-11-06): 결과 화면에서 문제별 발문을 지우고, 문제 번호를 가로로 펼친 표에 O/X를 표기한다. hover 때 번호와 결과 칸의 배경이 바뀌고, 누르면 그 문제로 이동한다.

정해진 내용(MOCKUX-14 위임 결정):

- **표 구조:** 문제 하나가 세로 한 칸(위 번호, 아래 결과)이다. 장 묶음은 지금처럼 유지해 장마다 표 하나를 그린다. 칸은 패널 너비에 맞춰 여러 줄로 내려가고, 가로 스크롤은 없다.
- **보조 기술:** 표는 `role="table"`이다. 칸이 CSS로 줄바꿈되므로 문제 하나가 표의 한 행이고, 번호가 행 머리글(`rowheader`), 결과가 셀이다. 칸 전체가 버튼 하나이고 이름은 "3번 맞음, 문제로 이동"처럼 번호, 결과 낱말, 동작을 말한다.
- **키보드:** Tab으로 칸을 차례로 지나고 Enter·Space로 연다. 방향키 이동은 넣지 않는다: 칸 수가 패널 너비에 따라 바뀌고, Tab 순서를 줄이지 못하면 이득이 없다.
- **표시:** `O` 맞음, `X` 틀림, `대기` 채점 대기, `–` 건너뜀, `초기화` 초기화됨, `–` 아직 풀지 않음, `불가` 더 이상 풀 수 없는 문제. 번호는 지금 목록의 표시(`positionLabel`) 그대로다: 원본 풀이는 문제 번호, 모의고사는 `문제 k`. `불가` 칸이 있는 장에는 표 아래에 "불가: 더 이상 풀 수 없는 문제"를 보인다.
- **색:** 칸 배경은 불투명한 `--color-surface`라서 glass 위에서도 대비가 그대로다. `O`·`X`는 `--color-success`·`--color-danger`다. hover·focus 배경 `--color-state-hover` 위에서는 AA를 지키려고 글자를 `--color-text-primary`로 바꾼다.
- **불러오기:** 지금처럼 200개씩 읽고 `결과 더 보기`로 잇는다. 5,000문제 풀이도 처음에는 200칸만 그린다.
- **데이터:** API는 그대로다. 결과 응답의 `preview`는 화면에 쓰지 않을 뿐 남겨 둔다. 새로 받는 데이터는 없다.

### UX12-RESULTTABLE-AC01

결과 단계는 요약 "맞음 x · 틀림 y · 채점 대기 z · 건너뜀 w" 아래에 장마다 표 하나를 보인다. 문제 하나가 칸 하나이고 번호가 위, 결과가 아래에 있다. 문제 발문은 어디에도 보이지 않는다. 표에는 이름이 있고, 번호는 행 머리글, 결과는 셀이다.

**E2E:** `tests/e2e/questions/ux12-result-table.spec.ts`

### UX12-RESULTTABLE-AC02

맞은 문제는 `O`, 틀린 문제는 `X`, 채점 대기는 `대기`, 건너뛴 문제는 `–`로 표시한다. 칸마다 버튼 하나가 있고 그 이름은 번호, 결과 낱말, "문제로 이동"을 말한다. 결과 셀의 이름도 결과 낱말이다.

**E2E:** `tests/e2e/questions/ux12-result-table.spec.ts`

### UX12-RESULTTABLE-AC03

칸에 pointer를 올리거나 키보드로 focus하면 번호와 결과 두 칸의 배경이 같은 색으로 바뀌고, 다른 칸은 그대로다. 결과 칸 위에서도 같고, 결과 칸을 눌러도 그 문제로 이동한다.

**E2E:** `tests/e2e/questions/ux12-result-table.spec.ts`

### UX12-RESULTTABLE-AC04

칸을 누르면 같은 묶음의 그 위치(`?practice=<id>&i=<k>`)가 읽기 전용으로 열린다. 제출 버튼은 없고 제출한 결과가 보인다. 뒤로 가면 결과 표로 돌아온다. 키보드로 칸에 가서 Enter를 눌러도 같다.

**E2E:** `tests/e2e/questions/ux12-result-table.spec.ts`

### UX12-RESULTTABLE-AC05

문제가 많은 풀이는 표가 패널 너비 안에서 여러 줄로 내려가고, 375px 폭에서도 패널과 페이지에 가로 스크롤이 없다. 더 이상 풀 수 없는 문제는 `불가`로 표시되고 그 장의 표 아래에 "불가: 더 이상 풀 수 없는 문제"가 보이며, 눌러서 열 수 있다. 모의고사 풀이는 같은 표를 쓰고 번호는 `문제 k`다.

**E2E:** `tests/e2e/questions/ux12-result-table.spec.ts`

# UX12-RUNASK — 모의고사 풀이의 `질문하기`는 채점 뒤에

**Route:** `/workspaces/:workspaceId?practice=<id>&i=<k>`

**Phase:** UX12-RUNASK.0
**테스트:** `tests/e2e/ask/ux12-run-ask.spec.ts`

```yaml
id: UX12-RUNASK
linked_tests: [UX12-RUNASK-AC01]
```

**명세:** UX12 MOCKUX-6 (사용자 요청 2026-11-06), [ASK-01](ask-llm.md) "문제 쪽 진입점", [QVIEW-01](question-viewer.md), [MOCK-01](mock-exams.md)

사용자 요청: 문제를 풀기 전에는 `질문하기` 버튼을 없앤다. 사용자 결정 2026-11-01의 "모의고사 문제는 제출 전에도 버튼을 보이고 `hint`"를 바꾼다.

- `sequence(mock)` header의 `질문하기`는 현재 위치가 제출되고 채점이 끝난 뒤에만 보인다. 답을 고르는 동안과 채점 대기(직접 채점 전)에는 렌더링하지 않는다.
- 제출한 위치로 `이전 문제`로 돌아온 읽기 전용 화면에도 있다.
- `manage(mock)`와 문제 상세(`manage`)는 정답을 이미 보이므로 그대로다.
- 서버의 `hint` 규칙과 API는 바꾸지 않는다. 화면이 제출 전 문제를 첨부하는 길이 없어질 뿐이고, 첨부를 API로 직접 만들면 지금처럼 `hint`다(ASK-01-C03·C10).

## 수용 기준

### UX12-RUNASK-AC01

- **Given:** 문제 2개로 만든 모의고사의 풀이 첫 위치
- **When:** 보기를 고르고, 제출하고, 다음 문제로 갔다가 `이전 문제`로 돌아온다
- **Then:** 보기를 고른 뒤에도 `질문하기`가 없고, 제출해 채점되면 나타나며, 아직 풀지 않은 다음 문제에는 없고, 돌아온 위치에는 다시 있다. 눌러서 연 대화는 "제출 후 — 정답·해설 포함"이다.

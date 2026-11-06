# UX12-REEXTRACT — 다시 추출

**Route:** `/workspaces/:workspaceId/questions/import?document=:documentId` (문제 검토)

**Phase:** UX12-REEXTRACT.0
**테스트:** `tests/e2e/questions/ux12-reextract.spec.ts` (계약: `tests/integration/questions/test_question_reextract.py`)

```yaml
id: UX12-REEXTRACT
linked_tests: [UX12-REEXTRACT-AC01, UX12-REEXTRACT-AC02, UX12-REEXTRACT-AC03]
```

**명세:** [UX12 EXTRACT-6](../implementation/ux12/index.md), [QIMPORT-01](questions-import.md), [questions.md §6](../questions.md)

추출기를 고쳐도 이미 만든 초안과 문제는 그대로다. `POST /question-imports`는 활성 revision의 run에 붙고, `/retry`는 실패·취소한 run만 받는다. `다시 추출`(D-11)은 같은 문제 PDF를 현재 추출기로 다시 읽어 새 run과 새 초안을 만든다. 파싱은 다시 하지 않는다. 저장된 파싱 결과를 읽고, 없으면 revision의 블록을 읽는다.

- **등록된 문제는 그대로다.** 발문, 보기, 정답, 풀이 기록, 출처를 바꾸지 않는다. 새 초안은 사람이 고르고 등록해야 문제가 된다(AGENTS.md §5).
- **이전 초안은 새 초안으로 옮기지 않는다.** 이전 run과 초안은 지우지 않고, 검토 화면은 PDF의 최신 run을 보인다. 등록하지 않은 초안에서 고친 내용은 새 초안에 없으므로 확인 dialog가 먼저 알린다.
- **변경 판정:** 새 초안을 같은 문서의 이전 run 초안과 추출 id(문제 번호 + 같은 번호의 몇 번째인지)로 짝짓는다. 이전 초안이 살아 있는 확정 문제로 등록돼 있으면 그 문제의 현재 내용과, 아니면 이전 초안과 비교한다. 비교는 §10.1 정규화를 쓰고 대상은 유형, 발문, 보기(순서 무관), 정답이다. fingerprint는 객관식 정답을 보지 않으므로, 발문이 같고 정답만 달라도 `중복`과 함께 `변경됨`이 붙는다.
- **교체 경로:** 발문이 달라지면 fingerprint가 달라 중복으로 잡히지 않는다. 그래서 변경된 초안은 대응하는 이전 문제를 보이고, 사용자가 보관한다. 새 초안 등록과 이전 문제 보관은 각자 사람이 고르는 별개 동작이며, 어느 쪽도 다른 쪽을 자동으로 하지 않는다.

### UX12-REEXTRACT-AC01

추출이 끝난 PDF의 문제 검토에서 편집 권한 구성원에게 `다시 추출` 버튼이 보인다. 누르면 "등록된 문제는 바뀌지 않고, 등록하지 않은 초안에서 고친 내용은 새 초안으로 옮겨지지 않는다"는 확인 dialog가 열리고, 확인하면 추출 진행을 표시한 뒤 새 초안 목록을 보인다. 새 초안은 모두 미등록이고, 등록된 문제의 발문과 정답은 전과 같다. 보기 권한 구성원에게는 버튼이 없다.

### UX12-REEXTRACT-AC02

다시 추출한 검토 화면은 달라진 것을 글로 보인다. 목록 위에 `다시 추출 결과: 변경 n개 · 새 문제 n개 · 같음 n개`, 이전에 있었지만 이번에 없는 문제가 있으면 그 번호를 보인다. 이전 문제와 다른 초안에는 `변경됨` 표시, 대응하는 이전 문제 번호, 달라진 항목(`유형`, `발문`, `보기`, `정답`)이 있고 `이전 문제 보기` 링크가 그 문제의 풀이 panel을 연다. 대응하는 이전 문제가 없는 초안에는 `새 문제`가 보인다. 내용이 같은 초안에는 `변경됨`이 없고 기존 `중복` 표시가 그대로다.

### UX12-REEXTRACT-AC03

`변경됨` 초안의 `이전 문제 보관`은 확인 dialog를 거쳐 그 문제 하나만 보관한다. 초안은 그대로 미등록이고 다른 문제와 정답은 바뀌지 않는다. 보관한 뒤 그 초안은 이전 문제를 가리키지 않는다. 보기 권한 구성원에게는 `이전 문제 보관`이 없다.

## 계약 요구사항 (pytest, 화면 AC 아님)

| ID | 요구사항 |
|---|---|
| UX12-REEXTRACT-C01 | `POST /question-imports/{id}/re-extract`(편집 권한) → 202 새 run. 같은 문서·같은 revision에 고정되고 `reextract_of`가 원래 run을 가리키며 `document.parse` job을 만들지 않는다. 끝나면 새 초안이 생기고 이전 초안, 등록된 문제의 revision과 출처, `published_question_id`는 그대로다. |
| UX12-REEXTRACT-C02 | `Idempotency-Key`가 같으면 같은 run을 돌려준다(job 재발행 포함). 같은 문서에 진행 중인 run이 있으면 다시 추출과 실패한 run의 `retry`는 409 `import-running`이고 run을 만들지 않는다. 문서 행 FOR UPDATE로 직렬화한다. |
| UX12-REEXTRACT-C03 | 보기 권한 403 `insufficient-role`, 보관된 Workspace 403 `workspace-archived`, 비구성원과 다른 Workspace는 같은 404. 문서가 삭제됐거나 처리 중이면 409 `document-not-ready`. |
| UX12-REEXTRACT-C04 | `ImportDraft`와 `ImportDraftSummary`의 `previous`는 다시 추출한 run에서만 값이 있다: `{question_id, revision_id, number, changed}`. `question_id`는 살아 있는 확정 문제가 있을 때만 있고 `changed`는 `type`·`stem`·`options`·`answer` 순서의 목록이다. 짝이 없으면 null. 요약에는 정답 값이나 발문이 없다. `draft-summaries`의 `missing_previous`는 이번 run에 없는 이전 문제 번호다. |

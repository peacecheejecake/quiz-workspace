# UX12-REEXTRACT — 다시 추출과 문제 그림

**Route:** `/workspaces/:workspaceId/questions/import?document=:documentId` (문제 검토)

**Phase:** UX12-REEXTRACT.0
**테스트:** `tests/e2e/questions/ux12-reextract.spec.ts` (계약: `tests/integration/questions/test_question_reextract.py`)

```yaml
id: UX12-REEXTRACT
linked_tests: [UX12-REEXTRACT-AC01, UX12-REEXTRACT-AC02, UX12-REEXTRACT-AC03, UX12-REEXTRACT-AC04, UX12-REEXTRACT-AC05]
```

**명세:** [UX12 EXTRACT-6·7](../implementation/ux12/index.md), [QIMPORT-01](questions-import.md), [QSRC-01](question-source-preview.md), [questions.md §6·§16](../questions.md)

추출기를 고쳐도 이미 만든 초안과 문제는 그대로다. `POST /question-imports`는 활성 revision의 run에 붙고, `/retry`는 실패·취소한 run만 받는다. `다시 추출`(D-11)은 같은 문제 PDF를 현재 추출기로 다시 읽어 새 run과 새 초안을 만든다. 파싱은 다시 하지 않는다. 저장된 파싱 결과를 읽고, 없으면 revision의 블록을 읽는다.

- **등록된 문제는 그대로다.** 발문, 보기, 정답, 풀이 기록, 출처를 바꾸지 않는다. 새 초안은 사람이 고르고 등록해야 문제가 된다(AGENTS.md §5).
- **이전 초안은 새 초안으로 옮기지 않는다.** 이전 run과 초안은 지우지 않고, 검토 화면은 PDF의 최신 run을 보인다. 등록하지 않은 초안에서 고친 내용은 새 초안에 없으므로 확인 dialog가 먼저 알린다.
- **변경 판정:** 새 초안을 같은 문서의 이전 run 초안과 추출 id(문제 번호 + 같은 번호의 몇 번째인지)로 짝짓는다. 이전 초안이 살아 있는 확정 문제로 등록돼 있으면 그 문제의 현재 내용과, 아니면 이전 초안과 비교한다. 비교는 §10.1 정규화를 쓰고 대상은 유형, 발문, 보기(순서 무관), 정답이다. fingerprint는 객관식 정답을 보지 않으므로, 발문이 같고 정답만 달라도 `중복`과 함께 `변경됨`이 붙는다.
- **교체 경로:** 발문이 달라지면 fingerprint가 달라 중복으로 잡히지 않는다. 그래서 변경된 초안은 대응하는 이전 문제를 보이고, 사용자가 보관한다. 새 초안 등록과 이전 문제 보관은 각자 사람이 고르는 별개 동작이며, 어느 쪽도 다른 쪽을 자동으로 하지 않는다.

### UX12-REEXTRACT-AC01

추출이 끝난 PDF의 문제 검토에서 편집 권한 구성원에게 `다시 추출` 버튼이 보인다. 누르면 "등록된 문제는 바뀌지 않고, 등록하지 않은 초안에서 고친 내용은 새 초안으로 옮겨지지 않는다"는 확인 dialog가 열리고, 확인하면 추출 진행을 표시한 뒤 새 초안 목록을 보인다. 새 초안은 모두 미등록이고, 등록된 문제의 발문과 정답은 전과 같다. 보기 권한 구성원에게는 버튼이 없다.

### UX12-REEXTRACT-AC02

다시 추출한 검토 화면은 달라진 것을 글로 보인다. 목록 위에 `다시 추출 결과: 변경 n개 · 새 문제 n개 · 같음 n개`, 이전에 있었지만 이번에 없는 문제가 있으면 그 번호를 보인다. 이전 문제와 다른 초안에는 `변경됨` 표시, 대응하는 이전 문제 번호, 달라진 항목(`유형`, `발문`, `표`, `보기`, `정답`)이 있고 `이전 문제 보기` 링크가 그 문제의 풀이 panel을 연다. 대응하는 이전 문제가 없는 초안에는 `새 문제`가 보인다. 내용이 같은 초안에는 `변경됨`이 없고 기존 `중복` 표시가 그대로다.

### UX12-REEXTRACT-AC03

`변경됨` 초안의 `이전 문제 보관`은 확인 dialog를 거쳐 그 문제 하나만 보관한다. 초안은 그대로 미등록이고 다른 문제와 정답은 바뀌지 않는다. 보관한 뒤 그 초안은 이전 문제를 가리키지 않는다. 보기 권한 구성원에게는 `이전 문제 보관`이 없다.

## 문제 그림 (EXTRACT-7)

그림은 글로 옮겨지지 않아 풀이 화면에서 `문제 원문 보기`를 눌러야 보였다. D-11에 따라 문제의 그림을 PDF 영역 그대로 보기 위에 보인다. 저장하는 crop은 없고 migration도 없다. 그림은 [QSRC-01](question-source-preview.md)의 `PdfRegions`로 그리므로 잘린 영역 밖은 DOM과 canvas 어디에도 없고, 글 layer도 없다.

**어떤 그림인가:** 가져오기 출처 행의 위치 중 `block_id`가 있고(첫 근거가 아닌 그림 근거), 그 블록이 `content_blocks`에서 `image`이며, bbox가 같은 쪽의 문제 자기 영역(`block_id` 없는 첫 근거 위치) 안에 드는 것이다. 캡션 글 블록은 쓰지 않는다.

**정답 보호:** 추출기는 인라인 정답(`정답: ②`)을 읽은 뒤의 이미지를 문제에 넣지 않지만, 그 이미지에 캡션이 있으면 같은 라벨을 언급한 문제에 근거로 붙을 수 있다. 해설에 든 그림일 수 있으므로 위 조건으로 뺀다. 문제 자기 영역은 정답 줄을 포함하지 않으므로, 영역 안의 이미지는 정답 앞에서 읽은 것이다. 이미지 bbox만 그리고 합집합이나 여백을 쓰지 않아 정답 글이 함께 잘려 들어오지 않는다. 문제 영역 밖에 인쇄된 공통 그림은 정답 뒤 이미지와 구분할 수 없어 인라인으로도 `문제 원문 보기`로도 보이지 않는다(QSRC-01-C06). 문제 영역이 정답 줄에 닿는 쪽은 그림도 없다.

**PDF 전달:** 그림 영역이 화면에 들어올 때만 기존 `GET /documents/:id/source-url` 중계로 PDF를 받는다. 새 권한은 없다. 그림이 없는 문제는 PDF를 받지 않는다. 공유 게스트는 영역 API를 부르지 않아 그림이 없다.

### UX12-REEXTRACT-AC04

그림이 있는 가져온 문제를 풀이 panel에서 열면 제출 전에도 발문과 보기 사이에 `문제 그림 1`(role `img`, 여러 개면 번호순)이 bbox의 가로세로 비로 보인다. 쪽 표시와 글 layer가 없고, 그 안의 글이 DOM에 없다. `문제 원문 보기` 버튼과 dialog는 그대로다. 범위 풀이와 "문제 상세"에도 같은 그림이 보인다.

### UX12-REEXTRACT-AC05

그림 영역이 화면 밖이면 PDF 요청이 없고, 화면에 들어오면 한 번 받는다. 그림이 없는 문제를 열면 PDF 요청이 없다. PDF를 그리지 못하면 "그림을 불러오지 못했습니다"와 `다시 시도`가 보이고 풀이는 그대로 할 수 있다.

## 계약 요구사항 (pytest, 화면 AC 아님)

| ID | 요구사항 |
|---|---|
| UX12-REEXTRACT-C01 | `POST /question-imports/{id}/re-extract`(편집 권한) → 202 새 run. 같은 문서·같은 revision에 고정되고 `reextract_of`가 원래 run을 가리키며 `document.parse` job을 만들지 않는다. 끝나면 새 초안이 생기고 이전 초안, 등록된 문제의 revision과 출처, `published_question_id`는 그대로다. |
| UX12-REEXTRACT-C02 | `Idempotency-Key`가 같으면 같은 run을 돌려준다(job 재발행 포함). 같은 문서에 진행 중인 run이 있으면 다시 추출과 실패한 run의 `retry`는 409 `import-running`이고 run을 만들지 않는다. 문서 행 FOR UPDATE로 직렬화한다. |
| UX12-REEXTRACT-C03 | 보기 권한 403 `insufficient-role`, 보관된 Workspace 403 `workspace-archived`, 비구성원과 다른 Workspace는 같은 404. 문서가 삭제됐거나 처리 중이면 409 `document-not-ready`. |
| UX12-REEXTRACT-C05 | `source-region` 응답의 `figures`는 `regions`와 같은 모양(문서 id, revision id, 쪽, bbox)이고 쪽, 위, 왼쪽 순서다. 문제 자기 영역 안의 `image` 블록 위치만 든다. 글 블록, 영역 밖 이미지(정답 뒤 이미지), 첫 근거 위치, `content_blocks`에 없는 블록은 없다. 그림이 없으면 빈 목록이다. 삭제된 문서는 전과 같이 404다. 인가와 `Cache-Control`은 QSRC-01-C03과 같다(`tests/integration/questions/source_region/test_source_region_contract.py`). |
| UX12-REEXTRACT-C06 | 모의고사 `source-region`은 원본 문제의 `figures`를 돌려주고 AI 변형은 전과 같이 404다. 등록(`publish`)이 초안의 그림 근거를 출처 행으로 옮기면 그 그림이 `figures`에 든다. |
| UX12-REEXTRACT-C04 | `ImportDraft`와 `ImportDraftSummary`의 `previous`는 다시 추출한 run에서만 값이 있다: `{question_id, revision_id, number, changed}`. `question_id`는 살아 있는 확정 문제가 있을 때만 있고 `changed`는 `type`·`stem`·`table`·`options`·`answer` 순서의 목록이다. `table`은 발문이 같아도 병합 셀이 다를 때다([UX12-STEMTABLE](ux12-stemtable.md)). 짝이 없으면 null. 요약에는 정답 값이나 발문이 없다. `draft-summaries`의 `missing_previous`는 이번 run에 없는 이전 문제 번호다. |

# UX12-MOCKSHUFFLE — 모의고사 보기 섞기 실행 시점

**Route:** `/workspaces/:workspaceId?panel=mock-exams`, 풀이 `?practice=<id>&i=<k>`

**Phase:** UX12-MOCKSHUFFLE.0
**테스트:** `tests/e2e/questions/ux12-mock-shuffle.spec.ts` (계약: `tests/integration/questions/mock_exams/test_mock_exams_contract.py`, 단위: `apps/api/tests/test_mock_practice_unit.py`, pgTAP: `supabase/tests/35_mock_shuffle_copies.test.sql`)

```yaml
id: UX12-MOCKSHUFFLE
linked_tests: [UX12-MOCKSHUFFLE-AC01, UX12-MOCKSHUFFLE-AC02, UX12-MOCKSHUFFLE-AC03, UX12-MOCKSHUFFLE-AC04]
```

**명세:** [UX12 MOCKUX-9](../implementation/ux12/index.md), [MOCK-01](mock-exams.md), [UX12-CHAPTERRUN](ux12-chapter-run.md), [questions.md §11](../questions.md)

사용자 요청(2026-11-06): `보기 섞기`는 모의고사를 실행할 때마다 문제를 보는 시점에 새로 섞고, 한 번의 실행 안에서는 유지한다. `보기 섞기`만 고르면 문제를 미리 만들지 않는다.

정해진 내용(MOCKUX-9 위임 결정):

- **미리 만들지 않음의 뜻:** `보기 섞기`만 고른 모의고사에는 worker job, LLM 호출, 대기 상태, 섞인 보기 순서가 없다. 만드는 요청 안에서 저장된 행과 문제 복사본이 끝나고 바로 `준비됨`이다. 문제 행(`mock_exam_questions`)은 그대로 만든다: 편집, 빼기, 풀이 기록, AI 해설, 관련 본문, 출처가 이 행을 기준으로 하고, 원본을 편집해도 모의고사 문제가 바뀌지 않는다는 규칙(MOCK-01-C08)을 지키려면 만들 때의 revision을 복사해야 한다.
- **만들 때 고정:** 범위에서 고른 문제, 그 문제의 승인된 revision 내용(원본 보기 순서 그대로), 문제 순서. **실행 때 정함:** 보기 표시 순서뿐이다.
- **섞이는 문제:** 변형 유형이 `보기 섞기`인 객관식 문제 전부. 혼합 모의고사의 `보기 섞기` 문제도, 이 변경 전에 만든 모의고사의 문제도 같다. 저장된 데이터는 고치지 않는다. 예전 문제는 저장된 순서를 기준으로 실행마다 다시 섞이고, 상세 목록에는 저장된 순서 그대로 보인다.
- **AI 변형 문제:** 지금처럼 미리 만들고 저장된 보기 순서로 보인다.

### UX12-MOCKSHUFFLE-AC01

`보기 섞기`만 고르고 `만들기`를 누르면 상세가 바로 `준비됨`과 문제 목록을 보인다. "만드는 중"과 진행 줄은 나타나지 않는다. 목록 행에는 이름, `준비됨`, 문제 수, `보기 섞기`가 있다. 상세의 문제 목록은 원본 보기 순서를 보인다. `다시 만들기`와 `설정 바꾸기`도 확인 뒤 바로 새 회차로 바뀌고 "모의고사 문제를 만들었습니다."를 알린다. 이미 푼 기록은 이전 회차에 남는다.

**E2E:** `tests/e2e/questions/ux12-mock-shuffle.spec.ts`

### UX12-MOCKSHUFFLE-AC02

풀이의 각 객관식 위치는 그 실행에서 정한 순서를 보인다. 새로 고침, `이전 문제`, 제출 뒤에도 순서가 같다. 제출 전에는 정답이 없고, 채점은 option ID로 하며, 기록은 `mock_exam_attempts`에만 남는다.

**E2E:** `tests/e2e/questions/ux12-mock-shuffle.spec.ts`

### UX12-MOCKSHUFFLE-AC03

같은 모의고사를 다시 풀면(새 실행, 결과의 `처음부터 다시`) 보기 순서를 새로 뽑는다. 뽑은 순서가 우연히 전과 같을 수는 있다.

**E2E:** `tests/e2e/questions/ux12-mock-shuffle.spec.ts` (테스트 환경은 서버 seed가 고정이므로 실행 요청에 seed를 넣어 확인한다)

### UX12-MOCKSHUFFLE-AC04

`보기 섞기`와 AI 유형을 함께 고르면 지금처럼 "만드는 중"을 거쳐 AI 문제를 미리 만든다. 풀이에서 `보기 섞기` 문제만 실행마다 순서가 바뀌고 AI 문제는 저장된 순서를 유지한다.

**E2E:** `tests/e2e/questions/ux12-mock-shuffle.spec.ts`

### 계약

| ID | 내용 |
|---|---|
| UX12-MOCKSHUFFLE-C01 | **즉시 저장:** 변형 유형이 `OPTION_SHUFFLE`뿐이면 `POST /workspaces/{id}/mock-exams`와 `POST /mock-exams/{id}/generations`는 `async_jobs`를 만들지 않는다. 응답은 지금처럼 202 `MockExam`이고 `status=ready`, `latest_generation.status=succeeded`, `job_id=null`, `created_count=requested_count`다. `quiz_api`는 문제 표와 `succeeded` 상태에 직접 쓰지 못한다. 복사는 security definer 함수 `mock_exam_store_shuffle_copies` 하나로만 하며, 이 함수는 job 없는 `queued` 회차이고 plan이 모두 `OPTION_SHUFFLE`일 때만 동작한다. `llm_available`과 `WORKER_MOCK_EXAMS`에 영향받지 않는다. |
| UX12-MOCKSHUFFLE-C02 | **한도:** 즉시 저장은 대기·실행 중인 회차를 늘리지 않으므로 `generation-busy`의 대상이 아니고 그 수에 세지 않는다. 사용자별 시작 횟수 제한, 문항 수 한도, 범위 검사, 같은 모의고사에 AI 회차가 진행 중일 때의 `mock-generation-running`, `Idempotency-Key`는 그대로다. |
| UX12-MOCKSHUFFLE-C03 | **순서:** run 위치 k의 `OPTION_SHUFFLE` 객관식은 `shuffled_option_ids(active revision 옵션 id, run_option_seed(run.seed, k))` 순서다. 세션을 열기 전(`GET /items/{k}`)과 연 뒤가 같고, 세션은 이 순서를 `displayed_option_ids`, `shuffle_seed`에 저장한다. 문항별 설정이므로 `practice_runs.range`의 `shuffle_options`와 `PracticeRun.shuffle_options`는 mock run에서 false 그대로고, `source=mock`에 `shuffle_options`를 보내면 지금처럼 422다. |
| UX12-MOCKSHUFFLE-C04 | **세션:** run 밖의 새 세션과 `다시 풀기`(별도 연습)는 `OPTION_SHUFFLE` 객관식을 CSPRNG seed로 새로 섞는다. 이미 열린 세션과 제출된 세션은 저장된 순서를 유지한다. 단답형, 서술형, AI 변형 문제의 기본은 저장된 순서다(UX10-QVIEW-AC01의 `shuffle_options` 기본값은 이 표의 예외를 뺀 나머지에 그대로 적용한다). |
| UX12-MOCKSHUFFLE-C05 | **저장 순서:** 새로 만드는 `OPTION_SHUFFLE` 문제(즉시 저장, 혼합 회차의 worker 복사)는 원본 revision의 보기 순서 그대로 저장한다. 이 변경 전에 큐에 들어간 `OPTION_SHUFFLE`만의 회차는 worker가 같은 방식으로 끝낸다. |
| UX12-MOCKSHUFFLE-C06 | **원본:** 복사본은 고정된 원본 revision을 가리킨다. 원본을 편집, 삭제, 보관해도 문제와 풀이는 바뀌지 않고 삭제되면 출처는 `원본 삭제됨`이다(MOCK-01-C08). `다시 만들기`는 그때의 범위와 revision으로 새 회차를 만든다. |

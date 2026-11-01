# RELSRC-01 — 관련 본문 (제출 후)

**상태:** 화면 요구사항 초안 v0.1 · ASK-SPEC 추가 2026-11-01 (사용자 요청 "문제 답 제출 후 문서에서 관련된 부분 제시 -- 이것도 생성 후 저장"). [AIEXPL-01](ai-explanations.md) 옆의 별도 기능이다. 검색 범위 규칙은 [ASK-01](ask-llm.md) "검색 범위"와 같고, 제출 확인·공유 캐시·동시성은 AIEXPL-01과 같은 방식이다. `(제안 — 사용자 확인 필요)` 표시는 implementation-plan §7의 ASK-SPEC 제안 행에 모여 있다.
**Route:** 별도 route 없음. 풀이 panel(QPLAY-01, `?question=:questionId`) 결과 영역 안(AI 해설 아래)과 "문제 상세" dialog 안에 있고, 이후 QuestionViewer(QVIEW-01) 결과 영역에도 들어간다.
**테스트:** `tests/e2e/questions/related-sources.spec.ts` (계약: `tests/integration/questions/related_sources/test_related_sources_contract.py`, `packages/core` unit test, `supabase/tests` pgTAP)
**Phase:** RELSRC.0 (RED) → RELSRC-B (계약) → RELSRC-W (AC01~AC05, CI phase 켬) → ASK-QM (모의고사 문제, C07)
**연계:** [AIEXPL-01](ai-explanations.md), [ASK-01](ask-llm.md), [SEARCH-01](search.md), [QPLAY-01](questions-practice.md), [DOC-02](documents-editor.md), [Questions 명세](../questions.md) §11, [공유 명세](../workspace-sharing.md) §10, [E2E 규칙](../e2e-strategy.md)

```yaml
id: RELSRC-01
route: /workspaces/:workspaceId?question=:questionId (결과 영역)
actor: workspace_member (제출 후 보기) · share guest (이미 만든 목록 읽기 — 제안)
permission: read · personal attempt
status: draft
api: [GET /api/v1/questions/:id/related-sources, GET /api/v1/shared/:shareId/questions/:questionId/related-sources]
components: [Disclosure, Button, DocumentExcerptPanel]
linked_tests: [RELSRC-01-AC01 … RELSRC-01-AC05]
```

## 목적과 정책

- **제출 후에만.** 답을 제출해 결과가 보인 뒤, 결과 영역(그리고 AI 해설이 있으면 그 아래)에 접힌 "관련 본문" 영역이 나온다. 펼치면 그 문제와 관련된 교재 구절 몇 개를 보인다. 서버는 AI 해설과 같은 방식으로 제출을 확인한다: 요청에 `practice_session_id`(그 사용자의 그 문제 session, 제출 attempt 있음 — 채점 대기 포함)나 `view: detail`(`GET /questions/{id}` 권한)이 없으면 409 `related-before-submit`이고 아무것도 계산·저장하지 않는다. 제출 전에 막는 이유: 검색어에 정답 글이 들어가고, 정답 근거 구절이 맨 위에 오므로 사실상 정답을 알려 준다.
- **문제 상세에도 (제안 — 사용자 확인 필요):** 구성원이 이미 정답을 보는 "문제 상세" dialog의 해설·AI 해설 아래에도 같은 영역을 둔다(`view: detail`, 제출 필요 없음). AIEXPL-01과 같은 규칙이다. 대안: 풀이 결과에서만.
- **보이는 것:** 구절 최대 `RELATED_SOURCES_LIMIT`(기본 5)개. 각 행: 문서 제목 · 장 · 쪽(`p.12–13`), 발췌(최대 300자, 문단 경계; 검색어와 일치한 낱말은 `<mark>` 굵게 + 밑줄 — 색만으로 구분하지 않음), 그 문제의 출처(`question_sources`)에서 온 행은 글자 badge `문제 출처`. 행을 누르면 "본문 발췌" panel(SEARCH-01 `DocumentExcerptPanel`)이 그 구절 전체와 위치를 보이고, 그 panel의 "PDF에서 보기"가 DOC-02 그 쪽(`?page=`)을 연다. 행 끝의 작은 링크 "PDF"는 DOC-02를 바로 연다.
- **만드는 방식 — A: 검색만, LLM 없음 (제안 — 사용자 확인 필요):**
  1. 그 문제의 `question_sources` 중 발행된 `book` 문서의 블록을 먼저 넣는다(`문제 출처`, 순서 유지). 문제지·가져온 출처(`imported`)는 빼고, 그 블록이 현재 발행 revision에 없으면 같은 `block_id`가 남아 있을 때만 넣는다.
  2. 남은 자리는 기존 hybrid 검색(BM25 + dense → RRF → rerank)으로 채운다. 검색어는 발문 + 정답 보기 글(객관식) 또는 허용 답안·채점 기준 핵심(단답·서술형)이다(앞 2,000자). 오답 보기는 넣지 않는다 — 틀린 개념이 맨 위에 오지 않게 한다. 1에서 넣은 구절과 같은 블록은 빼고, 같은 쪽에서는 한 개만 남긴다(중복 제거). reranker 점수가 `RELATED_SOURCES_MIN_RELEVANCE` 아래인 후보는 버린다.
  3. 범위 규칙은 ASK-01 "검색 범위"와 같다: Workspace의 살아 있는 `book` 문서의 현재 발행 revision만. `question_paper`는 항상 빼고, `mixed`는 문제 추출 구간 블록을 빼고, 문서 요약·정리 노트·AI 해설은 넣지 않는다. 같은 `quiz_api.ask_retrieval` 모듈을 쓴다.
  - 비용: **LLM 호출 0.** 문제당 한 번 query embedding(Workers AI, 검색과 같은 경로 — 수십 token, 무료 등급 안)과 reranker 한 번(검색 1회와 같은 CPU)만 든다. 문제마다 처음 한 번만 계산하고 저장한다.
  - **대안 B:** A의 후보 10개를 LLM이 다시 골라 행마다 "왜 관련 있는지" 한 줄을 쓴다(입력 ≈ 3k~5k token, 출력 ≈ 0.3k → `claude-sonnet-5-5`로 문제당 약 $0.01, 처음 한 번). **대안 C:** B를 AI 해설 플래그(`WORKER_AI_EXPLANATIONS`) 뒤에 둔다. A를 추천하는 이유: 사용자 요청은 "관련된 부분 제시"이고 설명 글은 AI 해설이 이미 맡는다. 비용이 없어 플래그 없이 모든 환경에서 켤 수 있고(아래), 지어낸 설명이 생길 위험이 없다.
- **환경별 사용 여부 (제안 — 사용자 확인 필요):** 방식 A는 LLM을 쓰지 않으므로 LLM 플래그가 없다. 검색을 쓸 수 있는 모든 환경에서 켜져 있다(검색이 이미 검색어를 embedding 제공자로 보낸다 — deployment §6). 운영상 끌 수 있게 API 설정 `RELATED_SOURCES_ENABLED`(기본 true)만 둔다. B·C를 고르면 그 LLM 플래그 규칙을 따른다(⛔ 켜기 승인).
- **캐싱·저장 (제안 — 사용자 확인 필요):**
  - 키: `(question_revision_id, corpus_fingerprint, retrieval_version)`. B·C면 `model`을 더한다. `corpus_fingerprint`는 Workspace의 살아 있는 `book` 문서의 `(document_id, 현재 발행 revision id)`를 정렬한 목록과 embedding model 이름, chunk 설정 버전의 SHA-256이다. 그래서 교정 발행·revision 복원·교재 추가·삭제·embedder 전환(`make reindex`로 새 collection)은 키를 바꾸고, 바뀐 뒤 처음 읽는 사람에게서 다시 계산된다. 같은 revision을 다시 색인하는 것만으로는 바뀌지 않는다(결과가 같다). 문제를 고치면(새 question_revision) 새 키다.
  - 범위: Workspace 공유 하나다(AIEXPL과 같음). 사용자의 답은 입력이 아니다.
  - 저장: Postgres `question_related_sources`(이력 포함). 행은 구절 참조(문서·revision·block ids·쪽·점수·`문제 출처` 여부·순서)만 담고 본문을 복사하지 않는다. 읽을 때 블록 본문으로 발췌를 만든다. 예전 키의 행은 지우지 않는다(`superseded_at`).
  - 계산 위치: LLM이 없어 API 요청 안에서 동기로 계산한다(목표 p95 ≤ 1.5초; worker·streaming 없음). 처음 읽는 요청이 계산하고 저장한다.
  - 동시성: 같은 키의 첫 요청 둘이 동시에 와도 계산은 한 번이다. `pg_advisory_xact_lock(hash(question_revision_id, corpus_fingerprint))` 아래에서 행이 있는지 다시 보고, 없을 때만 계산해 넣는다(unique `(question_revision_id, corpus_fingerprint, retrieval_version)`). 두 번째 요청은 잠금이 풀리면 저장된 행을 읽는다.
- **보관된 Workspace (제안 — 사용자 확인 필요):** 저장된 목록은 보인다. 없으면 계산해서 보이되 저장하지 않는다(보관은 읽기 전용 — 쓰기 없음). 대안: 저장된 것만 보이고 없으면 "관련 본문을 찾지 못했습니다".
- **공유 게스트 (제안 — 사용자 확인 필요):** AI 해설과 같이 공유 문제 panel에서 **이미 저장된** 현재 키의 목록만 읽기 전용으로 보인다(발행 교재·발행 문제는 게스트의 열람 범위). 게스트 요청은 계산하지 않는다. 대안: 게스트도 계산(비용은 거의 없음, 쓰기는 생김).
- **Fork (제안 — 사용자 확인 필요):** 복제하지 않는다. 사본의 문서 id가 새로 생겨 `corpus_fingerprint`가 바뀌므로 어차피 처음 읽을 때 다시 계산된다(비용 없음). 대안: 재매핑해서 복제.
- 관련 본문을 보는 것은 풀이·열람이 아니다(풀이 기록·Heatmap 상태 불변). practice API 응답은 바뀌지 않는다.

## 레이아웃 및 컴포넌트

- **위치:** 풀이 panel 결과 영역에서 결과·정답·해설 → AI 해설(AIEXPL-01, 있을 때) → **관련 본문** 순서. 문제 상세 dialog에서도 같은 순서(제안). QuestionViewer가 풀이 panel을 대신하면(QVIEW-W) 같은 자리로 옮긴다.
- **disclosure:** 버튼 "관련 본문"(`aria-expanded`, `aria-controls`, 기본 접힘 — 결과를 가리지 않음, 제안). 펼칠 때 처음으로 `GET /questions/{id}/related-sources`를 부른다. 펼친 상태는 기억하지 않는다.
- **상태:**
  - 불러오는 중: 영역 안 skeleton 3줄 + `role="status"` "관련 본문을 찾는 중입니다".
  - 완료: 행 목록(`ol`, 이름 "관련 본문"). 끝나면 status "관련 본문 n개". 근거 revision이 더는 현재 발행본이 아니면 행에 "이전 발행본" 글자(저장된 행이 오래된 키일 때 — 보통은 다시 계산되어 생기지 않음).
  - 없음: "관련 본문을 찾지 못했습니다." (`role="status"`).
  - dense 불가(검색 저하): BM25 결과로 보이고 "의미 검색을 일시적으로 사용할 수 없어 키워드 결과만 표시합니다"(SEARCH-01-AC06과 같은 문구). 이 결과는 **저장하지 않는다**(다음에 정상일 때 다시 계산).
  - 오류(Qdrant 장애 등): `role="alert"` "관련 본문을 불러오지 못했습니다." + `다시 시도`.
  - 기능 꺼짐(`RELATED_SOURCES_ENABLED=false`): 영역이 없다.
- 키보드: disclosure Enter/Space, 행은 버튼(Enter → 발췌 panel), "PDF" 링크. 발췌 panel을 Escape로 닫으면 focus는 누른 행으로 돌아온다. 터치 target 24px 이상, 375px에서 가로 스크롤 없음.

## 화면 상태

| 상태 | 구성원 | 보관된 Workspace | 공유 게스트 |
|---|---|---|---|
| 제출 전 | 영역 없음(서버 409) | 같음 | (제출 없음 — 저장된 목록만, 제안) |
| 제출 후 · 처음 | 펼치면 계산·저장 후 목록 | 펼치면 계산해서 보이고 저장 안 함(제안) | 저장된 것이 없으면 영역 없음 |
| 저장됨 | 바로 목록 | 같음 | 읽기 전용 목록 |
| 없음 | "관련 본문을 찾지 못했습니다." | 같음 | 영역 없음 |
| 오류 | alert + `다시 시도` | 같음 | 영역 없음 |
| 교재 발행·문제 수정 뒤 | 펼치면 다시 계산 | 계산만 | 새 목록이 저장될 때까지 없음 |

## 수용 기준

E2E는 기존 검색 fake(결정적 embedder·reranker, `APP_ENV=test`)를 쓴다. LLM은 쓰지 않는다.

### RELSRC-01-AC01

- **Given:** 발행된 합성 교재(장 2개; 장 1에 정답 개념 구절 "가나다 원리", 장 2에 관련 구절 "가나다 응용"), 장 1의 그 쪽을 출처로 가진 확정 객관식 문제(정답 보기 "가나다 원리"), 편집 권한자의 Workspace 홈
- **When:** Heatmap에서 문제를 열어 결과 영역을 확인하고, 제출한 뒤 "관련 본문"을 펼친다. 첫 행을 누르고 발췌 panel의 "PDF에서 보기"를 누른다. 돌아와 두 번째 행의 "PDF" 링크를 누른다
- **Then:** 제출 전에는 "관련 본문" 영역이 없다. 제출 뒤에는 결과·해설(AI 해설이 꺼진 환경에서는 바로 해설) 아래에 접힌 "관련 본문"(`aria-expanded="false"`)이 있다. 펼치면 "관련 본문을 찾는 중입니다"를 거쳐 행 5개 이하가 보이고, 첫 행은 `문제 출처` badge가 붙은 장 1 구절이며 그다음에 장 2의 "가나다 응용" 구절이 있다. 각 행은 문서 제목·장·쪽과 발췌를 보이고, 검색어 낱말은 `<mark>`(굵게+밑줄)다. 같은 쪽의 행은 하나뿐이다. 행은 "본문 발췌" panel을 열고 "PDF에서 보기"·"PDF"는 DOC-02 그 쪽을 연다. status는 "관련 본문 n개"를 한 번 알린다.

### RELSRC-01-AC02

- **Given:** AC01의 문제를 아직 제출하지 않은 사용자의 열린 풀이 panel(session 있음), 다른 사용자의 제출한 session id
- **When:** 그 session id로 `GET /questions/{id}/related-sources`를 직접 부르고, session 없이·다른 사용자의 session으로도 부른다. 그 뒤 제출하고 다시 부른다
- **Then:** 제출 전·session 없음은 409 `related-before-submit`, 다른 사용자의 session은 404이며 응답에 구절·문서 id가 없고 저장된 행이 생기지 않는다(DB 행 수 그대로). practice-session 응답에는 관련 본문 필드가 없다. 제출 뒤에는 200이다.

### RELSRC-01-AC03

- **Given:** AC01에서 목록이 저장된 문제, 같은 Workspace의 보기 권한 멤버 둘(A·B), 목록이 없는 두 번째 문제, 테스트용 검색 지연 marker(`E2E-RELSRC-HOLD-<token>`, 발문)
- **When:** A가 첫 문제를 제출하고 "관련 본문"을 펼친다. A와 B가 두 번째 문제를 제출하고 거의 동시에 펼친 뒤 테스트가 hold를 푼다. 편집 권한자가 장 2의 "가나다 응용" 구절을 지우도록 교정해 발행하고, A가 첫 문제를 다시 풀어 펼친다. 편집 권한자가 첫 문제를 고쳐 저장한다
- **Then:** A의 첫 문제는 계산 없이 저장된 같은 목록이다(같은 행 id, 검색 호출 기록 변화 없음). 두 번째 문제는 계산이 한 번만 일어나고(검색 호출 1, 저장 행 1) A와 B가 같은 목록을 본다. 교재를 발행한 뒤에는 `corpus_fingerprint`가 바뀌어 새 목록이 계산되고 지운 구절은 없다(예전 행은 `superseded_at`과 함께 남음). 문제를 고친 뒤에도 새 목록이 계산된다.

### RELSRC-01-AC04

- **Given:** 같은 구절 "라마바 정답표"가 문제지에만 있고 문제 구간에만 "사아자 해설"이 있는 `mixed` 교재가 있는 Workspace, 정답 보기가 각각 "라마바 정답표"·"사아자 해설"인 문제 둘, 아무 교재에도 관련 구절이 없는 문제, 검색 장애 marker `E2E-RELSRC-FAIL`, dense 불가 marker(SEARCH-01-AC06과 같은 것)
- **When:** 각 문제를 제출하고 "관련 본문"을 펼친다. FAIL 문제에서 `다시 시도`를 누른다(두 번째는 성공하도록 설정). dense 불가 상태에서 다른 문제를 펼친 뒤, 정상 상태에서 같은 문제를 다시 펼친다
- **Then:** 문제지와 `mixed` 문제 구간의 구절은 어떤 목록에도 없고, 관련 구절이 없는 문제는 "관련 본문을 찾지 못했습니다."다(API 응답에 `question_paper` 문서가 없음). FAIL은 alert "관련 본문을 불러오지 못했습니다."와 `다시 시도`를 보이고 다시 시도는 목록을 보인다. dense 불가 때는 키워드 결과와 비차단 안내가 보이고 저장되지 않으며(행 0), 정상 상태에서 다시 펼치면 계산·저장된다.

### RELSRC-01-AC05

- **Given:** 목록이 저장된 문제와 없는 문제, 그 문제를 아직 풀지 않은 보기 권한 멤버, 보관된 Workspace의 Owner, 유효한 공유 링크 게스트, 키보드 전용 사용자
- **When:** 보기 권한 멤버가 풀이 panel의 `문제 정보` › `정답·해설 보기`로 연 문제 상세 dialog에서 "관련 본문"을 키보드로 펼치고 행을 Enter로 연 뒤 Escape를 누른다. 보관된 Workspace의 Owner가 목록이 없는 문제를 제출하고 펼친다. 게스트가 공유 문제 panel에서 두 문제를 열고 공유 API를 부른다
- **Then:** 문제 상세에는 제출 없이도 "관련 본문"이 있고(`view: detail`) 풀이 panel의 session·풀이 기록은 바뀌지 않는다. Enter는 발췌 panel을 열고 Escape는 focus를 그 행으로 돌린다. 보관된 Workspace에서는 목록이 보이지만 저장되지 않는다(DB 행 0). 게스트는 저장된 문제에서만 읽기 전용 "관련 본문"을 보고(목록이 없는 문제는 영역 없음, 공유 API 404), 게스트 요청은 계산하지 않는다. axe 위반 0.

## 계약 요구사항 (pytest·unit, 화면 AC 아님)

`tests/integration/questions/related_sources/test_related_sources_contract.py`, `packages/core/tests`, `supabase/tests`(pgTAP).

| ID | 요구사항 |
|---|---|
| RELSRC-01-C01 | **제출 확인·인가:** `practice_session_id`(그 사용자의 그 문제 session, 제출 있음) 또는 `view: detail`(`GET /questions/{id}` 권한). 그 밖 409 `related-before-submit`, 남의 session·다른 Workspace·삭제 문제 404. 판정은 DB, client 값 무시. 409·404에서는 검색·저장 없음. 공유 API는 발행된 CONFIRMED 문제의 active revision과 현재 `corpus_fingerprint`의 저장된 행만(그 밖 404), 계산하지 않음, 매 요청 링크 재검증, 점수·키·버전 없음. `RELATED_SOURCES_ENABLED=false`면 404 `related-disabled`. |
| RELSRC-01-C02 | **범위:** 후보는 ASK-01-C02와 같은 범위(`book` 현재 발행 revision, 문제지 제외, `mixed` 문제 구간 제외, 요약·노트·AI 해설 제외; 같은 `ask_retrieval` 모듈). `question_sources` 행은 발행 `book` 문서 블록일 때만 먼저(가져온 출처·문제지 출처 제외). 검색어는 발문 + 정답 글(오답 보기 없음), 같은 블록·같은 쪽 중복 제거, 상한 `RELATED_SOURCES_LIMIT`(5), 점수 하한. |
| RELSRC-01-C03 | **캐시 키·무효화:** unique `(question_revision_id, corpus_fingerprint, retrieval_version)`. `corpus_fingerprint`는 정렬된 `(document_id, active published revision id)`(살아 있는 `book`만) + embedding model + chunk 설정 버전의 SHA-256 — 교정 발행·복원·교재 추가/삭제·embedder 전환은 바꾸고, 같은 revision 재색인은 바꾸지 않는다(각각 test). 예전 키 행은 `superseded_at`만 적고 지우지 않는다. 저장 행은 참조만(문서·revision·block ids·쪽·점수·`from_question_source`·순서), 본문 없음. |
| RELSRC-01-C04 | **동시성:** 같은 키의 동시 첫 요청 20개 → 검색 1회·행 1개, 모두 같은 목록(advisory xact lock + 재확인 + unique; 경쟁 test). |
| RELSRC-01-C05 | **저장하지 않는 경우:** 보관된 Workspace(계산만, 쓰기 0), 검색 저하(`degraded: ["dense_unavailable"]` — 응답에 그대로 담고 저장하지 않음), 공유 게스트(계산 안 함). 오류(Qdrant 장애)는 503 `related-unavailable`, 행 없음. |
| RELSRC-01-C06 | **유출 금지·영향 없음:** 발문·정답·검색어·발췌는 로그·trace에 없다(검색 로그 규칙과 같음: 예외 type·code만). practice API 응답 schema 불변, 풀이 기록·`question_user_states` 불변. Fork는 행을 복제하지 않는다(제안). |
| RELSRC-01-C07 | **모의고사 문제 (ASK-QM):** 키 `(mock_exam_question_revision_id, corpus_fingerprint, retrieval_version)`, 모의고사 practice session 제출 확인, 출처 블록 대신 그 문제를 만들 때 쓴 근거 블록을 먼저. ASK-QM까지 pytest `red`. |

## Test-first 규칙

- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 구현한다(RELSRC.0). 정답이 보이는 화면의 품질 spec은 trace·screenshot·video와 page text 첨부를 끈다.

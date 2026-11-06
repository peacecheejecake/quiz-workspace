# AIEXPL-01 — AI 문제 해설 (제출 후)

> **UX10 개정 예정(2026-11-05):** [확정 구현 기준](../implementation/ux10/index.md)의 해당 변경 요구가 이 문서의 이전 동작에 우선한다. 구현 Task의 RED 단계에서 해당 AC·trace를 함께 갱신한다. 변경되지 않은 요구·보안 경계는 유지한다.

**상태:** 화면 요구사항 v1.0 (모든 제안 사용자 결정 2026-11-01) · ASK-SPEC 신규 2026-11-01 · 사용자 결정 반영 2026-11-01(공유 해설·모든 보기, 구성원 생성·편집 권한 다시 만들기, 공유 게스트 읽기·Fork 복제) (사용자 요청 "LLM 문제 해설 — 문제 제출 후 버튼 노출 -> 해당 버튼 누르면 하단에 llm이 생성한 해설 생성 — 같은 문제에 대한 답변은 캐싱"). [ASK-01](ask-llm.md)과 따로 켜고 끌 수 있는 별도 기능이며 LLM 호출 경로·fake·인용 검증·usage 기록을 ASK와 함께 쓴다. 모든 설계 선택은 사용자가 확인했다(implementation-plan §7 ASK-SPEC 사용자 결정 행).
**Route:** 별도 route 없음 — QuestionViewer(QVIEW-01)의 결과 영역 안의 영역: `practice`(풀이 panel, `?question=:questionId`)·`sequence(bank|mock)`(범위 풀이, `?practice=:runId&i=`)의 제출 결과 아래, `manage`("문제 상세" dialog)의 해설 아래, `read-only`(공유 게스트 미리보기)의 해설 아래(있는 해설만).
**테스트:** `tests/e2e/questions/ai-explanations.spec.ts` (계약: `tests/integration/questions/ai_explanations/test_ai_explanations_contract.py`, `apps/worker` · `packages/core` unit test, `supabase/tests` pgTAP)
**Phase:** EXPL.0 (RED) → EXPL-B (계약 C01~C09, 모의고사 C09 포함) → EXPL-W (AC01~AC07, CI phase 켬). 이전 ASK-QM은 ASK-SYNC 2026-11-02에 EXPL-B·EXPL-W로 합쳤다.
**연계:** [ASK-01](ask-llm.md), [RELSRC-01](related-sources.md), [QPLAY-01](questions-practice.md), [QVIEW-01](question-viewer.md), [MOCK-01](mock-exams.md), [WS-VIEW-01](workspace-shared-view.md), [Questions 명세](../questions.md) §13, [공유 명세](../workspace-sharing.md) §10, [디자인 시스템](../design-system.md) §5, [E2E 규칙](../e2e-strategy.md)

```yaml
id: AIEXPL-01
route: /workspaces/:workspaceId?question=:questionId | ?practice=:runId (QuestionViewer 결과 영역)
actor: workspace_member (제출 후 보기·만들기) · editor/owner (다시 만들기) · share guest (있는 해설 읽기)
permission: read · personal attempt · edit (다시 만들기)
status: confirmed
api: [GET /api/v1/questions/:id/ai-explanation, POST /api/v1/questions/:id/ai-explanation, POST /api/v1/questions/:id/ai-explanation/regenerate, GET /api/v1/ai-explanations/:id/stream, GET /api/v1/shared/:shareId/questions/:questionId/ai-explanation, GET /api/v1/mock-exam-questions/:id/ai-explanation, POST /api/v1/mock-exam-questions/:id/ai-explanation, POST /api/v1/mock-exam-questions/:id/ai-explanation/regenerate, GET /api/v1/mock-ai-explanations/:id/stream]
components: [Button, Badge, Disclosure, DocumentExcerptPanel]
linked_tests: [AIEXPL-01-AC01 … AIEXPL-01-AC07]
```

## 목적과 정책

- **제출 후에만.** 풀이 결과(정답/오답/채점 대기 + 정답 + 해설)가 보인 뒤 결과 영역 아래에 `AI 해설` 버튼이 나온다. 누르면 그 아래에 LLM이 만든 해설이 나타난다. 제출 전에는 버튼이 없고, **서버도 거절한다:** 요청은 `practice_session_id`를 함께 보내야 하며 그 session에 그 사용자의 제출(attempt, 채점 대기 포함)이 없으면 409 `explanation-before-submit`이고 LLM을 부르지 않으며 저장된 해설도 주지 않는다(AGENTS.md §5 "Practice APIs never send correct answers or explanations before submission"). UX7-CACHE대로 제출한 문제를 다시 열면 새 session이므로 다시 제출해야 버튼이 보인다.
- **LLM 입력 (제출 후라 정답 포함):** 문제 유형·발문·보기(원본 순서, option ID와 글)·정답·허용 답안·채점 기준·기존(사람이 쓴) 해설·출처 구절(`question_sources`의 발행 블록), 그리고 ASK와 같은 검색 파이프라인으로 찾은 교재 근거(검색어 = 발문 + 정답 보기 글, 상위 `AI_EXPLANATION_TOP_K` 기본 5개, 합계 8,000자, 문제지·`mixed` 문제 구간·요약·정리 노트 제외 — ASK-01 "검색 범위"와 같은 규칙). **사용자가 고른 답은 넣지 않는다**(아래 공유 해설). 모델은 근거를 `[S1]`…로 인용하고 ASK-01-C04와 같은 인용 검증을 거친다.
- **해설 내용 (사용자 결정 2026-11-01: 모든 보기를 다룸):** 공유 해설은 (1) 정답 이유, (2) **보기마다** 맞는/틀린 이유(객관식; 단답·서술형은 채점 기준의 핵심과 흔한 오답), (3) 관련 개념 한두 문단, (4) 출처. 문서에 근거가 없는 부분은 "문서에서 근거를 찾지 못했습니다"라고 적고 지어내지 않는다. 기존 해설과 다른 정답을 말하지 않는다 — 모델은 정답을 바꿀 수 없고, 서버의 정답이 기준이다(정답 option ID와 다른 결론이 나오면 `explanation_answer_mismatch`로 실패 처리, 아래 C04).
- **"내 답은 왜 틀렸나" (사용자 결정 2026-11-01: 공유 해설에는 없음):** 공유 해설에는 개인 내용이 없으므로 사용자별 부분은 v1에 두지 않는다. 대신 AI 해설 아래에 `AI 질문하기`(ASK-01, `practice` 첨부 — 제출 후라 공개 수준 `full`이고 사용자의 답이 들어간다)를 둔다(사용자 결정 2026-11-01, 유지). 풀이 panel에서 `질문하기`로 가는 유일한 경로이며 제출 뒤에만 보인다 — ASK-01 결정 (9)(풀이 panel header에는 없음)와 어긋나지 않는다.
- **AI 생성 표시:** 해설은 사람의 승인 없이 바로 보이고 편집할 수 없다. `AI 생성` 글자 badge와 "AI가 만든 해설입니다. 정답과 기존 해설이 기준이며, 틀릴 수 있습니다." 안내. 사람이 쓴 해설(문제의 `explanation`)을 바꾸거나 대신하지 않는다 — 문제은행·정리 노트(CHNOTE 입력)·ASK 검색 근거에 들어가지 않는다.
- **환경별 사용 여부 (사용자 결정 2026-11-01):** 자기 플래그 `WORKER_AI_EXPLANATIONS`(api·worker 같은 값, 기본 꺼짐)와 LLM 설정이 있을 때만 만든다(ASK의 `WORKER_ASK_LLM`과 따로 켬). 꺼진 환경에서는 버튼 대신 "이 환경에서는 AI 해설을 사용할 수 없습니다."를 보이고 이미 만든 해설은 읽힌다. **staging·production에서 켜는 것은 ⛔ 사용자 승인 후**(runbook-deploy §12).

### 캐싱 (사용자 결정 2026-11-01: 문제 revision마다 Workspace 공유 하나)

- **키:** `(question_revision_id, prompt_version, model)`. 문제를 고치면(새 question_revision) 키가 바뀌어 예전 해설은 그 문제에 더는 보이지 않고 다시 만들어야 한다(예전 행은 남음 — 이력). `LLM_MODEL`이나 prompt 버전이 바뀌어도 새 키다. 근거 문서가 새로 발행되어도 해설은 그대로이며, 출처 링크에 "이 출처는 이전 발행본입니다."가 붙는다(ASK와 같음).
- **범위:** 문제 revision 하나에 Workspace 공유 해설 하나 — 한 구성원이 만들면 그 문제를 제출한 다른 구성원은 LLM 호출 없이 같은 해설을 본다(비용 1회). 구성원 누구나(보기 권한 포함) 처음 만들 수 있다.
- **저장:** Postgres `question_ai_explanations`(이력 포함, 아래 architecture). 지우지 않는다(문제 삭제 시에만 함께 지움).
- **동시 요청:** 두 사용자가 동시에 눌러도 생성은 하나다: 대기·실행·성공 상태의 행은 키마다 하나(partial unique)이고 `POST`는 `INSERT … ON CONFLICT DO NOTHING` 뒤 기존 행을 돌려준다(Workspace·revision advisory lock 안). 두 번째 요청은 같은 해설 id와 같은 stream을 받아 진행 중인 글자를 이어 본다. 실패한 행은 막지 않는다(다음 요청이 새 행으로 다시 만든다).
- **다시 만들기 (사용자 결정 2026-11-01):** 편집 권한(owner·editor)이고 활성 Workspace일 때만 성공한 해설에 `다시 만들기`가 있다. 새 버전 행을 만들고 이전 버전에 `superseded_at`을 적는다(구성원은 최신만 봄). 한도: 같은 문제 revision에 하루 3번, 사용자 분당 한도 공유.
- **공유·Fork (사용자 결정 2026-11-01):** 공유 링크 게스트는 발행된 확정 문제의 **이미 만든** 최신 해설을 공유 문제 panel에서 읽기 전용으로 본다(게스트는 이미 정답·해설을 본다 — workspace-sharing §1). 게스트는 만들 수 없다(버튼 없음, 비용 없음). Fork는 snapshot의 문제 revision에 해당하는 최신 성공 해설을 새 id로 복제한다(출처 블록 id 재매핑, 이전 버전·실패·usage 제외).

### 모의고사 문제 (사용자 결정 2026-11-01 (27); ASK-SYNC 2026-11-02에 지금 모의고사 데이터에 맞춤 — 이전 ASK-QM을 EXPL-B·EXPL-W에 합침)

모의고사 풀이(QuestionViewer `sequence(mock)`)에서도 제출 후 같은 영역이 나온다(AC07).

- **키·저장:** 모의고사 문제는 문제은행 밖의 별도 테이블(`mock_exam_questions`·`mock_exam_question_revisions`, MOCK-01)이므로 해설도 별도 테이블 `mock_exam_question_ai_explanations`에 둔다. 키 `(mock_exam_question_revision_id, prompt_version, model)`, 상태·버전·`superseded_at`·동시성 규칙은 `question_ai_explanations`와 같다. 원본 등록 문제의 해설과 **공유하지 않는다** — `보기 섞기` 문제도 원본과 다른 행이다(모의고사 문제는 원본을 편집·삭제해도 바뀌지 않는 별개 문제 — questions.md §11). 모의고사를 다시 만들면(새 회차) 문제가 새로 생기므로 새 키, 모의고사 문제를 편집하면(새 revision) 새 키다.
- **입력:** 그 revision의 발문·보기·정답·허용 답안·채점 기준·해설과 `evidence`(SourceEvidence) 중 이 Workspace의 살아 있는 `book` 문서의 현재 발행 revision에 있는 블록(Postgres에서 다시 읽음; `evidence.quote` 글과 문제지·가져온 문제 PDF 쪽 근거는 쓰지 않음), 그리고 같은 검색 근거. 정답 일치 검증(C04)은 그 revision의 `correct_option_ids` 기준.
- **제출 확인·인가:** `mock_practice_session_id`(그 사용자의 그 모의고사 문제 session, `mock_exam_attempts` 있음 — 채점 대기 포함)가 없으면 409 `explanation-before-submit`, 남의 session 404. 읽기·만들기는 모든 구성원(모의고사를 볼 수 있는 사람), 보관된 Workspace는 읽기만, 다시 만들기는 편집 권한. 삭제된 모의고사·모의고사에서 빠진 문제는 404(MOCK-P의 "삭제된 모의고사의 단독 session은 정답을 보내지 않음"과 같은 판정).
- **모의고사 문제 관리(`manage(mock)`, 편집 권한) (사용자 결정 2026-11-02, ASK-SYNC (a)):** 정답이 이미 보이는 화면이므로 "문제 상세"와 같이 제출 없이 `AI 해설`을 둔다(`view: manage`, 편집 권한·활성 Workspace 판정 — 보기 권한 403).
- **공유·Fork:** 모의고사는 공유 링크 게스트에게 없고 Fork에 복제되지 않으므로(workspace-sharing §9) 모의고사 문제의 AI 해설도 공유 API·Fork 복제가 없다.
- 활동 기록은 등록 문제와 같은 "AI 해설 만듦"(`mock_exam.ai_explanation_generated`, id·버전만).

### "문제 상세" dialog (사용자 결정 2026-11-01)

구성원은 문제 상세 dialog(QuestionViewer `manage`, QVIEW-01 호출 위치 4 — 풀이 panel 메뉴의 `정답·해설 보기`·`수정 이력·출처` — 와 5 — `보관·초안 문제` dialog의 행)에서 이미 정답·해설을 본다(UX7-BANK-2). dialog의 해설 아래에도 `AI 해설`을 둔다: 서버는 `view: detail`을 받으면 `GET /questions/{id}` 권한(모든 구성원)으로 판정하고 제출을 요구하지 않는다. 같은 캐시를 쓴다. 지난 버전 미리보기(`수정 이력`의 버전 toggle)에는 AI 해설이 없다 — 지금 revision의 것만.

- **보관(ARCHIVED) 문제:** 호출 위치 5에서 같은 영역을 보인다(그 revision의 캐시). 중복 정리로 보관된 중복(UX7-DEDUP)도 자기 revision의 해설만 보이고, 남길 문제의 해설과 섞이지 않는다 — 남길 문제는 자기 revision의 해설 하나만 보인다(합쳐진 풀이 기록은 학습 상태만 합치고 문제 내용·캐시는 합치지 않음, questions.md §10.2). 보관 해제하면 그대로 자기 해설이다. 공유 게스트에게는 보관 문제가 없다.
- **초안(DRAFT) 문제 (사용자 결정 2026-11-02, ASK-SYNC (b)):** 호출 위치 5의 초안 상세에는 `AI 해설`을 두지 않는다 — 초안은 사람이 승인하기 전이고(AGENTS.md §5) 정답이 비어 있을 수 있어 정답 일치 검증(C04)을 할 수 없다. 서버는 DRAFT 문제의 `view: detail` 요청을 409 `explanation-unavailable`로 거절한다(행·job·LLM 호출 없음). `질문하기`는 초안 상세에도 그대로 있다(ASK-01). 보관(ARCHIVED) 문제는 위와 같이 AI 해설을 보인다.

### 한도와 비용 (사용자 결정 2026-11-01)

| 항목 | 기본값 | 넘으면 |
|---|---|---|
| 새로 만들기(캐시 없음) 분당 `AI_EXPLANATION_RATE_LIMIT_PER_MINUTE` | 사용자당 6 | 429 + Retry-After, "잠시 후 다시 시도하세요 (n초)" |
| 하루 새로 만들기 `AI_EXPLANATION_DAILY_LIMIT_PER_USER` | 30 (캐시 읽기는 무제한) | 429 `explanation-daily-limit`, "오늘 만들 수 있는 AI 해설을 모두 만들었습니다." |
| 다시 만들기 | 문제 revision당 하루 3번(편집 권한) | 409 `explanation-regenerate-limit`, "오늘은 이 문제의 해설을 더 다시 만들 수 없습니다." |
| 월 token 상한 `AI_EXPLANATION_MONTHLY_TOKEN_CAP` | 0 = 끔 | 409 `explanation-budget-exceeded`, "이번 달 AI 해설 사용량을 모두 썼습니다." |

거절 문구 세 개(하루 한도·다시 만들기 한도·월 상한)는 사용자 결정 2026-11-03(EXPL-W).
| 모델 출력 `AI_EXPLANATION_MAX_OUTPUT_TOKENS` · effort | 1,500 token · `low` | 잘리면 "(해설이 길어 잘렸습니다)" |

- **비용 가늠** (`claude-sonnet-5-5`, 입력 $2 · 출력 $10 / 1M token, 2026-10 공개 가격): 해설 하나 ≈ 입력 6k~9k token(지시 1.5k + 문제 1k + 근거 8,000자 ≈ 4k~6k) + 출력 1k~1.5k → **약 $0.02~0.03, 문제 revision마다 한 번**(공유 캐시). 1,000문제 Workspace에서 모든 문제를 한 번씩 만들면 약 $20~30.

## 레이아웃 및 컴포넌트

- **위치:** QuestionViewer 결과 영역(결과 글자·정답 표시·해설 — 공통 문제 본문 부품 `QuestionBody`) 바로 아래, footer(`다음`·`제출` 등) 위. 그 아래에 [RELSRC-01](related-sources.md) "관련 본문"(접힌 채로, 펼칠 때 불러옴 — 2026-11-04). 영역 제목 `AI 해설`(`h3`). 모든 방식이 같은 부품을 쓴다: `practice`·`sequence(bank|mock)`는 제출 뒤(`이전`·결과 목록으로 돌아간 읽기 전용 결과 포함 — 그 위치의 제출한 session으로 요청), `manage`는 해설 아래(제출 없이), `read-only`는 있는 해설만. `sequence`에서 다음 위치로 가면 영역은 그 문제의 것으로 바뀐다(진행 중인 생성은 계속되고 돌아오면 이어 보인다).
- **구성 (사용자 결정 2026-11-04):** 영역 전체는 접근성 이름 "AI 해설"인 group이고 그 안에 (1) 도구 줄 — 글자 버튼 `AI 해설`(해설이 없고 만들 수 있을 때만) 옆에 `AI 질문하기`(ASK-01 `practice` 첨부, ASK가 켜진 환경 — 해설 유무와 상관없이 항상) — 과 (2) 해설 내용 영역(`h3` `AI 해설` region)이 따로 있다. 내용 영역은 보일 내용(캐시·진행·완료·실패)이 있을 때만 그려지고, 해설이 없으면 도구 줄(과 안내)만 보인다.
- **상태:**
  - 만든 적 없음: 글자 버튼 `AI 해설`(접근성 이름 "AI 해설"; 이전 이름 `AI 해설`). 자동 생성하지 않는다.
  - 이미 있음(캐시) (사용자 결정 2026-11-01, UX12 EXPL-1 개정 2026-11-06): 도구 줄 바로 아래 영역 제목 `AI 해설`이 곧 접기/펼치기 버튼이다(`aria-expanded`, 기본 펼침, 글자 + chevron, RELSRC-01 "관련 본문"과 같은 공용 disclosure). `AI 해설 보기` 버튼은 없다. 제목 버튼은 완료된 해설에만 있고 만드는 중·실패의 제목은 일반 글자다([UX12-EXPL](ux12-explanations.md)).
  - 만드는 중: "작성중..." 글자 + 받은 글자를 이어 붙임(ASK-01과 같은 SSE·`aria-busy`·status 알림 규칙: 시작 한 번 "작성중...", 끝 한 번 "AI 해설이 준비되었습니다"). 다른 사람이 만드는 중이면 같은 stream을 이어 본다.
  - 완료: `AI 생성` badge, 안내 문구, 본문(Markdown 일부만, sanitize), 각주 `[1]`과 `출처` 목록(문서·장·쪽, 버튼 → "본문 발췌" panel → "PDF에서 보기"가 DOC-02 그 쪽 — 발췌와 PDF는 해설을 만들 때 인용한 문서 revision으로 열린다; 그 뒤 다시 발행되었으면 "이 출처는 이전 발행본입니다."), 메타 "<생성 시각> · 버전 k"(다시 만든 경우), 편집 권한이면 `다시 만들기`, (`AI 질문하기`는 위 도구 줄에 있다).
  - 실패: `role="alert"` 이유(ASK-01 오류 문구, `explanation_answer_mismatch` → "정답과 맞지 않는 해설이 나와 보여 주지 않았습니다. 다시 시도하세요.") + `다시 시도`.
  - 기능 꺼짐: 버튼 대신 "이 환경에서는 AI 해설을 사용할 수 없습니다."(이미 있는 해설은 보임).
  - 보관된 Workspace: 이미 있는 해설만, 만들기·다시 만들기 없음("보관된 Workspace에서는 새 AI 해설을 만들 수 없습니다.").
- 해설 영역은 결과 영역과 같은 panel scroll 안에 있고, `AI 해설`을 누르면 focus는 (내용 영역이 생긴 뒤) 영역 제목으로 가고 완료되어도 이동하지 않는다. 키보드: 버튼 Enter/Space, 각주·출처 Tab, 발췌 panel Escape로 닫으면 focus는 누른 출처로. 모바일 bottom sheet에서도 같은 순서, 가로 스크롤 없음.
- 공유 게스트: 공유 문제 미리보기(QuestionViewer `read-only`, non-modal — QVIEW-01 호출 위치 6)의 해설 아래 "AI 해설" disclosure(있을 때만, 기본 펼침, 위와 같은 제목 버튼). 만들기·다시 만들기·상태·오류·버전·비용 없음. 각주·출처는 글자로만 보인다(본문 발췌 panel 없음).

## 화면 상태

| 상태 | 편집 권한 | 보기 권한 | 공유 게스트 |
|---|---|---|---|
| 제출 전 | 없음(서버 409) | 없음 | (게스트는 제출이 없음 — 있는 해설만) |
| 제출 후 · 없음 | `AI 해설` + `AI 질문하기`(내용 영역 없음) | 같음 | 없음 |
| 만드는 중 | 진행·글자(누가 시작했든) | 같음 | 없음(완료만) |
| 완료 | 해설 + `다시 만들기` | 해설 | 읽기 전용 해설 |
| 실패 | alert + `다시 시도` | 같음 | 없음 |
| 문제가 수정됨(새 revision) | `AI 해설`(예전 해설은 안 보임) | 같음 | 새 revision 해설이 생길 때까지 없음 |
| 기능 꺼짐 | 이유 문구, 있는 해설 읽기 | 같음 | 있는 해설 읽기 |
| 보관된 Workspace | 있는 해설만 | 같음 | 공유 규칙 그대로 |

## 수용 기준

E2E는 `APP_ENV=test`의 결정적 fake 해설기(C08)를 쓴다.

### AIEXPL-01-AC01

- **Given:** 해설과 책 출처(장 1의 쪽)가 있는 확정 객관식 문제(보기 4개), 편집 권한자의 Workspace 홈, AI 해설이 켜진 환경
- **When:** Heatmap에서 문제를 열어 결과 영역을 확인하고, 보기를 골라 제출한 뒤 `AI 해설`를 두 번 빠르게 누르고 끝나기를 기다린다. 각주 `[1]`을 누른다
- **Then:** 제출 전에는 `AI 해설` 영역과 버튼이 없다. 제출 뒤 결과·정답·해설 아래에 `AI 해설` 제목과 버튼이 보인다. 누르면 "작성중..."을 거쳐 글자가 여러 번에 나눠 늘고(SSE `delta` 2개 이상), 끝나면 `AI 생성` badge·안내·보기 4개 각각의 설명·`[1]`·출처 줄을 보인다. 두 번 눌러도 생성은 하나다(fake 호출 1). `[1]`은 "본문 발췌" panel을 열고 "PDF에서 보기"는 DOC-02 그 쪽이다. status는 시작·끝에 한 번씩 알린다.

### AIEXPL-01-AC02

- **Given:** AC01과 같은 문제를 아직 제출하지 않은 사용자의 열린 풀이 panel(session 있음)
- **When:** 그 session id로 `POST /questions/{id}/ai-explanation`·`GET …/ai-explanation`을 직접 부르고, session 없이·다른 사용자의 제출한 session id로도 부른다. 그 뒤 제출하고 다시 부른다
- **Then:** 제출 전·session 없음은 409 `explanation-before-submit`, 다른 사용자의 session은 404이며 응답에 해설·정답이 없고 fake 해설기는 불리지 않는다(호출 수 그대로). practice-session 응답에는 여전히 정답·해설·AI 해설 필드가 없다. 제출 뒤에는 200/202다.

### AIEXPL-01-AC03

- **Given:** AC01에서 해설이 만들어진 문제, 같은 Workspace의 보기 권한 멤버 둘(A·B), 아직 해설이 없는 두 번째 문제, fake marker `E2E-EXPL-HOLD-<token>`(테스트가 풀 때까지 대기)
- **When:** A가 첫 문제를 풀어 제출하고 `AI 해설 보기`를 연다. 두 번째 문제(발문에 HOLD marker)를 A와 B가 각각 제출하고 거의 동시에 `AI 해설`를 누른 뒤 테스트가 hold를 푼다. 편집 권한자가 첫 문제의 해설(사람이 쓴 것)을 고쳐 저장한 뒤 A가 다시 풀어 제출한다
- **Then:** 첫 문제는 A에게 생성 없이 같은 해설이 보인다(fake 호출 수 변화 없음, 같은 해설 id). 두 번째 문제는 생성이 하나만 일어나고(fake 호출 1) A와 B 모두 같은 진행 글자와 같은 최종 해설을 본다. 문제를 고친 뒤(새 revision) A의 결과에는 예전 해설이 없고 `AI 해설`가 다시 보인다. 해설은 고른 답과 무관하게 같다(A가 오답, B가 정답이어도 같은 본문).

### AIEXPL-01-AC04

- **Given:** 해설이 있는 문제와 없는 문제가 있는 Workspace: 편집 권한자, 보기 권한 멤버, 보관된 Workspace의 Owner, 다른 Workspace의 사용자, 유효한 공유 링크 게스트
- **When:** 편집 권한자가 `다시 만들기`를 누르고(하루 한도까지 네 번), 보기 권한 멤버가 해설 없는 문제를 제출해 만들고 `…/regenerate`를 직접 부른다. 보관된 Workspace의 Owner가 제출 결과의 해설 영역을 보고 POST를 부른다. 다른 사용자가 그 문제의 해설 API를 부른다. 게스트가 공유 문제 panel을 열고 공유 해설 API를 부른다
- **Then:** `다시 만들기`는 새 버전(메타 "버전 2")을 보이고 네 번째는 409 `explanation-regenerate-limit`과 이유 문구다. 보기 권한은 새로 만들 수 있지만 `다시 만들기`가 없고 regenerate는 403이다. 보관된 Workspace에서는 있는 해설만 보이고 만들기가 없으며 POST는 403 `workspace-archived`다. 다른 사용자는 404다. 게스트는 해설이 있는 발행 문제에서 읽기 전용 "AI 해설"(만들기·다시 만들기·버전·오류 없음)을 보고, 없는 문제는 공유 API 404다.

### AIEXPL-01-AC05

- **Given:** fake marker `E2E-EXPL-FAIL`, 정답과 다른 보기를 정답이라고 말하는 marker `E2E-EXPL-MISMATCH`, 기능이 꺼진 환경(`WORKER_AI_EXPLANATIONS` off)과 켜져 있을 때 만든 해설, 테스트 stack의 분당 한도 2
- **When:** FAIL·MISMATCH 문제를 제출해 만들고 `다시 시도`를 누른다(두 번째는 성공하도록 설정). 해설 없는 문제 세 개를 1분 안에 만든다. 기능이 꺼진 환경에서 해설이 있는 문제와 없는 문제를 제출한다
- **Then:** FAIL은 alert "AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요."와 `다시 시도`, MISMATCH는 저장·표시되지 않고 "정답과 맞지 않는 해설이 나와 보여 주지 않았습니다. 다시 시도하세요."이며, `다시 시도`는 새 생성으로 성공한다. 세 번째 새 생성은 429 이유 문구(캐시된 해설 보기는 한도와 무관). 기능이 꺼진 환경에서는 없는 문제에 "이 환경에서는 AI 해설을 사용할 수 없습니다."(POST 409 `explanation-disabled`), 있는 문제는 해설이 그대로 보인다. 오류 화면·응답·로그에 LLM 응답 원문이 없다.

### AIEXPL-01-AC06

- **Given:** 해설이 없는 문제를 아직 풀지 않은 보기 권한 멤버, 키보드 전용 사용자, 휴대폰(iPhone Safari) 화면
- **When:** 풀이 panel의 `문제 정보` › `정답·해설 보기`로 연 "문제 상세" dialog에서 `AI 해설`를 키보드로 누르고 끝나기를 기다린 뒤 dialog를 닫는다. 휴대폰에서 문제를 제출하고 AI 해설을 만든다
- **Then:** 문제 상세 dialog에는 제출 없이도 `AI 해설`이 있고(`view: detail`, 정답이 이미 보이는 화면) 만든 해설은 같은 캐시라 다른 구성원의 제출 결과에도 보인다. 닫으면 focus가 메뉴 버튼으로 돌아오고 풀이 panel의 session은 그대로이며 풀이 기록이 생기지 않는다. focus는 만들기 후 `AI 해설` 제목에 있고 끝나도 옮겨지지 않는다. 휴대폰 bottom sheet에서 해설 영역이 결과 아래에 있고 가로 스크롤이 없으며 버튼은 24px 이상이다. axe 위반 0.

### AIEXPL-01-AC07

- **Given:** 해설·책 출처가 있는 확정 객관식 문제 2개(1장)와 그 둘로 만든 `보기 섞기` 모의고사(MOCK-01), 같은 Workspace의 보기 권한 멤버 둘(A·B), AI 해설이 켜진 환경
- **When:** A가 `문제` › `문제 풀기`로 두 문제를 시작해 첫 문제를 제출하고 `AI 해설`를 누른 뒤 끝나면 `다음`으로 갔다가 `이전`으로 돌아온다. A가 모의고사 `풀기`로 첫 문제를 열어 제출 전 `GET /mock-exam-questions/{id}/ai-explanation`을 그 session으로 직접 부르고, 제출한 뒤 `AI 해설`를 누른다. B가 같은 모의고사 문제를 제출한다. 편집 권한자가 그 모의고사 문제를 편집해 저장한 뒤 B가 다시 풀어 제출한다
- **Then:** 범위 풀이(`sequence(bank)`)의 제출 결과 아래에 `AI 해설`이 있고 풀이 panel과 같은 캐시다(그 문제를 Heatmap에서 제출하면 같은 해설 id, fake 호출 수 변화 없음). `이전`으로 돌아온 읽기 전용 결과에서도 그 해설이 보인다. 모의고사 문제는 제출 전 409 `explanation-before-submit`(fake 호출 없음), 제출 뒤 새로 만들어지며(fake 호출 1) 원본 등록 문제의 해설과 다른 해설 id다. B는 생성 없이 같은 해설을 본다. 편집으로 revision이 바뀐 뒤 B의 결과에는 예전 해설이 없고 `AI 해설`가 다시 보인다. 해설 생성은 `mock_exam_attempts`·`question_attempts`·Heatmap을 바꾸지 않는다.

## 계약 요구사항 (pytest·unit, 화면 AC 아님)

`tests/integration/questions/ai_explanations/test_ai_explanations_contract.py`, `apps/worker/tests`, `packages/core/tests`, `supabase/tests`(pgTAP).

| ID | 요구사항 |
|---|---|
| AIEXPL-01-C01 | **제출 확인:** `GET`·`POST /questions/{id}/ai-explanation`은 `practice_session_id`(그 사용자의 그 문제 session이며 제출 attempt가 있음) 또는 `view: detail`(`GET /questions/{id}` 권한)을 요구한다. 그 밖 409 `explanation-before-submit`(session 없음·미제출), 남의 session 404. 판정은 DB에서 하며 client 값은 믿지 않는다. 409에서는 행·job·LLM 호출이 없다. practice API 응답은 바뀌지 않고 AI 해설 id·본문을 담지 않는다. |
| AIEXPL-01-C02 | **인가 matrix:** 읽기는 구성원(보관 Workspace 포함, C01 조건), 만들기는 구성원·활성 Workspace(보관 403, 삭제·다른 Workspace 404), 다시 만들기는 owner·editor·활성 Workspace. 공유 API는 발행된 CONFIRMED 문제의 active revision에 대한 최신 성공 해설만(그 밖 404), 상태·버전·오류·usage 없음, 매 요청 링크 재검증. 기능 꺼짐 409 `explanation-disabled`. |
| AIEXPL-01-C03 | **캐시·동시성:** 키 `(question_revision_id, prompt_version, model)`. 대기·실행·성공 행은 키마다 하나(partial unique) — 동시 POST 20개가 행 하나·job 하나·LLM 호출 하나를 만들고 모두 같은 id를 받는다(경쟁 test). 성공 행이 있으면 POST는 생성 없이 그 행을 돌려준다(한도 검사 전, 하루 한도에 세지 않음). 실패 행은 막지 않는다. 문제 수정(새 revision)은 새 키. 다시 만들기는 새 버전 행 + 이전 `superseded_at`(지우지 않음), revision당 하루 3번. |
| AIEXPL-01-C04 | **입력과 검증:** 입력은 고정된 question revision의 발문·보기·정답·허용 답안·채점 기준·사람 해설·발행 출처 블록 + ASK 검색 규칙의 근거(문제지·`mixed` 문제 구간·요약·노트 제외). 사용자의 답·풀이 기록은 입력이 아니다(공유 해설). 출력 schema는 `{correct_option_ids, summary_md, options[{option_id, why_md}], concepts_md}`(객관식) 또는 유형별 필드이고, `correct_option_ids`가 문제의 정답과 다르면 `explanation_answer_mismatch`로 실패(저장·표시 안 함). 보기 설명은 문제의 모든 option id를 정확히 한 번씩 다룬다(아니면 1회 재요청 후 실패). 인용은 ASK-01-C04와 같은 검증. |
| AIEXPL-01-C05 | **streaming:** ASK-01-C05와 같은 SSE·Redis Stream 계약(`GET /ai-explanations/{id}/stream`, 인가는 C01·C02로 연결마다 재확인). 진행 중인 해설에 붙은 두 번째 사용자도 처음부터(`seq` 0) 받는다. |
| AIEXPL-01-C06 | **유출 금지·기록:** 문제·정답·해설·근거 본문·prompt·LLM 응답은 로그·job 결과·trace·활동 기록에 없다. 생성마다 `llm_feature_usage` 행(`feature = ai_explanation`). 활동 기록은 `question.ai_explanation_generated`(id·버전만; 이력 dialog에 "AI 해설 만듦"). |
| AIEXPL-01-C07 | **Fork:** snapshot의 문제 revision에 해당하는 최신 성공 해설만 새 id로 복제(question·revision·출처 블록 id 재매핑). 이전 버전·실패·usage는 복제하지 않는다. |
| AIEXPL-01-C08 | **결정적 fake (`APP_ENV=test`만):** 정답 보기 글과 상위 근거 첫 문장으로 보기마다 한 줄을 만들어 정해진 덩어리로 흘린다. marker(문제 발문): `E2E-EXPL-FAIL`, `E2E-EXPL-MISMATCH`, `E2E-EXPL-HOLD-<token>`, `E2E-EXPL-SLOW`. 호출 수는 test 전용 기록 디렉터리로 확인. |
| AIEXPL-01-C09 | **모의고사 문제 (EXPL-B, ASK-SYNC — 이전 ASK-QM):** `mock_exam_question_ai_explanations` 키 `(mock_exam_question_revision_id, prompt_version, model)`(C03과 같은 partial unique·동시성·버전 규칙), `GET`·`POST /mock-exam-questions/{id}/ai-explanation`(+ `/regenerate`)은 `mock_practice_session_id`(그 사용자의 그 문제 `mock_exam_practice_sessions`, `mock_exam_attempts` 있음) 또는 `view: manage`(편집 권한·활성 Workspace, 제출 없이 — ASK-SYNC (a))를 요구하고 그 밖 409 `explanation-before-submit`, 남의 session·다른 Workspace·삭제된 모의고사·빠진 문제 404. 입력은 그 revision과 `evidence` 중 현재 발행 `book` 블록만(quote 글·문제지·가져온 문제 PDF 근거 제외). 등록 문제 해설과 행을 공유하지 않는다(원본 revision의 해설이 있어도 새로 만듦 — test). 공유 API·Fork 복제 없음. 모의고사 practice API(`/mock-exam-questions/{id}/practice-sessions`·`/mock-practice-sessions/{id}/submit`) 응답 schema 불변. EXPL.0에서 pytest `red`, EXPL-B에서 GREEN. |

## Test-first 규칙

- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 구현한다(EXPL.0). 정답·해설이 보이는 화면의 품질 spec은 trace·screenshot·video와 page text 첨부를 끈다.

# 폐지된 화면 QGEN-01 — 문제 변형 출제

**상태:** 폐지 — QGEN-RM 2026-11-02 (MOCK-SPEC 2026-11-01 사용자 결정 1: 변형 출제·"문제 생성" dialog 삭제, 대신 [모의고사 MOCK-01](mock-exams.md)). 이 문서는 화면 요구사항이 아니라 폐지 기록이다(화면 표 `index.md`와 `e2e:trace` 대상에서 빠짐 — 제목이 화면 ID로 시작하지 않는다). 이전 판: 확정 화면 요구사항 v1.3 · UX3c 2026-10-20 (문제 생성 dialog) · UX4 2026-10-21 (`문제` 메뉴의 변형 출제) · QGEN-MULTI 2026-10-23 (묶음 변형 출제) · UX7-BANK 2026-11-01.
**이전 Route:** 검토 페이지 `/workspaces/:workspaceId/questions/generate?source=&run=` · 묶음 결과 페이지 `/workspaces/:workspaceId/questions/generate?batch=` · 문제 생성 dialog `/workspaces/:workspaceId?panel=generate`
**연계:** [모의고사 MOCK-01](mock-exams.md), [Workspace 홈](questions-overview.md), [문제 풀이 panel](questions-practice.md)

## 폐지 (MOCK-SPEC 2026-11-01 → QGEN-RM 2026-11-02)

사용자 요청 "변형 출제 -> '문제 생성' 삭제 / 대신 '모의고사' 기능 추가". 이 화면의 모든 진입점과 묶음 변형 출제(QGEN-MULTI)는 Task **QGEN-RM**에서 없어졌다. 생성 엔진의 재사용·폐지 목록은 [MOCK-01 "재사용과 폐지"](mock-exams.md)가 기준이다.

- **없어진 것 (화면):** Workspace header `문제` 메뉴의 `변형 출제`, 풀이 panel `문제 관리` 메뉴의 `변형 출제`(UX7-BANK — 지금 메뉴는 `정답·해설 보기`·`수정 이력·출처` | `편집`·`보관` | `삭제`, QPLAY-01), "문제 생성" non-modal dialog(`한 문제`·`여러 문제`·`임의 선택` tab, 보기 섞기 미리보기), 검토 페이지(원본 diff·근거·검증 상태·승인·등록), 묶음 결과 페이지, 그 BFF route.
- **없어진 것 (API·worker):** `POST /questions/{id}/generations`, `GET /workspaces/{id}/question-generations`, `/question-generations/{id}`(·`/drafts`·`/publish`), `/workspaces/{id}/question-generation-batches`(·`/{batch_id}`) — 모두 404. worker의 `question.generate` job 등록. 후속 UX8-QGEN-DEAD(2026-11-02): worker job module·run store, API 생성 초안 재검증·repository, `QUESTION_GENERATION_BATCH_RATE_LIMIT_PER_MINUTE` 설정을 지웠고 `PATCH /question-drafts/{id}`는 생성 초안에 404를 돌려준다(import 초안만). 이미 대기열에 남은 `question.generate` job은 reconciler가 `failed`(`job_retired`)로 끝낸다(이력에는 실패한 작업으로 남는다).
- **남는 것:** 테이블과 기존 행(`question_generation_runs`·`question_generation_batches`·`source_type = generation` 초안, 이미 등록된 변형 문제와 lineage) — drop migration 없음. 원본·passage·근거 helper(`quiz_worker.question_sources`)와 `book_core.generation` 검증은 모의고사 생성(`mock_exam.generate`)이 쓴다. 이력의 지난 `question.generate` 작업 label("변형 문제 생성")도 남는다.
- **이전 URL (한 번의 redirect):** `?panel=generate` → `?panel=mock-exams`(다른 query는 유지; 모의고사 dialog가 이미 열려 있으면 한 번만), `/workspaces/:workspaceId/questions/generate?…` → `/workspaces/:workspaceId?panel=mock-exams`(이전 query는 버린다). Workspace 접근 확인은 홈과 같다(비구성원·삭제된 Workspace는 404).
- **테스트:** `tests/e2e/questions/questions-generation.spec.ts`, `tests/e2e/fixtures/generation.ts`, QGEN 계약·통합 test(`tests/integration/questions/test_generation_*.py`), web 단위 test를 지웠다. `scripts/e2e-trace.ts` PHASES와 CI `E2E_PHASES`에서 `M6.0`을 뺐다. 메뉴·redirect의 확인은 MOCK-01-AC01과 QOV-01-AC09·AC10·AC11·AC13이 맡는다.

## AC별 처리

| AC | 처리 | 이어받는 곳 |
|---|---|---|
| QGEN-01-AC01 (보기 섞기는 새 문제·Heatmap 점을 만들지 않음) | 폐지(보기 섞기 생성 진입점이 없어짐) | 불변식은 QOV-01-AC01("보기 셔플로 점 개수가 증가하지 않는다")과 QPLAY-01-AC02가 계속 검증한다. 모의고사의 `보기 섞기`는 MOCK-01-AC06. |
| QGEN-01-AC02 (문구 변형 diff·근거·정답 검증 표시) | 폐지(사람 검토 화면 없음) | 검증은 MOCK-01-C02의 저장 조건으로, 결과는 MOCK-01-AC02(출처 표시). |
| QGEN-01-AC03 (정오 반전 복수 정답 경고·승인 차단) | 폐지(승인 단계 없음) | MOCK-01-AC08·C02: 복수 정답 후보는 저장·표시되지 않는다. |
| QGEN-01-AC04 (유사 개념 승인 → lineage 있는 새 확정 문제) | 폐지(은행 등록 경로 없음 — 사용자 결정 2) | MOCK-01-C01(은행 격리). 이미 등록된 변형 문제·lineage는 그대로. |
| QGEN-01-AC05 (`문제` 메뉴 `변형 출제` → "문제 생성" dialog) | 폐지 | MOCK-01-AC01(`모의고사` 메뉴·dialog, `?panel=generate` redirect), QOV-01-AC10·AC11 문구는 QGEN-RM에서 `변형 출제` → `모의고사`로 고쳤다. |
| QGEN-01-AC06~AC08 (QGEN-MULTI 묶음: 여러 문제 선택·임의 선택·묶음 결과) | 폐지 | 여러 원본 고르기는 MOCK-01-AC03(범위·`전체 선택`), 임의 선택은 MOCK-01 문항 수 + seed(C03). |

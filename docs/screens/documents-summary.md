# DOCSUM-01 — 문서 요약 Floating Side Panel

**상태:** 확정 화면 요구사항 v1.0 · DOCSUM-SPEC 신규 2026-10-29 (사용자 요청 "내용 요약 제공 — 문서 내용 변경될 때마다 새로 요약 생성 및 저장", 사용자 결정 Q1·Q10 "모두 홈에서 볼 수 있게")
**Route:** `/workspaces/:workspaceId?panel=document-summary&document=:documentId` (Workspace 홈 위 non-modal panel; 진입은 문서 관리 dialog 행의 `요약` 버튼과 DOC-02 header의 `요약` 링크) · 공유 게스트는 `/share/:shareId?panel=document-summary&document=:documentId`
**테스트:** `tests/e2e/documents/documents-summary.spec.ts` (계약: `tests/integration/documents/test_document_summary_contract.py`, `apps/worker` · `packages/core` unit test)
**Phase:** DOCSUM.0 (RED) → DOCSUM-B → DOCSUM-W
**연계:** [전체 아키텍처](../architecture.md) §5·§6, [DOC-01](documents-library.md), [DOC-02](documents-editor.md), [공유 명세](../workspace-sharing.md) §8, [디자인 시스템](../design-system.md) §5, [E2E 규칙](../e2e-strategy.md)

```yaml
id: DOCSUM-01
route: /workspaces/:workspaceId?panel=document-summary&document=:documentId
actor: workspace_member (보기) · editor/owner (요약 만들기·다시 시도) · share guest (발행본 요약 보기)
permission: read · edit
status: confirmed
api: [GET /api/v1/documents/:id/summary, POST /api/v1/documents/:id/summary, POST /api/v1/documents/:id/summary/retry, GET /api/v1/shared/:shareId/documents/:docId/summary]
components: [FloatingSidePanel, Button, Disclosure, StepProgress, Badge]
linked_tests: [DOCSUM-01-AC01 … DOCSUM-01-AC07]
```

## 목적과 정책

- 교재(`교재`·`교재+문제`) 문서의 **발행본**을 요약한다: 문서 전체 요약 하나 + 최상위 장(outline 깊이 1)마다 장 요약 하나(사용자 결정 Q2 기본값). 각 요약은 짧은 본문(Markdown 일부)과 핵심 항목 목록이며, 핵심 항목마다 근거 쪽(`p.12–14`)을 단다. 요약 언어는 원문 언어를 따른다(Q8).
- **opt-in 후 자동 재생성 (사용자 결정 Q1 2026-10-29):** 문서마다 편집 권한자가 `요약 만들기`를 한 번 눌러야 요약이 생긴다(`documents.summary_enabled_at`). 한 번이라도 요약을 만든 문서는 그 뒤 새 revision이 발행될 때마다(DOC-02 교정 발행, 이전 revision 복원) 서버가 자동으로 새 요약을 만들어 저장한다. 내용이 바뀌지 않은 장의 요약은 다시 만들지 않고 재사용한다(장 입력의 content hash 기준, 증분). `요약 만들기`를 누르지 않은 문서는 어떤 경우에도 본문을 LLM으로 보내지 않는다. 교정 중 초안(draft)은 요약하지 않는다.
- **이전 요약 유지:** 새 요약을 만드는 동안과 새 요약이 실패한 동안에는 마지막으로 성공한 요약을 그대로 보이며 "이전 발행본 기준" 안내를 단다(stale). 이전 요약은 지우지 않는다(revision별 기록).
- **AI 생성 표시:** 요약은 사람이 승인하지 않고 바로 보이며 편집할 수 없다. panel header에 글자 badge `AI 생성`을 둔다.
- **대상 아님:** `문제지`(문제만 있는 PDF)는 요약하지 않는다(행에 `요약` 버튼 없음, API 409 `summary-not-applicable`). `교재+문제`는 문제 추출이 문제 구간으로 읽은 장을 요약 입력에서 뺀다.
- **환경별 사용 여부:** 요약은 worker 설정 `WORKER_DOCUMENT_SUMMARY`가 켜져 있고 LLM(`LLM_API_KEY`·`LLM_MODEL`)이 설정된 환경에서만 만든다. 꺼진 환경에서는 `요약 만들기`가 비활성이고 이유를 보이며(아래 AC05), 이미 저장된 요약은 계속 읽을 수 있다. staging·production의 LLM 키 사용은 별도 사용자 승인 대상이다(implementation-plan §7).
- **공유 링크 게스트:** 현재 발행 revision의 성공한 요약만 읽을 수 있다(발행본 원문을 읽을 수 있으므로 같은 범위; 결정 기록 2026-10-29). 진행 상태·오류·이전 revision 요약·비용 정보는 보이지 않는다.

## 레이아웃 및 컴포넌트

- **진입:** 문서 관리 dialog(DOC-01)의 준비 완료 `교재`·`교재+문제` 행마다 `요약` 버튼(글자 버튼, 접근성 이름 "<제목> 요약", 모든 구성원). 요약이 진행 중이면 버튼 옆에 "요약 중" 글자 상태. DOC-02 header의 `요약` 링크는 같은 Workspace 홈의 이 panel을 연다(`/workspaces/:id?panel=document-summary&document=:docId`).
- **panel:** 공통 `FloatingSidePanel`(non-modal, design-system §5.1). 다른 홈 dialog와 함께 열리고 나중에 연 것이 위(QOV-01-AC10 규칙). 한 번에 문서 하나만 연다(다른 문서의 `요약`을 누르면 같은 panel의 문서가 바뀐다). 즉시 열리고 데이터를 불러오는 동안 `aria-busy` skeleton과 "불러오는 중"(QOV-01-AC09).
  - header: 제목 "문서 요약", 부제 문서 제목, `AI 생성` badge, 메타 줄 "<발행 시각> 발행본 기준 · 장 n개", 닫기 버튼.
  - **전체 요약** 영역(`h3`): 요약 본문과 `핵심` 목록. 핵심 항목 끝의 쪽 링크(`p.12–14`, 접근성 이름 "12–14쪽 열기")는 DOC-02의 해당 쪽을 연다(게스트는 공유 문서 화면의 해당 쪽).
  - **장별 요약** 영역(`h3`): 최상위 장마다 disclosure 버튼(장 제목 + 쪽 범위, `aria-expanded`, 기본 접힘). 펼치면 장 요약 본문과 핵심 목록(쪽 링크). 본문이 없는 장은 "요약할 본문이 없습니다."
  - 요약 본문은 Markdown 일부(문단·목록·강조)만 렌더링하고 HTML·링크·이미지는 글자로 다룬다(LLM 출력 sanitize).
- **상태 줄과 동작(편집 권한):** 요약 없음 → "아직 요약이 없습니다." + 안내 "요약을 만들면 이후 교정본을 발행할 때마다 요약이 자동으로 다시 만들어집니다. 본문이 AI 서비스로 전송됩니다." + `요약 만들기`. 대기 → "요약 대기 중". 실행 → "요약을 만드는 중 · 장별 요약 3/7"과 진행 막대(`role="progressbar"`, 이름 "요약 진행률"). 실패 → alert "요약을 만들지 못했습니다" + 이유 + `다시 시도`. 상태는 색이 아니라 글자로 전달한다.
- **stale 안내:** 보이는 요약이 현재 발행 revision의 것이 아니면 요약 위에 `role="status"` 안내 "이전 발행본 기준 요약입니다." + 진행 중이면 " 새 발행본의 요약을 만드는 중입니다.", 실패면 " 새 요약을 만들지 못했습니다."(편집 권한에 `다시 시도`).
- **오류 이유 문구:** `llm_unavailable`·`llm_timeout` → "AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.", `summary_too_large` → "문서가 너무 커서 요약할 수 없습니다.", `llm_invalid_output` 그 밖 → "요약을 만들지 못했습니다. 다시 시도하세요."
- 키보드: panel 안 Tab 순서 header → 전체 요약 → 장 disclosure → 동작 버튼; Escape(focus가 안에 있을 때)·닫기 버튼으로 닫고 focus를 연 버튼으로 돌린다. 모바일은 FloatingSidePanel 규칙(full-height, safe-area).

## 화면 상태

| 상태 | 편집 권한 | 보기 권한 | 공유 게스트 |
|---|---|---|---|
| 요약 없음(opt-in 전) | 안내 + `요약 만들기` | "아직 요약이 없습니다." | `요약` 버튼 없음 |
| 대기·실행(첫 요약) | 상태 줄·진행 막대 | 같은 상태 줄(버튼 없음) | `요약` 버튼 없음 |
| 성공(현재 revision) | 요약 | 요약 | 요약(읽기 전용) |
| 새 revision 요약 진행·실패 | 이전 요약 + stale 안내(+`다시 시도`) | 이전 요약 + stale 안내 | `요약` 버튼 없음(현재 revision 요약이 아님) |
| 실패(성공한 요약 없음) | alert + `다시 시도` | alert(버튼 없음) | 버튼 없음 |
| 기능 꺼짐(환경) | `요약 만들기` 비활성 + 이유, 기존 요약 읽기 | 기존 요약 읽기 | 기존 현재 revision 요약 읽기 |
| 보관된 Workspace | 읽기 전용(버튼 없음) | 읽기 전용 | 공유 규칙 그대로 |
| 문제지·처리 중·실패 문서 | `요약` 버튼 없음 | 같음 | 같음 |
| 다른 Workspace·삭제 문서 딥링크 | panel에 "문서를 찾을 수 없습니다." | 같음 | 같음 |

## 수용 기준

### DOCSUM-01-AC01

- **Given:** 편집 권한자가 연 Workspace 홈, 요약을 만든 적 없는 준비 완료 교재(합성 `book-ko.pdf`, 최상위 장 2개 이상), 테스트 환경의 결정적 fake 요약기
- **When:** 문서 관리 dialog에서 `<제목> 요약`을 누르고, panel의 `요약 만들기`를 두 번 빠르게 누른 뒤 완료를 기다린다
- **Then:** panel이 데이터를 기다리지 않고 바로 열리고(`?panel=document-summary&document=<id>`) "아직 요약이 없습니다."와 본문 전송 안내, `요약 만들기`를 보인다. 누르면 "요약 대기 중" → "요약을 만드는 중 · 장별 요약 k/n"을 거쳐 `AI 생성` badge, "<발행 시각> 발행본 기준", 전체 요약과 핵심 목록, 최상위 장마다 disclosure(장 제목·쪽 범위)를 보인다. 두 번 눌러도 요약 run은 하나다(Idempotency-Key). 핵심 항목의 쪽 링크를 누르면 DOC-02가 그 쪽을 연다. panel을 Escape로 닫으면 focus가 `<제목> 요약` 버튼으로 돌아온다.

### DOCSUM-01-AC02

- **Given:** 요약이 성공한 교재(장 A·B), 그리고 요약을 만든 적 없는 다른 교재
- **When:** 편집 권한자가 DOC-02에서 장 B의 블록 하나를 교정해 발행하고 바로 홈의 요약 panel을 연다. 다른 교재도 교정해 발행한다
- **Then:** 사용자가 아무것도 누르지 않아도 새 발행 revision의 요약이 시작되고, 그동안 panel은 이전 요약을 그대로 보이며 "이전 발행본 기준 요약입니다. 새 발행본의 요약을 만드는 중입니다."를 알린다. 완료되면 안내가 사라지고 메타 줄이 새 발행 시각으로 바뀌며 장 B 요약에 교정한 내용이 반영된다. 바뀌지 않은 장 A의 요약은 다시 만들지 않는다(요약 API `reused_units` ≥ 1, fake 요약기 호출은 장 B와 문서 전체만). 요약을 만든 적 없는 다른 교재는 발행해도 요약 run이 생기지 않고 fake 요약기가 호출되지 않는다.

### DOCSUM-01-AC03

- **Given:** 요약이 성공한 교재와, 실패 marker(`E2E-FAIL-SUMMARY`) 블록을 교정으로 넣어 발행하면 fake 요약기가 실패하는 상태, 보기 권한자
- **When:** 편집 권한자가 marker를 넣어 발행하고 요약 panel을 연다. 보기 권한자도 같은 panel을 연다. 편집 권한자가 marker를 지운 교정본을 발행하지 않고 `다시 시도`를 누른 뒤, marker를 지운 교정본을 발행한다
- **Then:** 새 요약이 실패하면 이전 요약이 남아 있고 "이전 발행본 기준 요약입니다. 새 요약을 만들지 못했습니다."와 이유("요약을 만들지 못했습니다. 다시 시도하세요.")가 alert로 보이며 편집 권한자에게만 `다시 시도`가 있다. `다시 시도`는 같은 revision의 새 run을 시작한다(다시 실패하면 같은 안내). marker를 지운 발행 후에는 자동으로 새 요약이 성공해 stale 안내가 사라진다. 실패 이유·오류 코드 외의 본문·LLM 응답은 화면·API 응답·로그에 나오지 않는다.

### DOCSUM-01-AC04

- **Given:** 요약이 있는 교재와 없는 교재가 있는 Workspace의 보기 권한자, 그리고 같은 Workspace를 보관(archive)한 상태
- **When:** 보기 권한자가 두 문서의 요약 panel을 열고 `POST /documents/{id}/summary`·`/summary/retry`를 직접 부른다. Owner가 보관된 Workspace에서 요약 panel을 연다
- **Then:** 보기 권한자는 요약을 읽을 수 있지만 `요약 만들기`·`다시 시도`가 없고, 요약 없는 문서는 "아직 요약이 없습니다."만 보인다. 직접 부른 POST는 403이다. 보관된 Workspace에서는 Owner에게도 버튼이 없고 POST는 403이며 기존 요약은 그대로 읽힌다.

### DOCSUM-01-AC05

- **Given:** 요약 기능이 꺼진 환경(`WORKER_DOCUMENT_SUMMARY` off 또는 LLM 미설정)과, 기능이 켜져 있을 때 만든 요약이 있는 교재 하나, 요약이 없는 교재 하나
- **When:** 편집 권한자가 두 문서의 요약 panel을 열고, 요약이 있는 교재를 교정해 발행한다
- **Then:** 요약 없는 교재의 `요약 만들기`는 비활성(`aria-disabled`, focus 가능)이고 "이 환경에서는 AI 요약을 사용할 수 없습니다."를 연결된 설명으로 보이며, API는 `available: false`이고 POST는 409 `summary-disabled`다. 요약이 있는 교재는 기존 요약을 그대로 보이고, 발행해도 요약 run이 생기지 않으며 stale 안내 "이전 발행본 기준 요약입니다."만 붙는다(진행 중 문구 없음).

### DOCSUM-01-AC06

- **Given:** 현재 발행 revision의 요약이 성공한 교재와, 새 revision 요약이 아직 진행 중인 교재가 있는 Workspace의 유효한 공유 링크(비로그인 게스트)
- **When:** 게스트가 `/share/:shareId`의 문서 목록에서 `요약`을 누르고, 두 번째 교재의 요약 API(`GET /shared/{shareId}/documents/{docId}/summary`)와 다른 Workspace 문서의 요약 API를 직접 부른다
- **Then:** 첫 교재는 읽기 전용 요약 panel(전체 요약·장별 요약·쪽 링크는 공유 문서 화면으로)을 보이고 `요약 만들기`·`다시 시도`·진행 상태·오류·비용 정보가 없다. 두 번째 교재에는 `요약` 버튼이 없고 API는 404다(이전 revision 요약을 내주지 않음). 다른 Workspace 문서는 404이며, 링크를 철회하면 이미 열린 세션의 요약 요청도 거부된다.

### DOCSUM-01-AC07

- **Given:** 준비 완료 `문제지`, 처리 중인 교재, 요약이 있는 교재가 있는 Workspace 홈(편집 권한), 그리고 다른 Workspace의 문서 id
- **When:** 문서 관리 dialog를 보고, DOC-02 header의 `요약` 링크를 누르고, `?panel=document-summary&document=<다른 Workspace 문서 id>`로 직접 연다. 요약 panel이 열린 채로 `이력` dialog를 연다
- **Then:** `문제지`와 처리 중인 행에는 `요약` 버튼이 없고(`문제지` POST는 409 `summary-not-applicable`, 처리 중 409 `document-not-ready`) 준비 완료 교재 행에는 있다. DOC-02의 `요약` 링크는 Workspace 홈으로 이동해 그 문서의 요약 panel을 연다. 다른 Workspace 문서 딥링크는 panel에 "문서를 찾을 수 없습니다."를 보이고 API는 404다. 이력 dialog가 요약 panel 위에 오고, 이력에는 `요약 만들기`(활동)와 요약 작업(작업, 종류 "문서 요약")이 본문 없이 보인다.

## 계약 요구사항 (pytest·unit, 화면 AC 아님)

`tests/integration/documents/test_document_summary_contract.py`, `apps/worker/tests`, `packages/core/tests`, `supabase/tests`(pgTAP).

| ID | 요구사항 |
|---|---|
| DOCSUM-01-C01 | **unit 재사용:** 장 요약 unit은 `(document_id, scope, section_key, input_hash, prompt_version, model)`로 content-addressed. `input_hash`는 장 입력 텍스트(정규화된 블록 텍스트 + 쪽 번호)의 SHA-256이다. 새 revision에서 입력이 같은 장은 LLM을 부르지 않고 기존 unit을 run에 연결한다(fake 호출 수로 검증). 문서 요약(reduce)은 장 unit hash 목록이 같으면 재사용한다. unit은 Workspace·문서 범위를 넘어 공유하지 않는다. |
| DOCSUM-01-C02 | **시작 조건:** 발행 트랜잭션(`document.parse` publish, revision 복원)이 SECURITY DEFINER `public.worker_start_document_summary`를 부르고 조건이 맞을 때만 run(`trigger = publish`)과 `document.summarize` job을 같은 트랜잭션에서 만든다: `summary_enabled_at`이 있음, 종류가 `question_paper`가 아님, Workspace 활성, worker 설정상 사용 가능. 초안 저장은 run을 만들지 않는다. 같은 revision에 run은 하나(재전달·재시도 멱등). |
| DOCSUM-01-C03 | **대체(supersession):** 더 새 revision의 run이 생기면 이전 revision의 대기·실행 run은 `superseded`로 끝나고 결과를 쓰지 않는다. job은 문서별 advisory lock 아래에서 결과를 쓰기 직전에 run 상태와 현재 발행 revision을 다시 확인한다(경쟁 test: 두 발행이 거의 동시에 일어나도 최종 표시 요약은 최신 revision). |
| DOCSUM-01-C04 | **유출 금지:** 문서 본문·요약 본문·LLM 응답·prompt는 API·worker 로그, job `result`(개수·usage·오류 코드만), 활동 기록(`document.summary_requested` 등은 id만), trace에 남지 않는다(log capture test). LLM 오류 메시지 원문도 저장하지 않고 오류 코드로만 남긴다. |
| DOCSUM-01-C05 | **인가 matrix:** GET은 모든 구성원(보관 Workspace 포함), POST(`/summary`, `/summary/retry`)는 owner·editor이고 활성 Workspace만(보관 403), 삭제·다른 Workspace 404, `문제지` 409 `summary-not-applicable`, 처리 중 409 `document-not-ready`, 기능 꺼짐 409 `summary-disabled`, `retry`는 현재 revision run이 `failed`일 때만(아니면 409 `summary-not-failed`). 공유 API는 현재 발행 revision의 `succeeded` 요약만, 그 밖 404. POST는 `Idempotency-Key`를 받는다. |
| DOCSUM-01-C06 | **한도와 검증:** 장 입력이 `WORKER_SUMMARY_CHAPTER_CHARS`(기본 24,000자)를 넘으면 나눠 요약한 뒤 합친다. 문서 입력이 `WORKER_SUMMARY_MAX_INPUT_CHARS`를 넘으면 LLM을 부르지 않고 `summary_too_large`로 실패한다. 핵심 항목의 쪽은 그 장의 쪽 범위 안이어야 하며 벗어난 쪽은 버린다(쪽 없는 항목은 쪽 링크 없이 보임). run에 token usage·`cost_usd`·`reused_units`·`generated_units`를 기록한다. 테스트 환경(`APP_ENV=test`)만 결정적 fake 요약기(블록 앞 문장 추출)와 실패 marker를 쓴다. |
| DOCSUM-01-C07 | **Fork:** Fork는 snapshot revision의 성공한 요약(run과 연결된 unit)과 `summary_enabled_at`을 새 id로 복제한다(이력 run·실패 run·usage는 복제하지 않음). 복제된 문서도 이후 발행에서 자동 재생성된다. |

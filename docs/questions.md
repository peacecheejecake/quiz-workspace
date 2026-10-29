# Questions — Product & Domain Specification v1.2

**상태:** 확정 기준 설계 · 2026-10-16  
**디자인 참조:** `design-system.md`  
**구현 참조:** `architecture.md`

## 1. 사용자 경험

Questions는 다음의 4개 하위 영역을 갖는다.

1. **Overview (기본 홈):** 문제 1개당 점 1개인 GitHub contribution-style heatmap. 챕터 그룹, 검색·필터, quick preview, floating practice panel. UX3c(2026-10-20)부터 Workspace 홈 자체이며 화면 구성은 `screens/questions-overview.md` "Workspace 홈 레이아웃"이 기준이다(아래 와이어프레임은 v1.2 기록).
2. **Bank:** 문제 목록/상세, 직접 등록·수정, 출처 연결, 즐겨찾기·다시 풀기, 히스토리.
3. **Generate:** 등록된 문제를 선택해 shuffle/문구 변형/정오 반전/유사 개념 출제 후 diff+근거 확인/승인.
4. **Import:** 문제 PDF를 구조화하여 검토 후 Bank에 등록.

### Overview 와이어프레임

```text
┌─ App header / Workspace switcher ──────────────────────────────────────────────────────┐
│ Left navigation │ Questions / Overview                            [Import] [Generate] │
│                 │ [All Chapters ▼] [Status ▼] [Favorites ☆] [Retry ↻] [Search ...]    │
│                 │  [전체 436] [미열람 201] [열람 79] [오답 42] [정답 96] [재풀이 18] │
│                 │                                                                      │
│                 │ Chapter 01 — Fundamentals                                            │
│                 │ ▫ ▫ ▫ ▣ ▣ ▣ ▫ ▫ ▫ ▣ ▣ ▫ ...                                         │
│                 │ Chapter 02 — Attention                                               │
│                 │ ▫ ▪ ▫ ▪ ▣ ▣ ▫ ▪ ▪ ▫ ...                                            │
│                 │   (hover/focus → preview popover, click/Enter → right floating panel) │
│                 │                                                                      │
│                 │ [status legend]       [next chapter]                                 │
└─────────────────┴──────────────────────────────────────────────────────────────────────┘
                                     ┌──────── Floating Practice Panel ────────────────┐
                                     │ Question number, chapter, favorite ☆, retry ↻  │
                                     │ Question body                                   │
                                     │ Options or answer input                         │
                                     │ [Submit] → feedback & explanation               │
                                     │ [Previous] [Next] [Open full page] [Close]      │
                                     └─────────────────────────────────────────────────┘
```

※ 와이어프레임의 글리프는 구조 설명용. 구현 시 기본 문제는 rounded-square, 즐겨찾기는 rounded-star로 표시하며 두 모양 모두 hover/focus 시 확대한다.

## 2. 상태 모델 및 우선순위

문제은행의 `publication_status`(`DRAFT`, `CONFIRMED`, `ARCHIVED`)와 사용자별 학습 상태(`question_user_state`)는 별개다. Overview는 `CONFIRMED`만 포함한다.

### 2.1 상태 계산

```ts
type LastGradedResult = 'correct' | 'incorrect' | null;
type DotStatus = 'unseen' | 'viewed' | 'incorrect' | 'correct' | 'retry';

type UserStudyState = {
  firstViewedAt: string | null;
  lastGradedResult: LastGradedResult;
  needsRetry: boolean;
  isFavorite: boolean;
};

function deriveDotStatus(s: UserStudyState): DotStatus {
  if (s.needsRetry) return 'retry';
  if (s.lastGradedResult === 'incorrect') return 'incorrect';
  if (s.lastGradedResult === 'correct') return 'correct';
  if (s.firstViewedAt) return 'viewed';
  return 'unseen';
}
```

- `unseen`: 문제 풀이 패널을 아직 열지 않음.
- `viewed`: 풀이 패널을 열었으나 채점이 완료된 풀이가 없음.
- `incorrect`/`correct`: 마지막으로 **채점 확정된** 풀이 결과. 모든 이전 attempt는 보존.
- `retry`: 사용자 `needs_retry = true`; 이전 correct/incorrect를 색상에서 가리지만 이력은 변경하지 않음.
- `is_favorite`: 완전히 독립된 boolean. 상태 색상은 유지하고 marker를 **rounded-square → rounded-star SVG**로 교체한다. 셀 크기와 기본 시각 크기는 유지하고 hover/focus-visible 시에만 scale을 키운다. 상세 화면에서도 별 아이콘 표시.
- 서술형의 채점 대기는 `viewed` 또는 기존 마지막 채점 상태를 유지하고 tooltip에 `채점 대기` 안내. 미채점 제출을 정답/오답으로 간주하지 않음.
- **정답을 맞혔다고 `needs_retry`를 자동 해제하지 않음.** 사용자가 직접 해제한다.
- Overview tooltip, 단순 hover, 챕터 목록 열람은 `firstViewedAt`을 갱신하지 않는다. 문제 풀이 패널/연습 세션을 실제로 열었을 때만 기록한다.
- 편집/관리자 보기 역시 학습 `viewed`로 취급하지 않는다.
- 문제 원문 revision이 바뀌어도 기존 풀이 이력은 immutable. 내용상 변경된 이후 풀이가 없다면 '문제 변경됨' 알림을 상세 화면에 표시하며, 마지막 결과 상태를 조용히 지우지 않는다.

### 2.2 색상과 표시

| 토큰 | 의미 | 라이트 기준 제안값 |
|---|---|---|
| `--question-status-unseen` | 보지 않은 문제 | `#D9DEE5` |
| `--question-status-viewed` | 보기만 한 문제 | `#858E9B` |
| `--question-status-incorrect` | 틀린 문제 | `#E0525E` |
| `--question-status-correct` | 맞은 문제 | `#26865C` |
| `--question-status-retry` | 다시 풀기 | `#E9B447` |

스타일은 상태의 `semantic token`만 참조한다. 컴포넌트 안에서 hex 값을 직접 쓰지 않는다.

## 3. Heatmap 레이아웃·상호작용

### 3.1 점과 배치

- **점 1개 = `CONFIRMED` 문제 1개**. `DRAFT`, 삭제됨, 숨김 처리한 문제는 점이 없다.
- 기본 정렬: 챕터의 `sort_order`, 문제 번호/등록 순서. 필터를 바꿔도 같은 문제의 기본 위치를 불필요하게 흔들지 않는다.
- 챕터별 제목과 문제 수를 표시하고, 각 챕터를 독립된 정사각형 그리드로 묶는다. GitHub 잔디 형태와 유사하지만 **날짜 축이 아니라 문제 순서 기반**이다.
- 기본 marker는 둥근 모서리 정사각형(데스크톱 `18x18px`, touch `24x24px`; viewBox 24 중 18), radius는 viewBox `4.5`. 즐겨찾기는 **모서리가 부드러운 5각 star silhouette(SVG `stroke-linejoin=round`)**로 교체한다. favorite도 같은 SVG box(셀 크기)를 쓴다; 두 모양 모두 상태 색상을 적용한다.
- 각 marker를 중심 정렬한 클릭 영역 `24x24px`, 그리드 셀 간격 `0`(mobile touch는 최소 32px 셀). 이웃 marker 사이 보이는 간격은 marker 폭의 1/3 이하(`6px`/touch `8px`, UX5-UI 2026-10-23). **hover/focus-visible** 시 marker만 `scale(1.18)`(토큰으로 관리), 정렬·셀 크기는 그대로 두어 레이아웃이 움직이지 않는다. `prefers-reduced-motion`에서는 애니메이션을 비활성화한다.
- viewport 폭에 따라 열 수 자동 변경. 챕터별 줄바꿈; 매우 많은 문제(예: 2,000개 이상)에서는 windowing/virtualization 검토.
- 현재 필터에 포함된 문제 수, 상태 필터(색 견본 + 텍스트, 기본 접힘), 즐겨찾기·다시 풀기 필터 제공. 상태 범례와 상태별 집계는 UX3c(2026-10-20, 사용자 결정)로 삭제했다 — 펼친 상태 필터가 범례 역할을 한다.

### 3.2 인터랙션

- `hover`/키보드 `focus`: marker scale 확대 및 200ms 정도 지연 후 간단한 preview popover. 문제 유형, 번호, 챕터, 표시 상태, stem 처음 1~3줄, favorite/retry 여부. 정답은 미노출.
- `click`/`Enter`/`Space`: 문제 풀이를 Floating Side Panel에 열고 학습 열람 이벤트 기록.
- `Esc`: popover 또는 panel 닫기. 닫힌 뒤 기존 점으로 focus 복귀.
- mobile/touch: hover 없음. 첫 tap에 패널 열기, preview는 패널 상단에 포함. 전체 페이지 문제 풀이로 전환 가능.
- `aria-label`: 예: `3장 12번 문제, 객관식, 마지막 결과 오답, 다시 풀기 표시됨, 즐겨찾기`.
- **색상만으로 의미를 전달하지 않는다.** marker의 screen reader label·preview popover의 상태 텍스트·상태 필터의 텍스트를 제공한다.
- 문제 풀이 패널에서 다음/이전 문제로 이동하면 URL query string을 갱신하여 딥링크와 브라우저 뒤로가기를 지원한다.

## 4. 문제 풀이 및 채점 정책

1. Heatmap dot click → `POST /questions/{id}/practice-sessions` → 서버는 정답/해설이 없는 문제 데이터를 반환.
2. 객관식이면 선택지 순서를 `shuffle_seed` 또는 표시 순서 목록으로 고정하고 `practice_session`/`attempt`에 저장.
3. 답 제출 시 server-side correct option IDs 기준 채점. 선택지 위치(A/B/C)가 아니라 변하지 않는 option ID로 비교한다.
4. 객관식 단일·복수 선택 지원. 단답식은 등록된 허용 답안과 정규화 규칙으로 자동 채점 가능한 경우에만 채점.
5. 서술형과 자동 채점 불가능한 단답식은 `PENDING`을 반환한 뒤 사용자의 자기평가(`correct`/`incorrect`) 또는 검토자의 채점을 받는다. 향후 AI 자동 채점은 별도 opt-in 기능으로 확장.
6. 채점 확정 시 `question_attempt` 추가, `question_user_state.last_graded_result`와 materialized counts 업데이트, dot 색상 반영.
7. 다시 풀기와 즐겨찾기는 점·패널 어디서든 토글 가능. 변경은 이력에 남김.
8. 문제를 편집해도 과거 attempt가 참조한 `question_revision_id`의 정답과 표시 순서를 유지하여 역사적 채점이 재현 가능해야 한다.

## 5. 문제 변형 출제

| 변형 | 실행 경로 | 검증 및 저장 |
|---|---|---|
| `OPTION_SHUFFLE` | deterministic, LLM 미사용 | 문제 원본은 그대로; practice session에 displayed option IDs 저장; **새 점 생성 안 함** |
| `PARAPHRASE` | LLM structured draft | 개념·난이도·정답을 유지하는지 검토; 사람 승인 후 새로운 `question` 등록 |
| `INVERT_POLARITY` | LLM + evidence validation | '틀린 것→맞는 것' 반전 시 **정답 개수 자체가 달라질 수 있음**. 선택지를 재구성하거나 객관식 유형 전환을 명확히 확인; 승인 전 자동 등록 금지 |
| `ANALOGOUS_CONCEPT` | document semantic search + LLM | 관련 장·절 원문 발췌를 입력으로 사용, 출처와 정답 근거 명시, 사람 승인 후 새 문제 |

### 변형 생성 워크플로

```text
Confirmed question
 → Choose variation(s), number of candidates, optional target chapter/difficulty
 → (LLM 필요한 경우) fetch selected source passage(s), structured generation
 → Validate schema, options/answer count, duplicate fingerprint, source coverage
 → DRAFT with diff vs original + justification + source links
 → Human approve/edit/reject
 → CONFIRMED question, lineage relation, independent study state / heatmap dot
```

- 새롭게 등록된 의미적 변형은 **독립된 문제**로 점 하나와 독립적인 풀이 이력을 갖는다.
- `parent_question_id`, `generation_run_id`, `generation_type`, `source_question_revision_id`, 사용한 LLM 모델/프롬프트 버전과 source block IDs를 저장한다.
- 생성 LLM이 선언한 정답은 신뢰하지 않고 유효성 검사를 수행한다. 기계적 유효성 검사만으로 의미적 정답을 보장할 수 없어 사람 승인이 필수다.
- 문제 생성에 검색된 책 원문을 근거로 제공할 수 있지만, 범용 RAG 챗봇이나 자동 답변 기능은 범위 밖이다.
- 원본 문제나 출처 문서를 변경해도 파생 문제는 자동 덮어쓰지 않는다. 출처 revision과의 차이·검토 필요 상태를 노출한다.

### 묶음 변형 출제 (QGEN-MULTI 2026-10-23)

원본 여러 개를 한 번에 변형한다: `POST /workspaces/{id}/question-generation-batches` (편집 권한, 보관 Workspace는 403, `Idempotency-Key`).

- **묶음 = run 묶음.** 새 테이블 없이 원본마다 보통의 generation run(원본 revision 고정, `question.generate` job 하나)을 같은 트랜잭션에서 만든다. run의 `params`에 `batch_id`·`batch_mode`·`batch_position`(·임의 선택이면 `batch_seed`)를 기록하고 `GET /workspaces/{id}/question-generation-batches/{batch_id}`가 그 run들을 순서대로 돌려준다(원본 번호·문제 앞부분 포함, 정답 없음). worker·초안·검증·승인·등록·lineage는 단일 run과 같다 — 사람이 승인한 초안만 원본별 run의 publish로 등록된다.
- **원본 고르기.** `selection.mode = "selected"`: `question_ids` 1~20개(중복 불가). 모두 이 Workspace의 살아 있는 확정 문제여야 한다 — 다른 Workspace·삭제·없는 id는 단일 run과 같은 404, 초안·보관 문제는 409 `question-not-confirmed`(요청 전체 거절, run 없음). `selection.mode = "random"`: `count` 1~20, 선택 필터 `chapter`(id 또는 `none`), `question_type`, `statuses`(Heatmap 판정 `unseen|viewed|incorrect|correct|retry`, 요청한 사용자의 풀이 상태 기준), `favorite`(true = 즐겨찾기만), `seed`(0~2^31-1). 서버가 Workspace의 확정 문제 중 필터에 맞는 후보를 Heatmap 순서로 만든 뒤 `random.Random(seed).sample`로 `min(count, 후보 수)`개를 고른다(같은 seed·같은 후보 → 같은 선택). seed가 없으면 서버가 정해 응답과 run에 남긴다. 후보가 없으면 409 `no-matching-questions`, run 없음.
- **한도(비용 보호).** 원본 ≤ 20, 원본 수 × 변형 유형 수 × `candidate_count` ≤ 60(초과 422). 묶음 시작은 Workspace 단위 advisory lock으로 직렬화하고, 그 Workspace에서 진행 중(대기·생성 중, job이 실패·취소되지 않은) run과 새 원본 수의 합이 40을 넘으면 409 `generation-busy`. 사용자별 묶음 시작 `QUESTION_GENERATION_BATCH_RATE_LIMIT_PER_MINUTE`(기본 6, in-process token bucket) 초과는 429 + Retry-After. 같은 `Idempotency-Key`의 재시도는 rate limit·한도 검사 전에 저장된 묶음을 돌려주고 대기 중 job을 다시 broker에 넘긴다.
- 보기 섞기(`OPTION_SHUFFLE`)는 묶음에서도 422(생성이 아님).

## 6. 문제 PDF import

`PDF → parser/OCR → 번호/선택지/그림 범위 추출 → LLM structured extraction → schema 검증 → DRAFT 비교 화면 → Confirm`.

원본에 존재하지 않는 정답 생성 금지; 정답지가 없으면 null. 페이지/영역 provenance 유지.

추출 시작은 서버가 맡는다(QIMP-AUTO 2026-10-21, QIMPORT-01-AC06): `question_paper` 문서(UX6-UPLOAD부터 확신이 높은 `mixed` 문서도, 아래)의 `document.parse` job이 revision을 활성화하는 트랜잭션에서 `public.worker_start_question_import`가 import run(`started_by = 'system'`)과 첫 `question.import` job을 만든다. 귀속은 parse job의 사용자(업로더)와 문서의 Workspace이며 client가 보낸 id는 쓰지 않는다. 문서마다 한 번만(이미 run이 있으면 시작하지 않음, 부분 unique index), Workspace가 활성이고 사용자가 여전히 owner/editor일 때만 시작한다. job은 parse job이 끝난 뒤 worker가 broker에 넘기고, 놓치면 reconciler가 grace 이후 넘긴다. `POST /workspaces/{id}/question-imports`는 준비 완료된 모든 문서를 받으며(UX6-UPLOAD; 이전에는 `question_paper`만) 문서의 활성 revision에 run이 있으면 그 run을 돌려주고(attach), 없을 때(QIMP-AUTO 이전에 처리된 PDF, 확신이 낮은 `mixed`, 교재)만 새 run을 만든다. 같은 문서에 대한 시작은 문서 행 잠금(FOR UPDATE)으로 직렬화된다.

자동 분류(UX6-UPLOAD 2026-10-28, DOC-01-AC07/AC08): 업로드는 문서 관리 한 곳이며 종류를 고르지 않는다(`upload-intent` `document_type = auto` → 문서는 `book`, `type_source = auto`로 생성). `document.parse` job이 첫 revision을 색인·게시하기 전에 canonical revision을 `book_core.extractor.classify_content`로 분류하고, 게시 트랜잭션에서 `public.worker_classify_document`가 결과를 한 번만 적는다: `content_kind`(`book` | `question_paper` | `mixed`), `document_type`(`question_paper`면 `question_paper`, 나머지는 `book` — 본문 여부라서 `mixed`도 검색·출제 근거·챕터 매칭에 쓰인다), `detection`(분류 수치만, 문서 텍스트 없음). 분류와 import(`QuestionExtractor`)는 같은 읽기를 쓴다(`segment_chapters` + `answer_entries`): `제N장`·`N장`·`Chapter N`·`제N편`·`Part N` 번호가 붙은 heading에서 장을 나눠 `segment()`를 장마다 돌린다(장마다 번호가 다시 시작하고 장마다 정답지가 있는 교재에서, 문서 전체를 한 번에 읽으면 첫 정답지 뒤를 모두 정답지로 읽어 이후 장의 문제를 잃는다). 다른 heading에서는 나누지 않는다(Docling은 문제 줄·`정답:` 줄·이어진 발문도 heading으로 낸다). 정답지 매칭: 문서에서 한 번만 나오는 번호는 문서 전체 정답지에서(이전과 같음), 장마다 반복되는 번호는 그 장의 정답지에서(그 장에서 한 번만 나오거나, 같은 번호 중 묻는 문제 — 보기·질문 단서 — 가 하나일 때). 장이 하나인 문서는 이전과 똑같이 읽는다:
- **강한 문제** = 인쇄된 `정답:` 줄이 있거나, 첫 label부터 이어지는 보기 2개 이상(`①②`, `A B`, `(1)(2)`)에 질문 단서(`?`, `시오`, `것은`, `고르`, 답란, `which`/`choose` 등) 또는 보기 label을 답으로 적은 정답지 항목이 있거나, 질문 단서와 정답지 항목이 있는 문제. 번호만 붙은 줄은 약한 증거라 세지 않는다(교재 heading `1. 개요`, 법 조문 `1. 예금자보호법` + `① 이 법은 …`).
- **coverage** = 문제(강한 문제와 단서가 있는 보기 없는 문제)가 차지하는 줄(발문 10줄·보기마다 3줄·정답 줄·해설 20줄까지)과 정답지 줄의 글자 수 / 전체 텍스트 줄의 글자 수.
- 규칙(`book-core-content-classifier/1`): 강한 문제 < 3 → `book`; coverage ≥ 0.6 → `question_paper`; 그 밖 → `mixed`. 확신 `high`: 강한 문제가 없는 book, coverage ≥ 0.75인 question_paper, 강한 문제의 절반 이상에 정답이 있고 번호 건너뜀이 20% 이하인 mixed.
- 추출 자동 시작: `question_paper`와 확신 `high`인 `mixed`만 같은 트랜잭션에서 `worker_start_question_import`(위 QIMP-AUTO, `mixed` book도 받도록 확장)로 시작한다. 확신 `low`인 `mixed`는 표시만 하고 사용자의 `문제 추출`을 기다린다.
- 다시 분류하지 않는다: 이미 분류된 문서, 사람이 고른 종류(`type_source = user`: 업로드 때 고른 `book`/`question_paper`(이전 경로) 또는 `종류 변경`), 교정 revision(부모가 있는 revision), 재시도·중복 전달은 아무것도 바꾸지 않는다. 분류 전에 처리가 실패한 auto 문서는 종류가 없다(`kind = null`).
- 사람의 `종류 변경`: `PATCH /documents/{id}` `{kind, extract = true}`(편집 권한, 보관 Workspace 403, 삭제·다른 Workspace 404, 준비 완료만 — 아니면 409 `document-not-ready`). 문서 행 FOR UPDATE 아래에서 `document_type`·`content_kind`를 함께 바꾸고 `type_source = user`로 고정하며(분류 수치 `detection`은 남김) `document.kind_changed` 활동을 남긴다. 본문(`book`)에서 `question_paper`로 바꾸면 검색·출제 근거·챕터 매칭에서 빠지므로, 살아 있는 문제의 챕터·등록 대기(미등록) import 초안의 챕터·제출된 서버 등록(QIMP-JOB)의 대기(`pending`) 항목 챕터(자동 추천 챕터는 항목에만 저장된다; 그 등록 job이 대기·실행 중일 때만 — 실패·취소된 등록이 남긴 `pending` 항목은 다시 처리되지 않으므로 막지 않는다)가 이 문서의 챕터이거나 살아 있는 문제의 출처(가져온 출처 제외)가 이 문서면 409 `document-in-use`로 거절한다(제출되지 않은 초안의 추천은 읽을 때마다 교재로 다시 계산되고 등록 때 `chapter-changed`로 확인되므로 따로 막지 않는다). 그래도 경쟁으로 등록 job이 교재가 아닌 문서의 챕터를 만나면 그 항목은 `refused`/`stale-draft`로 거절하고 다른 항목은 계속 등록한다(문제지 챕터 아래에 등록하지 않는다). `question_paper` → `book`/`mixed`는 막지 않는다. 어느 방향이든 초안·run·문제를 지우지 않는다. 새 종류가 `question_paper`·`mixed`이고 `extract`이며 문서에 import run이 없으면 같은 트랜잭션에서 사용자 이름의 run과 첫 job을 만든다(`POST /question-imports`와 같음; 이미 있으면 그대로). 같은 종류로의 PATCH는 아무것도 바꾸지 않는다(멱등).
- 한계·보정: 규칙 기반이라 오분류가 있을 수 있다(교재 본문이 문제 형식으로 쓰인 경우 등). 그래서 `종류 변경`이 있고, 임계값은 `eval/classify_pdfs.py`로 로컬 실제 PDF(저장소에 넣지 않음)에서 보정한 결과를 붙여서만 바꾸며 바꾸면 버전을 올린다. Fork는 `document_type`만 복사하므로 사본의 `교재+문제`는 `교재`로 보인다(후속).

정답 출처는 인쇄된 정답지뿐이다: 별도 정답 섹션(문제 번호로 매칭) 또는 문제 바로 뒤에 인쇄된 `정답: ②` 줄(그 문제에만 적용되므로 장마다 번호가 1부터 다시 시작해도 된다). `정답:` 줄 뒤의 인쇄된 해설은 초안의 해설(explanation)로 보존하고 선택지로 읽지 않는다. 마침표 없는 번호(`01 …`)는 heading 줄이거나 질문 단서(`?`, `시오`, 답란 `( )`)가 있을 때만 문제로 읽는다. 문제의 출처 영역(provenance)은 발문과 모든 선택지(표로 인쇄된 선택지 포함)를 쪽마다 하나로 묶은 영역이며, 정답 줄과 해설은 포함하지 않는다. PDF import draft는 생성 draft와 공통 review 컴포넌트를 사용하되 source type을 별도로 보존한다.

승인과 등록(QIMP-BULK 2026-10-22, QIMPORT-01-AC03): import 검토 화면은 초안을 하나씩 승인하지 않고 사람이 고른 초안 목록을 `POST /question-imports/{id}/publish`(`approve: true`, `{draft_id, version}` 최대 200개)로 보낸다. 선택이 곧 승인이다: 보낸 version과 현재 version이 같고 확정 가능한(승인 불가 error 검증·정답 없음이 없는) 초안만 같은 트랜잭션에서 `approved`(reviewed_by = 호출자, reviewed_at = 지금; 이미 승인된 초안은 기존 승인 유지)로 바꾸고 CONFIRMED 문제로 등록한다. 바뀐 초안(`stale-draft`)과 확정할 수 없는 초안(`not-publishable`)은 그대로 두고 `refused`로 돌려준다 — 조용히 등록하지도, 요청 전체를 실패시키지도 않는다. 다른 import의 id는 요청 전체를 404로 거절한다. 이미 등록된 초안은 같은 문제를 돌려준다(초안별 멱등). `approve` 없는 요청은 기존대로 미리 승인된 초안만 all-or-nothing으로 등록한다(변형 출제 publish와 같은 계약).

서버 측 등록(QIMP-JOB 2026-10-23, QIMPORT-01-AC07): 검토 화면은 위 batch를 브라우저에서 보내지 않고 선택 전체를 `POST /question-imports/{id}/registrations`로 한 번 보낸다(최대 5000개, `Idempotency-Key`). API는 같은 트랜잭션에서 초안마다 `question_import_registration_items` 행(보낸 version, 등록할 챕터)을 기록한다 — 이미 등록됨은 `skipped`, 보낸 version과 다름은 `refused`/`stale-draft`, 확정 불가는 `refused`/`not-publishable`, 나머지 `pending` — 그리고 run의 `registration_job_id`가 가리키는 `question.import_register` job(호출자 이름, 미발행 → commit 후 발행, 놓치면 reconciler)을 만든다. job은 SECURITY DEFINER `public.worker_register_import_drafts(job, batch)`를 남은 항목이 없을 때까지 부른다(batch = 한 트랜잭션, 100개): Workspace 행 FOR SHARE 재확인(보관·삭제·권한 상실이면 `workspace_unavailable`로 job 실패, 남은 항목은 그대로), 초안 FOR UPDATE(위치 순, publish와 같은 잠금 순서) → 챕터 문서 FOR SHARE, 초안마다 이미 등록됨 → `skipped`, version 다름 → `stale-draft`, 아니면 API publish와 같은 내용으로 승인(job 사용자, 이미 승인이면 유지)·CONFIRMED 문제·revision 1·import 출처 행·`question.created`·`published_question_id`, batch마다 `question_import.published`. 같은 version이면 API가 제출 시 확인한 확정 가능 상태 그대로이므로 내용 규칙을 SQL에서 반복하지 않는다(DB 제약이 거부하면 그 초안만 `not-publishable`). 항목이 job의 영속 진행 상태라 재시도·중복 전달은 남은 `pending`만 이어서 처리하고, 이미 문제에 연결된 초안은 다시 등록하지 않는다. 진행(처리/전체)과 거절 목록은 `GET /question-imports/{id}/registrations/{registration_id}`. quiz_worker는 초안·문제 테이블 쓰기 권한 없이 이 함수만 실행한다. 이전 등록이 대기·진행 중이면 새 제출은 409 `import-registration-running`.

챕터(CHAPTER-MAP 2026-10-23, QIMPORT-01-AC08): import 초안은 교재(`book`) 챕터 아래에 등록된다. `question_drafts.chapter_manual = false`이면 API(`quiz_api.chapter_matching`)가 읽을 때마다 추천한다 — 초안 첫 출처 블록(`evidence[0].block_ids[0]`, 없으면 첫 쪽의 첫 블록)의 `content_blocks.chapter_id`에서 시작해 상위 장까지(깊은 것부터) 제목 key(NFKC·casefold, 앞 번호 `제N장`/`N장`/`Chapter N`/`N.`/`N.M` 분리, 문자·숫자만)를 Workspace의 살아 있는 책들의 활성 revision 챕터 key와 비교: 첫 일치 단계에서 후보 1개 → 추천(`matched`), 여럿 → 장 번호 일치 1개면 추천, 아니면 `ambiguous`(추천 없음); 일치 단계 없음 `no_match`, 시작 블록에 장 없음 `no_source_chapter`. 추측 금지: 숫자만으로 맞추지 않는다. 검토자가 `PATCH` `chapter_id`(책의 현재 revision 챕터 또는 null)를 보내면 `chapter_manual = true`로 그 선택이 이긴다(내용 변경이 아니므로 승인 유지). 저장된 챕터가 옛 revision이면 등록 시 같은 `section_key`의 현재 revision 챕터로(없으면 null) 해석한다 — 문제의 `documents_remap_question_chapters`와 같은 규칙. 등록(publish·서버 등록 job)은 책 문서를 FOR SHARE로 잠근 뒤 해석해 revision 게시와 경쟁하지 않는다. 추천은 초안 version을 바꾸지 않고 달라질 수 있으므로(교재 추가·교정) 클라이언트는 선택마다 보이던 `chapter_id`를 보내고, 서버의 현재 챕터와 다르면 publish·registrations 요청 전체를 409 `chapter-changed`로 거절한다(Codex P2; 보내지 않으면 검사 안 함 — API 호환).

## 7. 홈 집계와 필터

- 상단 수치: 전체 문제, 미열람, 열람만, 정답, 오답, 다시 풀기, 즐겨찾기.
- 상태 집계는 mutually exclusive (`retry` 우선); 즐겨찾기 수는 별도 overlap 카운트.
- 필터: 챕터, 문제 유형, 현재 상태, 즐겨찾기, 다시 풀기, 검색어.
- 기본 상태 필터 없이 전체 등록 문제 표시. URL query state로 공유·복원 가능.
- 문제 클릭 위치의 점은 hover/selection outline으로 강조; 색상은 변경하지 않는다.
- 모바일에서는 status counts를 horizontal summary chips로 축약한다.

## 8. 핵심 수용 테스트

- 100개 confirmed 문제는 원본 또는 단순 shuffle 횟수와 무관하게 점 100개.
- 초안 10개를 생성한 시점에는 점 수 불변, 그중 3개 승인하면 점 103개.
- Favorite 지정 전후 base status 색상 그대로, marker만 rounded-square에서 rounded-star로 전환되고 셀 크기는 불변. hover/focus-visible 때만 marker scale 확대.
- 마지막 풀이 정답 + needs_retry=true인 문제는 노란 점. retry를 해제하면 초록으로 복귀.
- hover만 10회 해도 unseen 유지, click으로 practice panel을 열면 viewed.
- 선택지 랜덤 정렬 100회 후에도 정답 option ID 매핑과 채점 일치.
- inverse 문제는 정답이 하나로 결정되지 않는 경우 DRAFT validation warning 및 등록 차단/수동 해결.
- 답안 미제출 시 클라이언트의 practice response에 정답 키 또는 해설이 없음.
- 서술형 답 제출 후 채점 대기 상태가 틀림/맞음으로 잘못 표시되지 않음.
- 키보드 Tab/Arrow/Enter/Escape, 화면 낭독기 레이블, 모바일 터치에서 접근 가능. favorite star는 선택 전/후 모두 시각·접근성으로 구분하고 hover/focus 변화가 학습 viewed 상태를 만들지 않는다.

## 9. 챕터 정리 노트 (CHNOTE 2026-10-29)

화면·AC는 [CHNOTE-01](screens/chapter-notes.md). 사용자 요청 "문제 및 해설로부터 챕터별 내용 정리 생성 — 추가한 내용은 문제 출처를 주석에 명시".

- **단위:** Heatmap 챕터 그룹 하나(같은 `chapter_id`) = 노트 하나. 노트는 `(document_id, section_key)`에 묶여 교정 revision이 바뀌어도 이어진다. "챕터 없음" 그룹은 노트가 없다.
- **입력:** 그 장의 살아 있는 CONFIRMED 문제의 active revision(발문·보기·정답·해설)만. 초안(`question_drafts`)·보관·삭제 문제는 넣지 않는다 — 확정 문제만 Heatmap에 보이는 규칙(§2)과 같다. 장의 발행 본문은 참고(grounding)일 뿐이며 노트 항목의 근거가 될 수 없다.
- **출처 각주:** 모든 항목은 입력 문제를 1개 이상 각주로 단다(`[^1] 3장 12번`). 입력에 없는 문제 인용, 각주 없는 항목, 본문에 없는 인용은 서버가 버리거나 거절해 저장·표시하지 않는다. 각주의 문제 번호는 Heatmap 미리보기 번호와 같다.
- **표시:** 사람의 승인 없이 바로 보이고(`AI 생성` 표시), 편집하지 않고 다시 만들기만 한다. 다시 만들면 새 버전이며 이전 버전은 남는다. 장의 확정 문제가 바뀌면(추가·revision·삭제·보관·장 이동) stale로 표시한다. 노트 생성·열람은 문제의 VIEWED 상태나 풀이 기록을 바꾸지 않는다(§2.1).
- **정답 노출:** 노트는 정답·해설에서 나온 내용이므로 본문을 기본으로 접고("정답·해설 포함") 문제 풀이 panel과 practice API에는 노트를 넣지 않는다(§4의 제출 전 정답·해설 비노출 규칙 유지). 풀이 panel이 열리면 노트 본문을 다시 접는다.
- **권한:** 모든 구성원이 읽고, owner·editor가 활성 Workspace에서 만든다. 공유 링크 게스트는 장마다 최신 노트를 출처 일치(인용 문제가 모두 살아 있는 CONFIRMED이고 active revision이 고정된 것과 같음)일 때만 읽는다(아래 공유 규칙). Fork는 출처 일치인 최신 노트만 문제 id 재매핑과 함께 복제한다.

## 공유 Workspace에서의 문제 개인정보 규칙 (v1.3 추가)
- 링크 Viewer는 published 문제, 선택지, 정답, 해설을 조회할 수 있지만 개인별 `question_user_states`와 `question_attempts`는 조회하지 않는다. 문제 열람도 VIEWED 처리하지 않는다.
- 공유 링크는 문제 등록/수정/삭제, 정답 변경, 사용자 시도 제출, 즐겨찾기·다시 풀기, 문제 변형 출제를 허용하지 않는다.
- Fork된 Workspace는 published 문제·해설과 출처 문서를 새로운 ID로 복제한다. 문제별 개인 상태·풀이 이력은 복사하지 않으며 모두 UNSEEN으로 시작한다.
- 문제 root/derived lineage의 Fork 내부 참조는 새 ID로 매핑한다. 외부 원본 참조는 노출하지 않는다.
- 챕터 정리 노트(§9, DOCSUM-SPEC 2026-10-29): 링크 Viewer는 장마다 출처 일치인 최신 성공 노트만 읽을 수 있다(인용 문제가 삭제·보관·수정되면 다시 만들 때까지 본문 없음)(발행 문제의 정답·해설을 이미 볼 수 있으므로 같은 범위). 각주는 발행된 확정 문제만 링크·발문 앞부분을 보이고, 이전 버전·생성 상태·오류·비용은 보이지 않으며 만들기·다시 만들기는 할 수 없다.

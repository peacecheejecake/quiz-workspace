# Questions — Product & Domain Specification v1.2

**상태:** 확정 기준 설계 · 2026-10-16  
**디자인 참조:** `design-system.md`  
**구현 참조:** `architecture.md`

## 1. 사용자 경험

Questions는 다음의 4개 하위 영역을 갖는다.

1. **Overview (기본 홈):** 문제 1개당 점 1개인 GitHub contribution-style heatmap. 챕터 그룹, 상태 분포, 검색·필터, quick preview, floating practice panel.
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
- 기본 marker는 둥근 모서리 정사각형 `16x16px`, radius `4~5px`. 즐겨찾기는 **모서리가 부드러운 5각 star silhouette(SVG `stroke-linejoin=round`)**로 교체한다. favorite도 기본 visual bounding box는 `16x16px`; 두 모양 모두 상태 색상을 적용한다.
- 각 marker를 중심 정렬한 클릭 영역 `28x28px`, 그리드 셀 간격 `4px`(mobile touch는 최소 32px 셀). **hover/focus-visible** 시 marker만 `scale(1.18)`(토큰으로 관리), 정렬·셀 크기는 그대로 두어 레이아웃이 움직이지 않는다. `prefers-reduced-motion`에서는 애니메이션을 비활성화한다.
- viewport 폭에 따라 열 수 자동 변경. 챕터별 줄바꿈; 매우 많은 문제(예: 2,000개 이상)에서는 windowing/virtualization 검토.
- 범례, 현재 필터에 포함된 문제 수, 상태별 집계, 즐겨찾기·다시 풀기 필터 제공.

### 3.2 인터랙션

- `hover`/키보드 `focus`: marker scale 확대 및 200ms 정도 지연 후 간단한 preview popover. 문제 유형, 번호, 챕터, 표시 상태, stem 처음 1~3줄, favorite/retry 여부. 정답은 미노출.
- `click`/`Enter`/`Space`: 문제 풀이를 Floating Side Panel에 열고 학습 열람 이벤트 기록.
- `Esc`: popover 또는 panel 닫기. 닫힌 뒤 기존 점으로 focus 복귀.
- mobile/touch: hover 없음. 첫 tap에 패널 열기, preview는 패널 상단에 포함. 전체 페이지 문제 풀이로 전환 가능.
- `aria-label`: 예: `3장 12번 문제, 객관식, 마지막 결과 오답, 다시 풀기 표시됨, 즐겨찾기`.
- **색상만으로 의미를 전달하지 않는다.** 상태 범례의 텍스트·tooltip·screen reader label을 제공한다.
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

## 6. 문제 PDF import

`PDF → parser/OCR → 번호/선택지/그림 범위 추출 → LLM structured extraction → schema 검증 → DRAFT 비교 화면 → Confirm`.

원본에 존재하지 않는 정답 생성 금지; 정답지가 없으면 null. 페이지/영역 provenance 유지. PDF import draft는 생성 draft와 공통 review 컴포넌트를 사용하되 source type을 별도로 보존한다.

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


## 공유 Workspace에서의 문제 개인정보 규칙 (v1.3 추가)
- 링크 Viewer는 published 문제, 선택지, 정답, 해설을 조회할 수 있지만 개인별 `question_user_states`와 `question_attempts`는 조회하지 않는다. 문제 열람도 VIEWED 처리하지 않는다.
- 공유 링크는 문제 등록/수정/삭제, 정답 변경, 사용자 시도 제출, 즐겨찾기·다시 풀기, 문제 변형 출제를 허용하지 않는다.
- Fork된 Workspace는 published 문제·해설과 출처 문서를 새로운 ID로 복제한다. 문제별 개인 상태·풀이 이력은 복사하지 않으며 모두 UNSEEN으로 시작한다.
- 문제 root/derived lineage의 Fork 내부 참조는 새 ID로 매핑한다. 외부 원본 참조는 노출하지 않는다.

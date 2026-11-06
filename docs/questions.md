# Questions — Product & Domain Specification v1.2

> **UX10 개정 예정(2026-11-05):** [확정 구현 기준](implementation/ux10/index.md)의 해당 변경 요구가 이 문서의 이전 동작에 우선한다. 구현 Task의 RED 단계에서 해당 AC·trace를 함께 갱신한다. 변경되지 않은 요구·보안 경계는 유지한다.

**상태:** 확정 기준 설계 · 2026-10-16  
**디자인 참조:** `design-system.md`  
**구현 참조:** `architecture.md`

## 1. 사용자 경험

Questions는 다음의 4개 하위 영역을 갖는다.

1. **Overview (기본 홈):** 문제 1개당 점 1개인 GitHub contribution-style heatmap. 챕터 그룹, 검색·필터, quick preview, floating practice panel. UX3c(2026-10-20)부터 Workspace 홈 자체이며 화면 구성은 `screens/questions-overview.md` "Workspace 홈 레이아웃"이 기준이다(아래 와이어프레임은 v1.2 기록).
2. **Bank:** 문제 목록/상세, 직접 등록·수정, 출처 연결, 즐겨찾기·다시 풀기, 히스토리.
3. ~~**Generate:** 등록된 문제를 선택해 shuffle/문구 변형/정오 반전/유사 개념 출제 후 diff+근거 확인/승인.~~ MOCK-SPEC(2026-11-01)에서 폐지(QGEN-RM) — 같은 변형 유형은 **모의고사**(§11)의 출제 옵션이 된다.
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
- **정답을 맞혔다고 `needs_retry`를 자동 해제하지 않음.** 사용자가 직접 해제한다. (RETRY-CORRECT 2026-11-04: `retry`는 마지막 채점 결과가 정답인 문제에서만 켤 수 있고, 오답이 채점되면 자동으로 꺼진다 — §17.)
- Overview tooltip, 단순 hover, 챕터 목록 열람은 `firstViewedAt`을 갱신하지 않는다. 문제 풀이 패널/연습 세션을 실제로 열었을 때만 기록한다.
- 편집/관리자 보기 역시 학습 `viewed`로 취급하지 않는다.
- 문제 원문 revision이 바뀌어도 기존 풀이 이력은 immutable. 내용상 변경된 이후 풀이가 없다면 '문제 변경됨' 알림을 상세 화면에 표시하며, 마지막 결과 상태를 조용히 지우지 않는다.

### 2.2 색상과 표시

| 토큰 | 의미 | 라이트 기준 제안값 |
|---|---|---|
| `--question-status-unseen` | 보지 않은 문제 | `#E7ECF0` |
| `--question-status-viewed` | 보기만 한 문제 | `#ACB6C2` |
| `--question-status-incorrect` | 틀린 문제 | `#FF6060` |
| `--question-status-correct` | 맞은 문제 | `#00AB7B` |
| `--question-status-retry` | 다시 풀기 | `#F6CF35` |

사용자 결정(HEATMAP-PALETTE 2026-11-04, "색상 palette 재조정 — red: #FF6060; green: #00AB7B; yellow: #F6CF35; gray: #ACB6C2; empty: #E7ECF0 — border 삭제"): 위 값이 light 값이다(incorrect=red, correct=green, retry=yellow, viewed=gray, unseen=empty). dark 값은 같은 색상 계열에서 어두운 표면에 맞게 명도를 조정한다(design-system §3.2: unseen `#3A4554`, viewed `#8591A1`, incorrect `#FF7A7A`, correct `#2CC79A`, retry `#F7D45A`). marker에는 테두리(stroke)가 없다.

스타일은 상태의 `semantic token`만 참조한다. 컴포넌트 안에서 hex 값을 직접 쓰지 않는다.

## 3. Heatmap 레이아웃·상호작용

### 3.1 점과 배치

- **점 1개 = `CONFIRMED` 문제 1개**. `DRAFT`, 삭제됨, 숨김 처리한 문제는 점이 없다.
- 기본 정렬: 챕터의 `sort_order`, 문제 번호/등록 순서. 필터를 바꿔도 같은 문제의 기본 위치를 불필요하게 흔들지 않는다.
- 챕터별 제목과 문제 수를 표시하고, 각 챕터를 독립된 정사각형 그리드로 묶는다. GitHub 잔디 형태와 유사하지만 **날짜 축이 아니라 문제 순서 기반**이다.
- 기본 marker는 둥근 모서리 정사각형(데스크톱 `21x21px`, touch `18x18px`; viewBox 24 중 18), radius는 viewBox `4.5`. 즐겨찾기는 **모서리가 부드러운 5각 star silhouette(SVG `stroke-linejoin=round`)**로 교체한다. favorite도 같은 SVG box(셀 크기)를 쓴다; 두 모양 모두 상태 색상을 적용한다.
- 각 marker를 중심 정렬한 클릭 영역 `28x28px`(UX12-HOME-1 2026-11-06 사용자 요청, 이전 `24x24px`), 그리드 셀 간격 `0`(mobile touch는 24px 셀: UX9-STROKE 2026-11-02 사용자 요청, 이전 최소 32px). 이웃 marker 사이 보이는 간격은 marker 폭의 1/3 이하(`7px`, touch `6px`, UX5-UI 2026-10-23). **hover/focus-visible** 시 marker만 `scale(1.3)`(토큰으로 관리, UX12 D-12), 정렬·셀 크기는 그대로 두어 레이아웃이 움직이지 않는다. `prefers-reduced-motion`에서는 애니메이션을 비활성화한다.
- viewport 폭에 따라 열 수 자동 변경. 챕터별 줄바꿈; 매우 많은 문제(예: 2,000개 이상)에서는 windowing/virtualization 검토.
- 현재 필터에 포함된 문제 수, 상태 필터(색 견본 + 텍스트, 기본 접힘), 즐겨찾기·다시 풀기 필터 제공. 상태 범례와 상태별 집계는 UX3c(2026-10-20, 사용자 결정)로 삭제했다 — 펼친 상태 필터가 범례 역할을 한다.

### 3.2 인터랙션

- `hover`/키보드 `focus`: marker scale 확대 및 200ms 정도 지연 후 간단한 preview popover. 문제 유형, 번호, 챕터, 표시 상태, stem 처음 1~3줄, favorite/retry 여부. 정답은 미노출. 풀이 panel을 닫아 focus가 dot으로 돌아올 때는 preview를 열지 않는다(UX12-HOME-AC01, `focusQuestionDotQuietly`). 사용자가 Tab·Arrow로 옮긴 focus와 hover는 그대로 preview를 연다.
- `click`/`Enter`/`Space`: 문제 풀이를 Floating Side Panel에 열고 학습 열람 이벤트 기록.
- `Esc`: popover 또는 panel 닫기. 닫힌 뒤 기존 점으로 focus 복귀.
- mobile/touch: hover 없음. 첫 tap에 패널 열기, preview는 패널 상단에 포함. 전체 페이지 문제 풀이로 전환 가능.
- `aria-label`: 예: `3장 12번 문제, 객관식, 마지막 결과 오답, 다시 풀기 표시됨, 즐겨찾기`. 교재 번호는 장마다 다시 시작하므로 이 이름에는 장을 남긴다.
- **문제 번호 (UX12-NUMBER 2026-11-06, 사용자 요청 "챕터 상관 없이 교재의 문제 번호 우선"):** 번호는 교재에 인쇄된 `questions.question_number`다. Heatmap 미리보기, 풀이 panel, 범위 풀이는 번호만 보이고(`12번`) 번호가 없으면 `번호 없음`이다. 장 안 위치를 번호로 쓰지 않는다. 장 묶음과 순서는 그대로다. dot `aria-label`만 장을 남긴다([UX12-NUMBER](screens/ux12-number.md)).
- **색상만으로 의미를 전달하지 않는다.** marker의 screen reader label·preview popover의 상태 텍스트·상태 필터의 텍스트를 제공한다.
- 문제 풀이 패널에서 다음/이전 문제로 이동하면 URL query string을 갱신하여 딥링크와 브라우저 뒤로가기를 지원한다.

## 4. 문제 풀이 및 채점 정책

1. Heatmap dot click → `POST /questions/{id}/practice-sessions` → 서버는 정답/해설이 없는 문제 데이터를 반환.
2. 객관식 보기는 기본적으로 원본 revision 순서다. 명시적으로 섞기만 선택하면 `shuffle_seed`로 섞고, 표시 순서 목록을 `practice_session`/`attempt`에 저장한다(UX10-QVIEW-AC01).
3. 답 제출 시 server-side correct option IDs 기준 채점. 선택지 위치(A/B/C)가 아니라 변하지 않는 option ID로 비교한다.
4. 객관식 단일·복수 선택 지원. 단답식은 등록된 허용 답안과 정규화 규칙으로 자동 채점 가능한 경우에만 채점.
5. 서술형과 자동 채점 불가능한 단답식은 `PENDING`을 반환한 뒤 사용자의 자기평가(`correct`/`incorrect`) 또는 검토자의 채점을 받는다. 향후 AI 자동 채점은 별도 opt-in 기능으로 확장.
6. 채점 확정 시 `question_attempt` 추가, `question_user_state.last_graded_result`와 materialized counts 업데이트, dot 색상 반영.
7. 다시 풀기와 즐겨찾기는 점·패널 어디서든 토글 가능. 변경은 이력에 남김.
8. 문제를 편집해도 과거 attempt가 참조한 `question_revision_id`의 정답과 표시 순서를 유지하여 역사적 채점이 재현 가능해야 한다.
9. 화면은 이번 화면에서 연, 아직 제출하지 않은 practice session(정답 없는 필드만)을 메모리에 보관해 같은 문제를 다시 열 때 요청 없이 보인다(UX7-CACHE 2026-11-01, Workspace·화면 단위, 10분, 제출 시작 시 폐기; 정답·해설은 보관하지 않음). 세부: [QPLAY-01](screens/questions-practice.md) AC06.
10. **문제 내용 끝의 빈 답 괄호는 표시하지 않는다 (UX7-QDISPLAY 2026-11-01, 사용자 결정):** 시험지 문제는 답을 적는 자리로 발문 끝에 빈 괄호를 둔다(예: "옳은 것은? ( )"). 화면은 문제 내용(stem)을 보일 때 맨 끝의 빈 괄호 — 반각 `( )`·전각 `（ ）`·괄호 안 공백 수와 종류(공백·NBSP·전각 공백·zero-width space) 무관, 괄호 안이 비어 있는 `()` 포함, 연달아 여러 개, 앞뒤 공백·줄바꿈 포함 — 를 지우고 보인다. 문장 중간의 빈 괄호(빈칸 채우기, 예: "빈칸 ( )에 들어갈 말")는 그대로 둔다. 문제 내용이 빈 괄호뿐이면 지우지 않고 그대로 보인다(빈 문제로 보이지 않게, 제안 — UX7-QDISPLAY). **표시 전용**이다: 저장된 문제·revision·import 결과와 API로 보내는 값은 바꾸지 않고, 편집기(문제 편집·초안 편집)의 입력값은 저장된 내용을 그대로 보인다. 한 순수 함수(`apps/web/src/lib/questions/display-stem.ts`)가 문제 내용을 보이는 모든 곳에 쓰인다: 풀이 panel(QPLAY-01, 열기 전 미리보기 포함), Heatmap preview, 문제 상세 dialog(수정 이력 미리보기 포함), `보관·초안 문제` 목록 행, 공유 보기(WS-VIEW-01) 목록·panel, 문서 편집기의 문제 카드(DOC-02), 가져오기·변형 초안 검토와 원본 비교, 변형 출제 원본 선택·묶음 목록·비교, 정리 노트 각주(CHNOTE-01). Heatmap preview는 서버가 자른 앞부분(1~3줄)이라 그 끝에 있는 빈 괄호도 지워진다. 세부: [QPLAY-01](screens/questions-practice.md) AC13.
11. **발문의 제시 항목은 줄을 나누어 박스에 보인다 (STEM-ITEMS 2026-11-05, 사용자 결정 "구분과 줄바꿈이 중요함", "항목 기호는 최대한 확장, 다만 보기와 확실히 구분"):** 시험지는 질문 문장과 번호 보기 사이에 `(가) …` `(나) …`처럼 기호가 붙은 제시 항목을 둔다. 가져온 문제는 이 항목이 한 줄로 이어져 저장되어 있을 수 있다(예: "옳은 것만 묶인 것은? ( ) (가) … (나) … (다) … (라) …"). 화면은 문제 내용 전체를 보이는 곳에서 이 항목 묶음을 찾아 (1) 질문 문장(앞 문단)과 문단으로 나누고, (2) 항목마다 줄을 나누며, (3) 묶음을 질문 문장과 보기 사이의 박스(접근 가능한 이름 `제시 항목`인 목록, 항목 하나 = 목록 항목 하나)에 넣는다. 항목 기호는 인쇄된 그대로 보이고(번호를 다시 매기지 않음), 줄이 넘치면 기호 뒤에서 들여쓴다(hanging indent).
    - **항목 기호(같은 계열, 첫 기호부터 빠짐없이 차례로 2개 이상):** 한글 `가`~`하`, 한글 자음 `ㄱ`~`ㅎ`, 영문 대문자 `A`~`Z`, 영문 소문자 `a`~`z`, 로마 숫자 `Ⅰ`~`Ⅻ`·`ⅰ`~`ⅻ`·`I`~`XII`, 아라비아 숫자 `1`~`20` 각각의 `(x)`·`（x）`·`x)`·`x.` 형식과 원문자·괄호문자 `㉠`~`㉭`, `㉮`~`㉻`, `㈀`~`㈍`, `㈎`~`㈛`, `ⓐ`~`ⓩ`, `Ⓐ`~`Ⓩ`, `⑴`~`⒇`, `⒜`~`⒵`. 같은 묶음 안에서는 형식(괄호·`)`·`.`)도 같아야 한다. 괄호 안 공백(`( 가 )`)은 무시한다. 한 문단 안에서 그 계열·형식의 항목 기호(아래 조건을 갖춘 것)가 하나라도 순서를 벗어나면(빠짐·건너뜀·뒤바뀜, 예: `(가) … (다) … (나) …`) 그 문단은 나누지 않는다(일부만 묶지 않음).
    - **보기와의 구분:** 보기 기호인 `①`~`⑳`·`❶`~`❿`·`➀`~`➓`는 제시 항목 기호로 쓰지 않는다(그런 줄은 보기 또는 본문 그대로 둔다). 아라비아 숫자 계열은 괄호형 `(1)`·`⑴`·`1)`만이며 `1.`은 쓰지 않는다(보기 번호 `1.`과 헷갈림). 보기는 지금처럼 문제 내용 밖의 별도 목록(`보기`, `1.` 번호)이고, 제시 항목은 그 위의 박스 안에 인쇄된 기호로 보여 둘이 섞이지 않는다.
    - **본문 속 언급은 항목이 아니다:** 기호 앞은 줄 시작 또는 공백, 기호 뒤는 공백(또는 줄바꿈)이고 그 뒤에 내용이 있어야 한다. 그래서 "(가)와 (나)에 들어갈 말", "빈칸 (가)에" 같은 문장 속 언급은 나누지 않는다. 첫 항목 앞의 질문 문장이 있으면 그 문장은 `?`·`.`·`:`·`)`·`」`·`>`(전각 `？`·`：`·`）` 포함) 또는 빈 답 괄호(`( )`·`（ ）`)로 끝나야 한다(문장 한가운데에서 시작하는 목록은 나누지 않음).
    - **범위:** 묶음은 첫 항목부터 문단 나눔(빈 줄) 또는 문제 내용 끝까지이며, 마지막 항목 뒤에 빈 줄로 나뉜 문단(예: "위에서 옳은 것을 고르면?")은 박스 아래 문단으로 남는다. 묶음 앞 질문 문장 끝의 빈 답 괄호는 §4 10과 같이 지운다(박스 앞이 그 문장의 끝이므로). 항목 묶음이 없는 문제 내용은 지금과 같다.
    - **발문의 표 (UX12-EXTRACT-3 2026-11-06, [QTABLE-01](screens/question-tables.md)):** 발문 안 GFM pipe 표 묶음은 같은 자리에 표로 보인다(`StemBlocks`·`StemText`, 좁은 화면은 표 영역 안 가로 스크롤). 제시 항목 판정은 표 묶음 사이의 글자에만 적용하고 칸 안의 기호는 항목이 아니다. 표 앞 문장 끝의 빈 답 괄호는 §4 10처럼 지운다. 형식이 어긋난 표는 글자로 보인다. 보기 전부가 ` | `로 나뉘어 같은 칸 수(2 이상)면 보기 행 안에서 열을 맞추고, 발문 끝의 표 머리글 행은 보기 위 열 머리글로 옮겨 보인다(`optionGrid`, 표시 전용, 보기 행마다 판정하므로 섞어도 안전).
    - **표시 전용**이다(§4 10과 같음): 저장값·revision·API·fingerprint·검색·편집기 입력값은 바뀌지 않는다. 한 줄 미리보기(Heatmap preview, 목록 행, 각주, 묶음 목록)는 지금처럼 공백을 하나로 접어 보인다. 문제 내용 전체를 보이는 곳 — 풀이 panel·순서 풀이·모의고사(QVIEW-01 `QuestionStem`), 문제 상세 dialog, 가져오기 초안 검토·원본 비교, 모의고사 문제 dialog, 문서 편집기의 문제 카드(DOC-02), 공유 보기 panel — 이 같은 한 순수 함수(`apps/web/src/lib/questions/stem-items.ts`)와 같은 부품을 쓴다. 박스는 semantic token(테두리 `--color-border`, 반경·간격 token, 옅은 표면)만 쓴다.
    - **가져오기(새 추출):** 이 규칙은 줄 모양에만 쓴다 — 어떤 줄이 보기인지 새 문제인지 가르는 추출기의 판단(예: 제시 항목 아래의 `1. (가)` 보기)은 이 규칙보다 넓게 그대로 둔다(줄 모양 규칙에 맞지 않는 항목 목록이어도 보기를 잃지 않음). 추출기는 제시 항목 줄을 공백이 아니라 줄바꿈으로 잇고, 질문 문장과 첫 항목 사이에 빈 줄을 둔다(줄이 넘친 항목의 이어지는 줄은 공백으로 이음). AI 보조 정리 프롬프트(`questions.extract/v3` 이후)도 같은 모양을 요구하며, 원문 대조는 공백·줄바꿈을 무시하므로 바뀌지 않는다. 이미 저장된 문제는 고치지 않는다(위 표시 규칙이 보인다). 세부: [QPLAY-01](screens/questions-practice.md) AC14.

## 5. 문제 변형 출제

> **MOCK-SPEC 2026-11-01:** 사람이 승인해 은행에 등록하는 변형 출제(아래 워크플로·QGEN-MULTI)는 폐지된다(QGEN-RM, 사용자 결정 1). 아래 표의 변형 유형·검증 규칙은 모의고사(§11)가 그대로 쓰며, 워크플로의 "사람 승인 → CONFIRMED" 단계 대신 "검증 통과 → 그 모의고사 안에만 저장"이 된다. 이미 등록된 변형 문제와 lineage는 보통의 확정 문제로 남는다.


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
- 문제 생성에 검색된 책 원문을 근거로 제공할 수 있지만, 범용 RAG 챗봇이나 자동 답변 기능은 범위 밖이다. 예외(ASK-SPEC 2026-11-01, 사용자 요청): Workspace 문서에 근거한 AI 질문(ASK-01)과 제출 후 AI 해설(AIEXPL-01) — §13.
- 원본 문제나 출처 문서를 변경해도 파생 문제는 자동 덮어쓰지 않는다. 출처 revision과의 차이·검토 필요 상태를 노출한다.

### 묶음 변형 출제 (QGEN-MULTI 2026-10-23)

원본 여러 개를 한 번에 변형한다: `POST /workspaces/{id}/question-generation-batches` (편집 권한, 보관 Workspace는 403, `Idempotency-Key`).

- **묶음 = run 묶음.** 새 테이블 없이 원본마다 보통의 generation run(원본 revision 고정, `question.generate` job 하나)을 같은 트랜잭션에서 만든다. run의 `params`에 `batch_id`·`batch_mode`·`batch_position`(·임의 선택이면 `batch_seed`)를 기록하고 `GET /workspaces/{id}/question-generation-batches/{batch_id}`가 그 run들을 순서대로 돌려준다(원본 번호·문제 앞부분 포함, 정답 없음). worker·초안·검증·승인·등록·lineage는 단일 run과 같다 — 사람이 승인한 초안만 원본별 run의 publish로 등록된다.
- **원본 고르기.** `selection.mode = "selected"`: `question_ids` 1~20개(중복 불가). 모두 이 Workspace의 살아 있는 확정 문제여야 한다 — 다른 Workspace·삭제·없는 id는 단일 run과 같은 404, 초안·보관 문제는 409 `question-not-confirmed`(요청 전체 거절, run 없음). `selection.mode = "random"`: `count` 1~20, 선택 필터 `chapter`(id 또는 `none`), `question_type`, `statuses`(Heatmap 판정 `unseen|viewed|incorrect|correct|retry`, 요청한 사용자의 풀이 상태 기준), `favorite`(true = 즐겨찾기만), `seed`(0~2^31-1). 서버가 Workspace의 확정 문제 중 필터에 맞는 후보를 Heatmap 순서로 만든 뒤 `random.Random(seed).sample`로 `min(count, 후보 수)`개를 고른다(같은 seed·같은 후보 → 같은 선택). seed가 없으면 서버가 정해 응답과 run에 남긴다. 후보가 없으면 409 `no-matching-questions`, run 없음.
- **한도(비용 보호).** 원본 ≤ 20, 원본 수 × 변형 유형 수 × `candidate_count` ≤ 60(초과 422). 묶음 시작은 Workspace 단위 advisory lock으로 직렬화하고, 그 Workspace에서 진행 중(대기·생성 중, job이 실패·취소되지 않은) run과 새 원본 수의 합이 40을 넘으면 409 `generation-busy`. 사용자별 묶음 시작 `QUESTION_GENERATION_BATCH_RATE_LIMIT_PER_MINUTE`(기본 6, in-process token bucket) 초과는 429 + Retry-After(설정은 UX8-QGEN-DEAD에서 지움). 같은 `Idempotency-Key`의 재시도는 rate limit·한도 검사 전에 저장된 묶음을 돌려주고 대기 중 job을 다시 broker에 넘긴다.
- 보기 섞기(`OPTION_SHUFFLE`)는 묶음에서도 422(생성이 아님).

## 6. 문제 PDF import

`PDF → parser/OCR → 번호/선택지/그림 범위 추출 → LLM structured extraction → schema 검증 → DRAFT 비교 화면 → Confirm`.

원본에 존재하지 않는 정답 생성 금지; 정답지가 없으면 null. 페이지/영역 provenance 유지.

추출 시작은 서버가 맡는다(QIMP-AUTO 2026-10-21, QIMPORT-01-AC06): `question_paper` 문서(UX6-UPLOAD부터 확신이 높은 `mixed` 문서도, 아래)의 `document.parse` job이 revision을 활성화하는 트랜잭션에서 `public.worker_start_question_import`가 import run(`started_by = 'system'`)과 첫 `question.import` job을 만든다. 귀속은 parse job의 사용자(업로더)와 문서의 Workspace이며 client가 보낸 id는 쓰지 않는다. 문서마다 한 번만(이미 run이 있으면 시작하지 않음, 부분 unique index), Workspace가 활성이고 사용자가 여전히 owner/editor일 때만 시작한다. job은 parse job이 끝난 뒤 worker가 broker에 넘기고, 놓치면 reconciler가 grace 이후 넘긴다. `POST /workspaces/{id}/question-imports`는 준비 완료된 모든 문서를 받으며(UX6-UPLOAD; 이전에는 `question_paper`만) 문서의 활성 revision에 run이 있으면 그 run을 돌려주고(attach), 없을 때(QIMP-AUTO 이전에 처리된 PDF, 확신이 낮은 `mixed`, 교재)만 새 run을 만든다. 같은 문서에 대한 시작은 문서 행 잠금(FOR UPDATE)으로 직렬화된다.

자동 분류(UX6-UPLOAD 2026-10-28, DOC-01-AC07/AC08): 업로드는 문서 관리 한 곳이며 종류를 고르지 않는다(`upload-intent` `document_type = auto` → 문서는 `book`, `type_source = auto`로 생성). `document.parse` job이 첫 revision을 색인·게시하기 전에 canonical revision을 `book_core.extractor.classify_content`로 분류하고, 게시 트랜잭션에서 `public.worker_classify_document`가 결과를 한 번만 적는다: `content_kind`(`book` | `question_paper` | `mixed`), `document_type`(`question_paper`면 `question_paper`, 나머지는 `book` — 본문 여부라서 `mixed`도 검색·출제 근거·챕터 매칭에 쓰인다), `detection`(분류 수치만, 문서 텍스트 없음). 분류와 import(`QuestionExtractor`)는 같은 읽기를 쓴다(`segment_chapters` + `answer_entries`): `제N장`·`N장`·`Chapter N`·`제N편`·`Part N` 번호가 붙은 heading에서 장을 나눠 `segment()`를 장마다 돌린다(장마다 번호가 다시 시작하고 장마다 정답지가 있는 교재에서, 문서 전체를 한 번에 읽으면 첫 정답지 뒤를 모두 정답지로 읽어 이후 장의 문제를 잃는다). 다른 heading에서는 나누지 않는다(Docling은 문제 줄·`정답:` 줄·이어진 발문도 heading으로 낸다). 정답지 매칭: 문서에서 한 번만 나오는 번호는 문서 전체 정답지에서(이전과 같음), 장마다 반복되는 번호는 그 장의 정답지에서(그 장에서 한 번만 나오거나, 같은 번호 중 묻는 문제 — 보기·질문 단서 — 가 하나일 때). 장이 하나인 문서는 이전과 똑같이 읽는다:
- **강한 문제** = 인쇄된 `정답:` 줄이 있거나, 첫 label부터 이어지는 보기 2개 이상(`①②`, `A B`, `(1)(2)`)에 질문 단서(`?`, `시오`, `것은`, `고르`, 답란, `which`/`choose` 등) 또는 보기 label을 답으로 적은 정답지 항목이 있거나, 질문 단서와 정답지 항목이 있는 문제. 번호만 붙은 줄은 약한 증거라 세지 않는다(교재 heading `1. 개요`, 법 조문 `1. 예금자보호법` + `① 이 법은 …`).
- **coverage** = 문제(강한 문제와 단서가 있는 보기 없는 문제)가 차지하는 줄(발문 10줄·보기마다 3줄·정답 줄·해설 20줄까지)과 정답지 줄의 글자 수 / 전체 텍스트 줄의 글자 수.
- 규칙(`book-core-content-classifier/2`, /1과 임계값은 같고 `reading_order`로 읽는다): 강한 문제 < 3 → `book`; coverage ≥ 0.6 → `question_paper`; 그 밖 → `mixed`. 확신 `high`: 강한 문제가 없는 book, coverage ≥ 0.75인 question_paper, 강한 문제의 절반 이상에 정답이 있고 번호 건너뜀이 20% 이하인 mixed.
- 추출 자동 시작: `question_paper`와 확신 `high`인 `mixed`만 같은 트랜잭션에서 `worker_start_question_import`(위 QIMP-AUTO, `mixed` book도 받도록 확장)로 시작한다. 확신 `low`인 `mixed`는 표시만 하고 사용자의 `문제 추출`을 기다린다.
- 다시 분류하지 않는다: 이미 분류된 문서, 사람이 고른 종류(`type_source = user`: 업로드 때 고른 `book`/`question_paper`(이전 경로) 또는 `종류 변경`), 교정 revision(부모가 있는 revision), 재시도·중복 전달은 아무것도 바꾸지 않는다. 분류 전에 처리가 실패한 auto 문서는 종류가 없다(`kind = null`).
- 사람의 `종류 변경`: `PATCH /documents/{id}` `{kind, extract = true}`(편집 권한, 보관 Workspace 403, 삭제·다른 Workspace 404, 준비 완료만 — 아니면 409 `document-not-ready`). 문서 행 FOR UPDATE 아래에서 `document_type`·`content_kind`를 함께 바꾸고 `type_source = user`로 고정하며(분류 수치 `detection`은 남김) `document.kind_changed` 활동을 남긴다. 본문(`book`)에서 `question_paper`로 바꾸면 검색·출제 근거·챕터 매칭에서 빠지므로, 살아 있는 문제의 챕터·등록 대기(미등록) import 초안의 챕터·제출된 서버 등록(QIMP-JOB)의 대기(`pending`) 항목 챕터(자동 추천 챕터는 항목에만 저장된다; 그 등록 job이 대기·실행 중일 때만 — 실패·취소된 등록이 남긴 `pending` 항목은 다시 처리되지 않으므로 막지 않는다)가 이 문서의 챕터이거나 살아 있는 문제의 출처(가져온 출처 제외)가 이 문서면 409 `document-in-use`로 거절한다(제출되지 않은 초안의 추천은 읽을 때마다 교재로 다시 계산되고 등록 때 `chapter-changed`로 확인되므로 따로 막지 않는다). 그래도 경쟁으로 등록 job이 교재가 아닌 문서의 챕터를 만나면 그 항목은 `refused`/`stale-draft`로 거절하고 다른 항목은 계속 등록한다(문제지 챕터 아래에 등록하지 않는다). `question_paper` → `book`/`mixed`는 막지 않는다. 어느 방향이든 초안·run·문제를 지우지 않는다. 새 종류가 `question_paper`·`mixed`이고 `extract`이며 문서에 import run이 없으면 같은 트랜잭션에서 사용자 이름의 run과 첫 job을 만든다(`POST /question-imports`와 같음; 이미 있으면 그대로). 같은 종류로의 PATCH는 아무것도 바꾸지 않는다(멱등).
- 한계·보정: 규칙 기반이라 오분류가 있을 수 있다(교재 본문이 문제 형식으로 쓰인 경우 등). 그래서 `종류 변경`이 있고, 임계값은 `eval/classify_pdfs.py`로 로컬 실제 PDF(저장소에 넣지 않음)에서 보정한 결과를 붙여서만 바꾸며 바꾸면 버전을 올린다. Fork는 `document_type`만 복사하므로 사본의 `교재+문제`는 `교재`로 보인다(후속).

읽기 순서(UX12-EXTRACT-2 2026-11-06): Docling 본문 순서는 인쇄 순서와 다를 수 있다(뒤 쪽 블록이 앞에 온다). import, LLM 요청, 분류는 모두 같은 `book_core.extractor.reading_order(blocks)`를 거친 목록을 읽고, 출처 영역도 같은 목록에서 계산한다. 순서: 블록이 시작하는 쪽 → 행(첫 블록과 y0 차이 3pt 이내) 위에서 아래로 → 행 안에서 x0 왼쪽부터. 단순 y 정렬은 한 줄의 칸을 뒤바꿔(보기 라벨과 내용) 쓰지 않는다. 2단 쪽(본문 가운데 양쪽에 폭 60pt 초과 블록이 각각 4개 이상이고 가운데를 가로지르는 블록이 3개 이하)과 bbox 없는 블록이 있는 쪽은 parser 순서를 유지한다. 2×2로 인쇄된 보기는 2단이 아니다. 본문 영역(쪽마다 텍스트 범위의 중앙값; 텍스트 쪽이 4쪽 이상일 때만) 왼쪽·오른쪽·위에 완전히 벗어나고 캡션이 없는 이미지는 여백 장식으로 보고 같은 단계에서 뺀다(정렬만 하면 장식이 앞 문제에 붙어 영역이 다음 쪽까지 늘어난다). 높이 2pt 미만의 문장 부호 한 글자도 인쇄 흔적으로 보고 뺀다(높이가 보통인 `)`는 발문의 일부다). 순서를 고쳐 문제가 가진 텍스트 블록이나 순서가 달라지면 초안에 `reading_order_repaired` 참고 안내를 남긴다(확인 대상이 아니라 `전체 선택`에 남는다). 보기 수가 문서 최빈값과 다르고 그 수가 객관식 10문제 이상 중 10% 미만이면 `option_count_outlier`, 보기 없는 문제 바로 뒤 문제의 보기 번호가 겹치면 두 문제 모두 `options_on_next_question` 경고다. 이미 만든 초안과 문제는 다시 추출하기 전까지 그대로다(EXTRACT-6). 문서 뷰어는 초안의 원문 블록을 카드로 바꾸지 않고, 선택한 블록이 초안에 속하면 문제 전체 영역을 표시한다(UX12-EXTRACT-AC01).

표(UX12-EXTRACT-4 2026-11-06, D-11): 문제 안에서 보기가 아닌 표는 `stem`의 인쇄 위치에 GFM pipe 표로 넣는다(앞뒤 빈 줄, 형식은 문서 내보내기 DOC-03과 같은 함수, 구조화 셀은 후속 EXTRACT-9). 보기 뒤에 나온 비보기 표는 버리지 않고 발문 끝에 둔다. 표 칸은 제시 항목 줄 나눔(`break_stem_items`)을 타지 않는다. 표가 든 초안에는 `table_in_stem` 안내가 붙는다. 이 안내는 추출에 대한 참고이므로 `전체 선택`을 막지 않는다. AI 보조 정리 입력에도 같은 표 행이 들어가고, 프롬프트(`questions.extract/v4`)는 pipe 행을 그대로 옮기게 한다. 공백을 뺀 글자가 같아도 표 행이 무너진 AI 발문은 쓰지 않는다. 보기 표는 행 시작 칸의 원문자로 찾는다: 라벨만 있는 칸(`①`), 내용이 붙은 칸(`①xxx`), 한 행의 여러 칸(`① x | ② y`)을 읽는다. 첫 열이 라벨 열이면 그 옆 칸은 라벨을 언급해도(`①, ②`) 보기 내용이다. 라벨로 시작하는 행을 하나라도 읽지 못하면 행을 지우지 않고 표 전체를 발문에 둔다. 첫 칸에 라벨이 없는 행은 보기 행이 아니고, 라벨은 ①부터 빠짐없이 이어져야 한다(이어지는 쪽의 표는 그 표 안에서만 연속). 조건에 맞지 않는 표는 발문 표다. 분류(`classify_content`)의 coverage는 발문 표를 세지 않으므로 바뀌지 않는다. 수정은 새 추출에만 적용되고 등록된 문제의 발문은 그대로다(EXTRACT-6).

정답 출처는 인쇄된 정답지뿐이다: 별도 정답 섹션(문제 번호로 매칭) 또는 문제 바로 뒤에 인쇄된 `정답: ②` 줄(그 문제에만 적용되므로 장마다 번호가 1부터 다시 시작해도 된다). `정답:` 줄 뒤의 인쇄된 해설은 초안의 해설(explanation)로 보존하고 선택지로 읽지 않는다. 마침표 없는 번호(`01 …`)는 heading 줄이거나 질문 단서(`?`, `시오`, 답란 `( )`)가 있을 때만 문제로 읽는다. 문제의 출처 영역(provenance)은 발문과 모든 선택지(표로 인쇄된 선택지 포함)를 쪽마다 하나로 묶은 영역이며, 정답 줄과 해설은 포함하지 않는다. PDF import draft는 생성 draft와 공통 review 컴포넌트를 사용하되 source type을 별도로 보존한다.

승인과 등록(QIMP-BULK 2026-10-22, QIMPORT-01-AC03): import 검토 화면은 초안을 하나씩 승인하지 않고 사람이 고른 초안 목록을 `POST /question-imports/{id}/publish`(`approve: true`, `{draft_id, version}` 최대 200개)로 보낸다. 선택이 곧 승인이다: 보낸 version과 현재 version이 같고 확정 가능한(승인 불가 error 검증·정답 없음이 없는) 초안만 같은 트랜잭션에서 `approved`(reviewed_by = 호출자, reviewed_at = 지금; 이미 승인된 초안은 기존 승인 유지)로 바꾸고 CONFIRMED 문제로 등록한다. 바뀐 초안(`stale-draft`)과 확정할 수 없는 초안(`not-publishable`)은 그대로 두고 `refused`로 돌려준다 — 조용히 등록하지도, 요청 전체를 실패시키지도 않는다. 다른 import의 id는 요청 전체를 404로 거절한다. 이미 등록된 초안은 같은 문제를 돌려준다(초안별 멱등). `approve` 없는 요청은 기존대로 미리 승인된 초안만 all-or-nothing으로 등록한다(변형 출제 publish와 같은 계약).

서버 측 등록(QIMP-JOB 2026-10-23, QIMPORT-01-AC07): 검토 화면은 위 batch를 브라우저에서 보내지 않고 선택 전체를 `POST /question-imports/{id}/registrations`로 한 번 보낸다(최대 5000개, `Idempotency-Key`). API는 같은 트랜잭션에서 초안마다 `question_import_registration_items` 행(보낸 version, 등록할 챕터)을 기록한다 — 이미 등록됨은 `skipped`, 보낸 version과 다름은 `refused`/`stale-draft`, 확정 불가는 `refused`/`not-publishable`, 나머지 `pending` — 그리고 run의 `registration_job_id`가 가리키는 `question.import_register` job(호출자 이름, 미발행 → commit 후 발행, 놓치면 reconciler)을 만든다. job은 SECURITY DEFINER `public.worker_register_import_drafts(job, batch)`를 남은 항목이 없을 때까지 부른다(batch = 한 트랜잭션, 100개): Workspace 행 FOR SHARE 재확인(보관·삭제·권한 상실이면 `workspace_unavailable`로 job 실패, 남은 항목은 그대로), 초안 FOR UPDATE(위치 순, publish와 같은 잠금 순서) → 챕터 문서 FOR SHARE, 초안마다 이미 등록됨 → `skipped`, version 다름 → `stale-draft`, 아니면 API publish와 같은 내용으로 승인(job 사용자, 이미 승인이면 유지)·CONFIRMED 문제·revision 1·import 출처 행·`question.created`·`published_question_id`, batch마다 `question_import.published`. 같은 version이면 API가 제출 시 확인한 확정 가능 상태 그대로이므로 내용 규칙을 SQL에서 반복하지 않는다(DB 제약이 거부하면 그 초안만 `not-publishable`). 항목이 job의 영속 진행 상태라 재시도·중복 전달은 남은 `pending`만 이어서 처리하고, 이미 문제에 연결된 초안은 다시 등록하지 않는다. 진행(처리/전체)과 거절 목록은 `GET /question-imports/{id}/registrations/{registration_id}`. quiz_worker는 초안·문제 테이블 쓰기 권한 없이 이 함수만 실행한다. 이전 등록이 대기·진행 중이면 새 제출은 409 `import-registration-running`.

챕터(CHAPTER-MAP 2026-10-23, QIMPORT-01-AC08): import 초안은 교재(`book`) 챕터 아래에 등록된다. `question_drafts.chapter_manual = false`이면 API(`book_core.chapter_matching`)가 읽을 때마다 추천한다 — 초안 첫 출처 블록(`evidence[0].block_ids[0]`, 없으면 첫 쪽의 첫 블록)의 `content_blocks.chapter_id`에서 시작해 상위 장까지(깊은 것부터) 제목 key(NFKC·casefold, 앞 번호 `제N장`/`N장`/`Chapter N`/`N.`/`N.M` 분리, 문자·숫자만)를 Workspace의 살아 있는 책들의 활성 revision 챕터 key와 비교: 첫 일치 단계에서 후보 1개 → 추천(`matched`), 여럿 → 장 번호 일치 1개면 추천, 아니면 `ambiguous`(추천 없음); 일치 단계 없음 `no_match`, 시작 블록에 장 없음 `no_source_chapter`. 추측 금지: 숫자만으로 맞추지 않는다. 장 번호로도 못 좁히면 후보 중 `level`이 가장 작은(outline에서 가장 높은) 것이 하나뿐일 때 그것을 추천하고(CHAP-MATCH 2026-11-04), 아니면 `ambiguous`다. 검토자가 `PATCH` `chapter_id`(책의 현재 revision 챕터 또는 null)를 보내면 `chapter_manual = true`로 그 선택이 이긴다(내용 변경이 아니므로 승인 유지). 저장된 챕터가 옛 revision이면 등록 시 같은 `section_key`의 현재 revision 챕터로(없으면 null) 해석한다 — 문제의 `documents_remap_question_chapters`와 같은 규칙. 등록(publish·서버 등록 job)은 책 문서를 FOR SHARE로 잠근 뒤 해석해 revision 게시와 경쟁하지 않는다. 추천은 초안 version을 바꾸지 않고 달라질 수 있으므로(교재 추가·교정) 클라이언트는 선택마다 보이던 `chapter_id`를 보내고, 서버의 현재 챕터와 다르면 publish·registrations 요청 전체를 409 `chapter-changed`로 거절한다(Codex P2; 보내지 않으면 검사 안 함 — API 호환).

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
- 마지막 채점 결과가 정답이 아닌 문제에는 `다시 풀기` toggle이 없고(기존에 켜진 플래그는 Heatmap·필터에 그대로 보임), API는 켜기를 409 `retry-requires-correct`로 거절하며, 이후 오답이 채점되면 플래그가 꺼진다(§17).
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
- **출처 각주:** 모든 항목은 입력 문제를 1개 이상 각주로 단다(`[^1] 12번`). 입력에 없는 문제 인용, 각주 없는 항목, 본문에 없는 인용은 서버가 버리거나 거절해 저장·표시하지 않는다. 각주의 문제 번호는 Heatmap의 인쇄 번호와 같다: 노트 안에서는 장이 자명하므로 번호만 쓰고(`12번`) 번호가 없으면 `번호 없음`이다(UX12-NUMBER). 각주 글자는 읽을 때 문제의 지금 번호로 다시 계산하므로 이전 노트도 같게 보인다. 문제 행이 아예 없으면 저장된 글자가 그대로 보인다.
- **표시:** 사람의 승인 없이 바로 보이고(`AI 생성` 표시), 편집하지 않고 다시 만들기만 한다. 다시 만들면 새 버전이며 이전 버전은 남는다. 장의 확정 문제가 바뀌면(추가·revision·삭제·보관·장 이동) stale로 표시한다. 노트 생성·열람은 문제의 VIEWED 상태나 풀이 기록을 바꾸지 않는다(§2.1).
- **정답 노출:** 노트는 정답·해설에서 나온 내용이므로 문제 풀이 panel과 practice API에는 노트를 넣지 않는다(§4의 제출 전 정답·해설 비노출 규칙 유지). UX9-SPEC(2026-11-02, 사용자 결정 C7) 전에는 본문을 기본으로 접고("정답·해설 포함") 풀이 panel이 열리면 다시 접었다. 이제 본문은 늘 보이고, 노트 panel은 modal이라 열린 동안 Heatmap을 누를 수 없으며(사용자 결정 2026-11-02 — 처음의 C9를 대체) 각주로 연 풀이 panel이 위에 있는 동안 노트 내용을 가린다([CHNOTE-02](screens/chapter-note-tools.md)).
- **읽기 도구·하이라이트 (UX9-SPEC 2026-11-02):** 노트 안 검색·각주 미리보기(발문·보기만, 정답 없음)는 [CHNOTE-02](screens/chapter-note-tools.md), 사용자별 하이라이트와 문제 해설 하이라이트를 모은 `내 하이라이트`는 §15·[HILITE-01](screens/highlights.md).
- **권한:** 모든 구성원이 읽고, owner·editor가 활성 Workspace에서 만든다. 공유 링크 게스트는 장마다 최신 노트를 출처 일치(인용 문제가 모두 살아 있는 CONFIRMED이고 active revision이 고정된 것과 같음)일 때만 읽는다(아래 공유 규칙). Fork는 출처 일치인 최신 노트만 문제 id 재매핑과 함께 복제한다.

## 공유 Workspace에서의 문제 개인정보 규칙 (v1.3 추가)
- 링크 Viewer는 published 문제, 선택지, 정답, 해설을 조회할 수 있지만 개인별 `question_user_states`와 `question_attempts`는 조회하지 않는다. 문제 열람도 VIEWED 처리하지 않는다.
- 공유 링크는 문제 등록/수정/삭제, 정답 변경, 사용자 시도 제출, 즐겨찾기·다시 풀기, 문제 변형 출제를 허용하지 않는다. 모의고사(§11)와 범위 풀이(§12)도 게스트에게 없다(MOCK-SPEC, 사용자 결정 2026-11-01). Fork는 모의고사를 복제하지 않는다(같은 결정).
- Fork된 Workspace는 published 문제·해설과 출처 문서를 새로운 ID로 복제한다. 문제별 개인 상태·풀이 이력은 복사하지 않으며 모두 UNSEEN으로 시작한다.
- 문제 root/derived lineage의 Fork 내부 참조는 새 ID로 매핑한다. 외부 원본 참조는 노출하지 않는다.
- 챕터 정리 노트(§9, DOCSUM-SPEC 2026-10-29): 링크 Viewer는 장마다 출처 일치인 최신 성공 노트만 읽을 수 있다(인용 문제가 삭제·보관·수정되면 다시 만들 때까지 본문 없음)(발행 문제의 정답·해설을 이미 볼 수 있으므로 같은 범위). 각주는 발행된 확정 문제만 링크·발문 앞부분을 보이고, 이전 버전·생성 상태·오류·비용은 보이지 않으며 만들기·다시 만들기는 할 수 없다.
- AI 질문·AI 해설(§13, ASK-SPEC 2026-11-01 사용자 결정): 링크 Viewer는 AI 질문을 할 수 없다. 이미 만든 최신 AI 해설은 발행된 확정 문제에서 읽기 전용으로 볼 수 있다(사용자 결정 2026-11-01 — 정답·해설을 이미 볼 수 있으므로 같은 범위). 만들기·다시 만들기·상태·비용은 없다. 이미 저장된 관련 본문(RELSRC-01)도 읽기 전용으로 보인다(사용자 결정 2026-11-01). Fork는 AI 질문 대화를 복제하지 않고, snapshot 문제 revision의 최신 AI 해설은 복제한다(사용자 결정 2026-11-01). 관련 본문은 복제하지 않고 다시 계산한다(사용자 결정 2026-11-01).

## 10. 중복 문제 정리 (UX7-DEDUP 2026-11-01)

사용자 요청 "중복 문제 제거 기능". 화면·AC는 [QOV-01](screens/questions-overview.md) "중복 문제 정리 dialog"(AC16·AC17)와 [QIMPORT-01](screens/questions-import.md) "중복 초안 표시"(AC10). 사용자 결정: (1) 같은 문제 = 같은 발문 + 같은 보기(정규화 후, 보기 순서 무관), 내용 일치만(유사도·embedding 없음), (2) 묶음을 검토해 남길 문제를 고르고 나머지는 **보관**(삭제 아님, 보관·초안 문제 dialog에서 되돌릴 수 있음), (3) 기존 확정 문제 검사(편집 권한) + 문제 PDF 가져오기 검토에서 표시, (4) 보관된 중복의 풀이 기록은 남긴 문제에 합쳐 보인다(attempt는 고치지 않음).

### 10.1 정규화와 fingerprint

하나의 순수 함수(`quiz_api.question_fingerprint`)가 기존 문제 검사와 가져오기 표시 모두에 쓰인다. 텍스트 정규화(발문·보기 각각):

1. **보기 번호·기호 제거(보기만, 소수점이 아닌 `.`·`)`로 끝나는 것만 — `1.5`는 번호가 아니다):** 앞의 `①`~`⑳`, `⑴`~`⒇`, `⒈`~`⒛`, `⒜`~`⒵`, `Ⓐ`~`ⓩ`, `㉠`~`㉻`, `❶`~`❿`, `➀`~`➓`와 `1)`·`1.`·`(1)`·`A.`·`A)`·`(A)`·`ㄱ.`·`ㄱ)`·`(ㄱ)`·`가.`·`가)`·`(가)` 형식(숫자 1~2자리, 영문 한 글자, 한글 자음 한 글자, `가`~`하` 한 글자). 지우면 비는 보기는 지우지 않는다. 원문자는 NFKC 전에 지운다(NFKC는 `①`을 `1`로 바꾼다).
2. ~~**발문 앞 번호 제거**~~ — 하지 않는다(사용자 결정 2026-11-01, "do not ignore anything" for the question asked; UX7-DEDUP-2): 발문의 `12.`·`(12)`·`Q12.`·`문제 12.`는 발문의 일부로 비교한다("12. 다음 중…"과 "다음 중…"은 다른 문제). `fingerprint/2`까지는 지웠다.
3. **NFKC** — 전각 문자·호환 문자를 하나로.
4. **빈 답란 표시 제거:** 안이 비었거나 공백·밑줄뿐인 괄호(`( )`, `(   )`, `[ ]`, `（ ）`, `(____)`)를 어디서든 지운다(끝의 `( )`가 대표 예).
5. **문장부호 제거:** `.` `,` `;` `:` `!` `?` `…` `·` `、` `。` `'` `"` `‘’` `“”` `「」` `『』` `〈〉` `《》` `<>`(인용·종결·구분 부호; 숫자 사이의 `.`·`,`는 남긴다 — `1.5`는 `15`가 아니다). 괄호·`-`·`−`·`+`·`=`·`/`·`%` 같은 수식에 쓰이는 기호는 **남긴다**(`2+(-3)`과 `2+3`이 같아지지 않도록; 사용자 결정 2026-11-01).
6. **공백 제거:** 모든 공백 문자를 지운다(띄어쓰기 차이 무시). 대소문자는 구분한다(사용자 결정 2026-11-01: 대소문자를 무시하지 않는다).

fingerprint = SHA-256(`fingerprint/3`, 문제 유형, 정규화한 발문, 정규화한 보기들을 **정렬한** 목록, 모범답안). **객관식**은 발문 + 보기이고 정답은 넣지 않는다. **단답형·서술형**은 발문 + 모범답안이다(사용자 결정 2026-11-01 "stem + model answer"): 단답형의 모범답안 = 허용 답(`accepted_answers`)을 같은 규칙(3~6)으로 정규화한 집합(정렬, 중복 제거), 서술형의 모범답안 = 채점 기준·모범답안(`rubric`)을 같은 규칙으로 정규화한 텍스트; 없으면 빈 값(모범답안이 없는 두 문제는 발문만 같으면 같다). 해설·챕터·출처·번호는 넣지 않는다. 유형이 다르면(예: 같은 발문의 단답형과 서술형) 다른 문제다(사용자 결정 2026-11-01). fingerprint는 저장하지 않고 검사·정리·가져오기 표시 때마다 계산하므로 버전을 올려도 기존 `question_merges` 연결은 그대로다(정리 요청만 그 시점에 fingerprint를 다시 비교하고, 연결 중인 중복을 다시 검사하는 곳은 없다). `fingerprint/3`부터 발문 앞 번호만 다른 문제는 더 이상 한 묶음이 아니다: 이미 합쳐진 연결은 남고, 보관 해제하면 각자 돌아오며 다시 합쳐지지는 않는다. 같은 묶음에서 객관식 정답(정답 보기의 정규화 텍스트 집합)이 서로 다르면 묶음에 `정답이 서로 다릅니다` 경고를 보이고 합치는 것은 막지 않는다(사용자 결정 2026-11-01 "warn and allow"; 단답형·서술형은 모범답안이 fingerprint에 들어가므로 묶음 안에서 다르지 않다).

### 10.2 정리(보관 + 기록 합침)

- **검사:** `GET /workspaces/{id}/question-duplicates` — 편집 권한(viewer 403 `insufficient-role`, 보관 Workspace 403 `workspace-archived`), 살아 있는 확정 문제만, fingerprint가 같은 2개 이상을 한 묶음으로. 묶음은 가장 오래된 문제의 Heatmap 순서, 묶음 안은 등록 순(`created_at`, id). 남길 문제 추천(`suggested_keep_question_id`) = **채점된 풀이가 가장 많은 문제**, 같으면 가장 먼저 등록된 문제(`created_at`, id)(사용자 결정 2026-11-01 "the one with the most attempts"). 채점된 풀이 = 그 Workspace의 현재 구성원(owner·editor·viewer 누구든)이 그 문제(와 이미 그 문제에 합쳐진 중복)에 남긴 `correct`/`incorrect` attempt 행 수(채점 대기 제출은 세지 않는다; 자기 채점은 채점 행 하나로 센다). 응답에는 추천만 있고 문제별 풀이 수·누가 풀었는지는 없다 — 다른 구성원의 개인 풀이 기록(`question_attempts`)은 Workspace 공유 범위가 아니므로(workspace-sharing.md §1) 화면에 수를 보이지 않는다. 응답은 발문·보기 텍스트(보기 id 포함)·번호·챕터·등록 시각이고 정답·해설·모범답안은 없다. 읽기만 하므로 다시 검사해도 같은 결과(정리 뒤에는 그 묶음이 없다).
- **정리:** `POST /workspaces/{id}/question-duplicates/merge` `{groups: [{keep_question_id, duplicate_question_ids}]}`(편집 권한, 최대 100묶음·묶음당 중복 50개). 한 트랜잭션에서 관련 문제를 id 순으로 FOR UPDATE하고 서버가 fingerprint를 다시 계산해 남길 문제와 같아야 한다(아니면 요청 전체 409 `not-duplicates`). 다른 Workspace·삭제·없는 id는 요청 전체 404, 같은 id를 두 번 보내면 422. 남길 문제가 확정이 아니면 409 `question-not-confirmed`. 중복은 확정 → **보관(ARCHIVED)**(revision은 그대로, `question.status_changed`·`question.merged` 활동)되고 `question_merges`에 남길 문제로의 연결이 생긴다. 이미 같은 문제로 합쳐져 보관된 중복은 아무것도 바꾸지 않는다(멱등; 응답의 `already_merged_question_ids`). 다른 문제로 합쳐졌거나 그냥 보관된 문제는 409 `question-not-confirmed`. 중복이 다른 문제들의 남길 문제였다면 그 연결을 새 남길 문제로 옮긴다(연결은 한 단계만: 남길 문제는 다른 문제의 중복이 아니다). 화면은 한도보다 큰 정리를 여러 요청으로 나눠 보낸다: 중복 50개마다 같은 남길 문제로 조각을 만들고, 한 요청에는 묶음마다 조각 하나만(같은 id 두 번 금지) 100개까지 담는다. 이미 같은 문제로 합쳐진 중복은 그대로 두므로 실패한 요청부터 다시 보내면 이어진다.
- **합친 학습 상태:** 남길 문제의 사용자별 상태 = 자신과 합쳐진(연결이 끝나지 않은) 중복들의 `question_user_states`를 합친 것(DB view `question_merged_user_states`): `first_viewed_at` 최솟값, `last_viewed_at` 최댓값, 마지막 채점 결과 = 채점 시각(`graded_at`)이 가장 늦은 결과, 즐겨찾기·다시 풀기 = 하나라도 켜져 있으면 켜짐(합집합). 채점 대기 = 묶음 전체에서 마지막으로 제출된 session이 채점 대기. attempt·session 행은 바꾸지 않는다(append-only 유지).
- **즐겨찾기·다시 풀기 끄기:** 남길 문제에서 끄면(`PATCH /questions/{id}/my-state` false) 그 사용자의 합쳐진 중복 상태 행의 같은 flag도 함께 끈다(합집합이라 하나만 끄면 다시 켜져 보이므로). 켜기는 남길 문제의 행에만 쓴다.
- **읽는 곳:** Heatmap overview(상태·집계·필터), 묶음 변형 출제의 임의 선택 상태 필터, my-state 응답, `GET /questions/{id}/attempts`(합쳐진 중복의 attempt도 시간 순으로, 각 항목의 `question_id`가 실제 문제), 이력의 풀이 기록(`merged_into_question_id`가 있으면 링크는 남길 문제를 연다). 정리 노트 입력·공유 화면·Fork는 확정 문제만 다루고 개인 상태를 쓰지 않으므로 바뀌지 않는다: 보관된 중복은 노트 입력·공유 목록에 없고, Fork는 확정 문제(남길 문제)만 복사하며 상태·attempt·연결을 복사하지 않는다(사용자 결정 2026-11-01: 사본에는 남길 문제만 있으므로 연결도 필요 없다). 모의고사 범위는 이 브랜치에 없다(생기면 같은 view를 쓴다).
- **보관 해제 = 합침 해제:** 합쳐진 중복을 보관·초안 문제 dialog에서 `보관 해제`(ARCHIVED → CONFIRMED)하면 연결이 끝나고(`ended_at`, `end_reason = unarchived`, DB trigger) 그 문제의 기록은 다시 그 문제의 것으로만 보인다; 남길 문제는 자기 기록과 남은 중복의 기록만 합친다(사용자 결정 2026-11-01). 합쳐진 동안 남길 문제에서 끈 즐겨찾기·다시 풀기는 중복 쪽에서도 꺼진 채 돌아온다. 보관된 중복을 삭제하면 연결은 남아 기록이 남길 문제에 계속 합쳐진다(사용자 결정 2026-11-01). 남길 문제를 보관·삭제하면 Heatmap에서 묶음 전체가 빠진다(중복은 보관 상태 그대로, 보관 해제하면 각자 돌아옴).

### 10.3 가져오기 검토의 중복 표시

`GET /question-imports/{id}/draft-summaries`·`/drafts`·초안 PATCH 응답의 `duplicate_of`: 등록되지 않은 초안의 fingerprint가 Workspace의 살아 있는 확정 문제와 같으면 `{kind: "question", question_id, number}`, 아니면 같은 가져오기에서 앞선(위치 순) 초안과 같으면 `{kind: "draft", draft_id, number}`, 아니면 null. 표시만 하고 막지 않는다: 중복 초안은 처음에 선택되지 않고 `전체 선택`에서 빠지며(사용자 결정 2026-11-01) 이유("이미 등록된 3번 문제와 같습니다" / "이 PDF의 5번 초안과 같습니다")를 보인다. 개별로 골라 등록할 수 있다(등록한 뒤 정리 dialog로 합칠 수 있다). 초안 내용을 편집해 저장하면 다른 초안의 중복 여부도 바뀔 수 있으므로(앞선 초안을 뒤의 초안과 같게, 또는 다르게 고침) 검토 화면은 저장 뒤 모든 초안 요약과 보고 있는 페이지를 다시 읽는다(Codex P2).

## 11. 모의고사 (MOCK-SPEC 2026-11-01)

화면·AC는 [MOCK-01](screens/mock-exams.md). 사용자 요청 "변형 출제 -> '문제 생성' 삭제 / 대신 '모의고사' 기능 추가".

- **정의:** 이름 + 출제 설정(변형 유형 §5 표 중 하나 이상, 문항 수, 난이도) + 범위(§12의 범위 고르기) → 서버가 범위의 확정 문제에서 원본을 seed로 골라 원본마다 문제 하나를 만든다. 모의고사는 Workspace 단위로 저장되고 이름 바꾸기·문제 편집·빼기·설정 바꿔 다시 만들기·삭제가 된다.
- **은행 밖 (사용자 결정 2 — 의도된 예외):** 모의고사 문제는 그 모의고사 안에만 있다. 만들어지는 즉시 풀 수 있고 `CONFIRMED` 문제·Heatmap 점(§3.1)·홈 집계(§7)·검색·정리 노트(§9) 입력이 아니다. 따라서 "생성·가져온 문제는 사람이 승인할 때까지 초안" 규칙은 적용되지 않는다 — 모의고사 문제를 은행에 등록하는 경로 자체가 없다. 대신 §5의 기계 검증(형식·정답 개수·정오 반전 정답 불일치·중복·출처 근거) 중 승인을 막던 검증을 통과해야만 저장된다. LLM이 선언한 정답은 검증 없이 쓰지 않는다.
- **호출 묶기 (사용자 결정 2026-11-01 "API 호출 최소화"):** AI 변형은 원본마다 호출하지 않고 token 예산(`MOCK_EXAM_MAX_PROMPT_TOKENS`·`MOCK_EXAM_MAX_OUTPUT_TOKENS`)에 맞는 만큼 원본을 한 호출에 모은다(passage를 공유하는 원본끼리, passage는 한 번만). 항목마다 따로 검증하고, 실패 항목은 모아서 한 번 다시 요청하며, 해석할 수 없는 응답은 반으로 나눠 다시 요청한다. 문항 수는 AI 유형이 있으면 최대 100(기본 20, 사용자 결정 2026-11-01) — 100문항 ≈ 호출 3~4번. 세부는 MOCK-01 "LLM 호출 묶기".
- **`보기 섞기`:** 원본 revision의 내용을 그대로 복사하고 보기 순서만 섞은 모의고사 문제(LLM 없음). 원본과 같은 option ID를 쓰므로 채점은 option ID 기준 그대로다.
- **원본과의 관계:** 모의고사 문제는 원본 문제와 고정된 원본 revision을 가리키지만 lineage(§5)는 만들지 않는다. 원본을 편집·삭제해도 모의고사 문제는 바뀌지 않는다.
- **편집·회차:** 편집은 새 revision(이전 풀이는 그때의 revision을 가리킴). 다시 만들기는 새 회차로 문제 목록을 바꾸고 이전 회차와 풀이 기록은 지우지 않는다(사용자 결정 2026-11-01, MOCK-01).
- **풀이 상태:** 모의고사 문제의 풀이는 `mock_exam_attempts`에 사람마다 저장되고 §2의 `question_user_state`·Heatmap 색을 바꾸지 않는다. 즐겨찾기·다시 풀기는 없다(사용자 결정 2026-11-01).

## 12. 범위 풀이와 통합 `QuestionViewer` (MOCK-SPEC 2026-11-01)

화면·AC는 [QVIEW-01](screens/question-viewer.md).

- **하나의 컴포넌트:** 문제를 하나씩 보이는 모든 곳(§3.2의 풀이 panel, 문제 상세, 공유 미리보기, 범위 풀이)은 `QuestionViewer`를 쓴다. 출처는 등록 문제(`bank`)와 모의고사 문제(`mock`) 두 가지이고 §4 풀이·채점 정책은 둘 다 같다(제출 전 정답·해설 비노출, option ID 채점, immutable attempt, 서술형 `PENDING`·자기평가).
- **범위 고르기:** 장 그룹 → 문제 두 단계 checkbox, 맨 위 `전체 선택`(지금 필터에 보이는 문제 전체, 일부 선택은 mixed), §7 필터(풀이 상태·즐겨찾기·유형)로 좁힘. 범위 단위는 사용자 결정(2026-11-01)이다(QVIEW-01 "범위 단위"). 한 묶음은 최대 5,000문제. 모의고사 만들기의 범위 고르기도 같은 부품이다.
- **순서:** 시작 전 `무작위 순서` checkbox. 꺼짐 = Heatmap 기본 정렬(§3.1), 켜짐 = 서버 seed shuffle. 순서는 묶음(`practice_run`)에 고정되어 새로 고침해도 같다.
- **기록:** `bank` 범위 풀이는 §2.1·§4 그대로 `viewed`·attempt·`question_user_state`에 반영된다(풀이 panel을 연 것과 같음). `mock`은 §11.

## 13. AI 질문 첨부·AI 문제 해설·관련 본문 (ASK-SPEC 2026-11-01 사용자 결정, ASK-SYNC 2026-11-02)

화면·AC는 [ASK-01](screens/ask-llm.md) "문제 첨부와 정답 비노출"과 [AIEXPL-01](screens/ai-explanations.md). 두 기능 모두 §4의 "제출 전 정답·해설 비전송"을 **서버에서** 지킨다 — LLM에게 주는 지시는 보안 경계가 아니므로, 제출 전에는 정답·해설을 LLM 요청에 넣지 않는다.

- **공개 수준(메시지마다 서버가 DB로 계산):**

| 곳 | 판정 | LLM 입력 |
|---|---|---|
| `practice` 첨부 제출 전 (QuestionViewer `practice`·`sequence(bank)`의 session — 등록 문제에는 UI 경로 없음, 서버 규칙으로 유지; 모의고사 `sequence(mock)`의 제출 전 `질문하기`가 쓴다 — 사용자 결정 2026-11-01) | 첨부 session에 그 사용자의 제출 없음 → `hint` | 번호·장·유형·발문·보기 글(표시 순서; 정답 보기의 글도 보통 보기로 들어감)·고른 답(미제출). 어느 보기가 정답인지(정답 id·표시·순서)·허용 답안·모범답안·채점 기준·해설·`question_sources` 구절 없음 — 단답·서술형은 보기가 없으므로 허용 답안·모범답안·채점 기준 글이 요청 어디에도 없음(ASK-01-C03) |
| 같은 곳 제출 후 | 제출 있음(채점 대기 포함) → `full` | 위 + 제출한 답·결과·정답·해설·출처 구절 |
| 문제 상세 dialog(QuestionViewer `manage`, `detail`) | `GET /questions/{id}` 권한 → `full` | 현재 revision의 문제·정답·해설·출처 (이미 화면에 보이는 것) |
| 모의고사 풀이(`sequence(mock)`)·관리(`manage(mock)`) | `mock_exam_practice_sessions`의 `mock_exam_attempts` 유무 / 편집 권한 | 같은 규칙. 내용은 `mock_exam_question_revisions` 행, 출처 구절은 그 revision의 `evidence` 중 현재 발행 `book` 블록(원본 문제의 `question_sources`가 아님) — ASK-01-C10 |
| 공유 게스트 | 없음 | AI 질문 없음 |

- `질문하기` 위치(사용자 결정 2026-11-01; ASK-SYNC에서 QuestionViewer 방식으로): 문제 상세(`manage`, `detail` → `full`)와 모의고사 문제(`sequence(mock)` 제출 전 `hint`·제출 후 `full`, `manage(mock)` `full`)만. 풀이 panel(`practice`)과 등록 문제 범위 풀이(`sequence(bank)`) header에는 없고, 그 둘의 유일한 경로는 제출 뒤 AI 해설 아래의 `AI 질문하기`(`full`)다.
- `hint`의 모델 지시(사용자 결정 2026-11-01): 정답·정답 보기를 말하지 말고 개념과 근거 구절로 돕는다. 교재 근거로 모델이 답을 추론할 수 있다는 한계는 저장된 정답이 새는 것이 아니다(교재는 열람 범위).
- 질문·AI 해설은 풀이(attempt)·열람(viewed)이 아니다: 풀이 기록·`question_user_states`·Heatmap 상태를 바꾸지 않는다(§2.1). 문제 상세의 정답 보기와 같은 규칙.
- **AI 해설:** 제출 후(그 session의 제출을 서버가 확인 — `practice`·`sequence(bank|mock)` 모두) 또는 문제 상세에서 만든다. 문제 revision마다 Workspace 공유 캐시 하나(사용자의 답은 입력이 아님; 모의고사 문제는 `mock_exam_question_revisions`마다 따로 — 원본 문제와 공유하지 않음), 정답은 서버의 정답이 기준(모델이 다른 정답을 말하면 버림). 사람이 쓴 `explanation`을 바꾸지 않고, 문제은행·정리 노트(§9) 입력·ASK 근거에 들어가지 않는다. 문제를 고치면(새 revision) 새로 만들어야 한다.
- **관련 본문(RELSRC-01):** 제출 후(서버가 session 제출 확인) 또는 문제 상세에서, 그 문제의 출처 블록을 먼저 두고 발문 + 정답 글로 검색한 교재 구절을 최대 5개 보인다(LLM 없음 — 사용자 결정 2026-11-01 방식 A). 문제 revision과 교재 발행 상태(`corpus_fingerprint`)마다 Workspace 공유 하나를 저장한다. ASK와 같은 검색 범위 규칙(문제지·`mixed` 문제 구간·요약·노트·AI 해설 제외). 영역은 접힌 채로 나오고 사용자가 처음 펼칠 때만 요청·계산·저장한다(사용자 결정 2026-11-04, RELSRC-COLLAPSE).
- **보관·중복 정리 (§10):** 캐시는 문제 revision 하나에 묶인다. 중복 정리로 합친 남길 문제는 자기 revision의 AI 해설·자기 `question_sources`로 만든 관련 본문만 보이고, 보관된 중복의 해설·출처를 더하지 않는다(합침은 학습 상태만). 보관된 문제는 보관·초안 문제 dialog의 문제 상세에서 자기 것을 보인다. 초안 문제의 AI 해설·관련 본문은 두지 않는다(서버 409; `질문하기`는 둠 — 사용자 결정 2026-11-02, ASK-SYNC (b)). 모의고사 문제 관리(`manage(mock)`)는 문제 상세처럼 제출 없이 둘 다 보인다(사용자 결정 2026-11-02, ASK-SYNC (a)).
- practice API(`practice-sessions`·`submit`, 모의고사 `mock-exam-questions/{id}/practice-sessions`·`mock-practice-sessions/{id}/submit`) 응답은 세 기능 때문에 바뀌지 않는다(AI 해설·관련 본문 필드 없음).

## 14. 챕터 재분배 (UX9-SPEC 2026-11-02)

화면·AC는 [CHREDIST-01](screens/chapter-redistribution.md). 사용자 피드백 "'챕터 재분배' 기능 필요 — 여러 문제를 한 번에 챕터에 할당 — 자동 챕터 분배 재시도 기능", 사용자 결정 2026-11-02 C1(`문제` 메뉴의 `챕터 재분배` dialog)·C2(추천 → 미리보기 → 적용, 사람이 정한 챕터는 기본 제외).

### 14.1 등록된 문제의 챕터와 출처 기록

- 문제의 챕터는 `questions.chapter_id`(교재 문서의 장, null = "챕터 없음")다. 문제 내용 revision(`question_revisions`)에 들어 있지 않으므로 **챕터를 바꿔도 새 revision이 생기지 않는다** — 버전 번호·attempt(그 시점 revision을 가리킴, immutable)·`question_user_states`·즐겨찾기·다시 풀기·중복 정리 연결(`question_merges`)은 그대로다. Heatmap(§3.1)은 장 그룹을 `chapter_id`로 나누므로 읽을 때마다 새 장에 보인다.
- **`chapter_source`(새 열):** `manual`(사람이 정함) | `auto`(자동 추천). 함께 `chapter_set_by`(사용자 id, 자동 등록·적용은 그 요청자)·`chapter_set_at`. 규칙:
  - `manual`: 직접 등록(문제 등록 dialog의 `챕터`), 문제 편집(`PATCH /questions/{id}`)에서 `chapter_id`가 바뀜, 가져오기 검토에서 검토자가 고른 챕터(`question_drafts.chapter_manual = true`)로 등록, 챕터 재분배의 직접 옮기기.
  - `auto`: 가져오기 등록의 자동 추천 챕터(`chapter_manual = false` 초안 — publish·서버 등록 job 모두), 챕터 재분배의 추천 적용(사용자 결정 2026-11-02).
  - 바꾸지 않음: 교정 발행이 장 id를 같은 `section_key`의 새 revision 장으로 다시 잇는 것(`documents_remap_question_chapters`), 보관·보관 해제, 중복 정리, Fork(값을 그대로 복사).
  - 기존 행 backfill(migration): 가져온 초안(`question_drafts.published_question_id`)에서 등록되었고 그 초안이 `chapter_manual = false`였던 문제는 `auto`, 나머지는 `manual`(사용자 결정 2026-11-02).
- 화면에는 `manual`만 "직접 정함" 글자로 보인다(챕터 재분배 목록). Heatmap·풀이 panel에는 보이지 않는다.

### 14.2 추천 다시 받기 (등록된 문제의 첫 출처 블록)

초안 추천(§6 "챕터", `book_core.chapter_matching`)과 **같은 함수**를 등록된 문제에 쓴다. 문제의 시작 블록:

1. 그 문제의 `question_sources` 중 가져온 출처(import provenance — 문제지 PDF의 발문·보기 영역)가 있으면 그것, 없으면 가장 먼저 만든 출처 행.
2. 그 행의 `block_ids[0]`; 없으면 `page_range` 첫 쪽의 첫 블록(그 행의 `document_revision_id`의 블록 — 지난 revision의 블록도 남아 있으므로 그대로 읽는다).
3. 시작 블록의 문서가 `book`이면 그 블록의 장을 그 문서 **현재 발행 revision**의 같은 `section_key` 장으로 옮긴 것이 추천이다(`source_in_book`; 없으면 `no_source_chapter`).
4. 아니면(문제지·`mixed`의 문제 구간) 그 블록의 `content_blocks.chapter_id`에서 상위 장까지 깊은 것부터 제목 key(NFKC·casefold, 앞 번호 분리, 문자·숫자만)를 Workspace의 살아 있는 책들의 현재 revision 장 key와 비교한다: 후보 1개 `matched`, 여럿이면 장 번호가 같은 하나만 `matched`, 아니면 `level`이 가장 작은 후보가 하나뿐일 때 `matched`, 아니면 `ambiguous`, 없으면 `no_match`, 시작 블록에 장 없음 `no_source_chapter`. 숫자만으로 맞추지 않는다(추측 금지). `no_match`·`ambiguous`이면 **문제지 자신의 장**이 추천이다(`paper_chapter`, §14.4).
5. 출처 행이 없으면 `no_source`(직접 등록한 문제 대부분).

추천은 저장하지 않고 미리보기 요청마다 계산한다(교재 추가·교정으로 달라질 수 있음). 미리보기는 읽기 전용이고, 적용은 보이던 지금 챕터(`expected_chapter_id`)를 함께 보내 그 사이 바뀐 문제가 있으면 요청 전체를 409 `chapter-changed`로 거절한다(CHAPTER-MAP의 등록 409와 같은 방식). 기본으로 `chapter_source = manual` 문제는 계산하지 않고 "직접 정한 챕터라 건너뜀"으로 센다.

### 14.3 옮기기 계약

- `POST /workspaces/{id}/questions/chapter-assignments` — 편집 권한·활성 Workspace, 1~5,000문제를 **한 트랜잭션**으로(전부 아니면 전무), `Idempotency-Key`. 잠금 순서는 문제 쓰기의 규칙 그대로 **문서 → 문제**다: Workspace FOR SHARE → 대상 장의 책 문서와 보낸 문제들의 지금 장 문서를 문서 id 순 FOR SHARE(`QuestionRepository.lock_documents`) → 문제 id 순 FOR UPDATE. 교정 발행은 문서 FOR UPDATE 뒤 `documents_remap_question_chapters`로 그 장의 문제를 고치므로 반대 순서(문제 → 문서)는 deadlock이 된다. 문서를 잠근 동안 `종류 변경`도 기다리므로 대상 문서가 `question_paper`로 바뀌었으면 잠근 뒤의 검사에서 422 `chapter-invalid`. 멱등은 `Idempotency-Key`로만 하고, 키 없는 재실행은 `expected_chapter_id`가 지금 장과 달라 409 `chapter-changed`다(CHREDIST-01-C03). 대상 장은 이 Workspace의 살아 있는 `book` 문서의 현재 발행 revision 장이거나 null. 세부 오류 코드는 CHREDIST-01-C02.
- 이력: `question_chapter_changes(id, workspace_id, question_id, from_chapter_id, to_chapter_id, source manual|recommendation|edit|import|chapter_edit, changed_by, changed_at)` append-only(UX9부터; 이전 변경은 없음). 활동 `questions.chapters_reassigned`(요청마다, 개수·source만).
- **정리 노트:** 옮긴 문제가 있던 장과 새 장의 노트는 stale(§9 "장 이동", CHNOTE-01-C03 fingerprint). 노트 본문·각주는 그대로이고, 옮긴 문제의 옛 장 노트 각주는 구성원에게 "삭제되었거나 옮긴 문제"로 보인다. 공유 게스트·Fork의 출처 일치 판정은 바뀌지 않는다(인용 문제의 상태·revision이 그대로이므로 계속 보임 — 내용은 이미 공개 범위).
- **이미 만든 것:** 범위 풀이 묶음(`practice_runs.item_ids`)·모의고사 문제·그 풀이는 바뀌지 않는다. 모의고사 범위 고르기의 출처 장 묶음은 원본의 지금 장(MOCK-01-C10)이라 새 장으로 보인다. 문제의 해설 하이라이트(§15)는 문제를 따라 새 장의 `내 하이라이트`로 간다.
- **문제 번호:** 번호는 바꾸지 않는다. 다른 장에서 옮겨 와 같은 장에 같은 번호가 둘이면 Heatmap 순서(`sort_order`, 번호, 등록 순)대로 둘 다 보인다(사용자 결정 2026-11-02).

### 14.4 문제지 장 폴백과 자동 재매칭 (CHAP-MATCH 2026-11-04 사용자 결정)

- **폴백:** 등록된 문제의 추천(§14.2 4)이 `no_match`이거나 장 번호·level로도 `ambiguous`이면 문제지(또는 `mixed`의 문제 구간) 자신의 장 — 시작 블록 장의 **최상위(level 1) 조상**을, 그 문서의 현재 revision의 같은 `section_key` 장으로 옮겨 추천한다(`reason = paper_chapter`). 가장 깊은 노드는 쓰지 않는다(워크북 outline의 `01 …?`·`정답: ②` 같은 가짜 level-2 heading). `no_source_chapter`(시작 블록에 장 없음)·`no_source`에는 폴백이 없다. 폴백 장은 Heatmap 장 목록에 교재 장처럼 나온다. 가져오기 초안의 추천은 교재 장만 쓴다(등록이 비교재 장을 거절하므로); 초안이 `챕터 없음`으로 등록되면 아래 재매칭이 폴백을 붙인다.
- **자동 재매칭(사용자 결정 2026-11-04: worker, 교재가 준비된 직후 한 번):** `document.parse`가 교재(`question_paper`가 아닌 문서)의 새 revision을 활성화한 뒤(publish 트랜잭션 밖, 실패해도 job은 성공) `quiz_worker.chapter_rematch`가 그 Workspace의 대상 문제를 같은 matcher(`book_core.chapter_matching`)로 다시 매칭한다. 대상은 CONFIRMED 살아 있는 문제 중 `chapter_source = auto`이고 챕터가 없거나 문제지 폴백 장인 것뿐이다 — **`manual`(사람이 정하거나 바꾼 챕터)은 절대 건드리지 않는다**. 쓰기는 SECURITY DEFINER `public.worker_rematch_chapters(workspace, moves jsonb)` 하나뿐이다(quiz_worker만 실행; 테이블 권한 추가 없음): 활성 Workspace 확인 → 문서 FOR SHARE(id 순) → 문제 FOR UPDATE(id 순) 뒤 항목마다 다시 확인(CONFIRMED·`auto`·`expected_chapter_id`와 같은 지금 장·옛 장은 없음 또는 비교재 장·새 장은 이 Workspace의 살아 있는 문서의 활성 revision 장이며 교재 장이거나 챕터 없는 문제에만 문제지 level-1 장). 하나라도 어긋난 항목은 건너뛰므로 멱등이고 재전달이 두 번 옮기지 않는다. 옮긴 문제는 `chapter_source = auto`·`chapter_set_by = null`·이력 `recommendation`(`changed_by` null)으로 쓴다. API 쪽 endpoint는 없다.
- **문제 편집 챕터 선택:** 교재 장 전부와 문제지의 level-1 장.


### 14.5 챕터 편집 (UX12 CHAPTER-3, 사용자 결정 D-9)

화면·계약은 [CHMAN-01](screens/chapter-management.md). 교재 챕터의 추가·이름 변경·이동·삭제는 draft 없이 활성 revision에 바로 적용한다.

- **불변 예외:** `revision_content_guard`는 `chapter_edit` SECURITY DEFINER 함수 안에서만 발행 revision을 풀어 준다: 장의 `title`·`parent_id`·`level`·`sort_order` 변경, `user-<uuid>` key 장 추가, 장 삭제, 블록의 `chapter_id` 변경뿐이다. 같은 경로가 `document_revisions.content_hash`를 다시 쓴다(해시는 장 구조를 포함하고 worker가 읽을 때 검사한다). `quiz_api`는 이 함수의 EXECUTE만 새로 받고 테이블 권한은 늘지 않는다.
- **잠금:** §14.3과 같이 Workspace FOR SHARE → 문서 → 문제 id 순. 쓰기는 문서를 FOR UPDATE로 잡고 `documents.chapter_tree_version`을 올린다. 교정 발행 job이 대기·실행 중이면 409 `publish-in-progress`다. 활성 revision이 바뀌어도 version이 올라가므로 낡은 화면의 일괄 이동은 409 `chapter-tree-changed`다.
- **교정 draft:** 편집은 같은 요청에서 교정 draft에 구조로 반영된다(key 기준으로 없는 장 추가, 상위·level·순서 맞춤, 활성에 없는 장 제거와 블록을 살아남은 상위로 이동). 그래서 발행의 `section_key` 재연결이 `user-*` 장의 문제를 null로 만들지 않는다. 이전 revision 복원(DOC-02)도 같은 동기화를 거친다.
- **삭제:** 문제는 §14.1의 `manual` 옮기기와 같다: `chapter_id`·`chapter_source = manual`·`chapter_set_by/at`이 바뀌고 `question_chapter_changes` 행(source `chapter_edit`)이 남으며 새 revision은 없다. 자동 재매칭(§14.4)은 `manual`을 건드리지 않는다. 이력 행의 `from_chapter_id`는 장이 지워지며 FK로 null이 된다. 활동은 `document.chapter_deleted`(id·개수만) 하나다. 범위 JSON(`mock_exams.range.chapter_ids`, `ask_conversations.scope`)의 지운 장 id는 없는 것으로 읽는다.

## 15. 하이라이트와 `내 하이라이트` (UX9-SPEC 2026-11-02)

화면·AC는 [HILITE-01](screens/highlights.md)·[CHNOTE-02](screens/chapter-note-tools.md). 사용자 피드백 "하이라이트 기능 추가: 텍스트 선택 시 dropdown menu 노출 … 문제 해설(AI 생성 문구 포함)을 하이라이트하면 정리 노트에 추가 · 하이라이트 목록 관리 · 정리 노트 하이라이트를 위한 툴을 공통으로 쓰면 될듯", 사용자 결정 2026-11-02 C3·C4·C5.

- **개인 기록:** 사용자마다 서버에 저장(`user_highlights`, architecture §5)되어 그 사용자의 기기 사이에 이어진다. 다른 구성원·공유 링크 게스트·Fork에는 없다(§"공유 Workspace에서의 문제 개인정보 규칙" — `question_user_states`와 같은 범위). 예외: Owner가 켠 링크의 게스트는 Owner의 것만 읽는다(workspace-sharing §12). 구성원 누구나(viewer 포함) 만들고, **보관된 Workspace에서도 만들기·색 바꾸기·지우기·되돌리기가 된다**(사용자 결정 2026-11-02 (i) — 개인 기록이라 보관 Workspace의 읽기 전용 규칙에서 하이라이트만 예외; 다른 쓰기는 그대로 403). 지우면 10초 동안 `되돌리기` 알림(사용자 결정 2026-11-02 (n), HILITE-01).
- **대상 세 가지:** (1) 정리 노트 **버전**(§9; 버전이 바뀌지 않으므로 위치가 고정, 다시 만든 새 버전에는 없음), (2) 문제 해설(`question_revisions.explanation` — 만든 revision과 인용 글을 기억), (3) AI 해설 버전(AIEXPL-01, `question_ai_explanations` — ASK-SPEC merge 뒤). 발문·보기·모의고사 문제·공유 화면에는 없다(사용자 결정 2026-11-02).
- **위치(anchor) 모델:** `{block, start, end}`(노트 = `body.sections[i].items[j]`의 렌더링 글, 해설 = 해설 글의 문단 i) + 서버가 저장된 글에서 자른 `quote`(≤ 2,000자)·`prefix`·`suffix`(앞뒤 32자). 글이 바뀌지 않으면(같은 노트 버전, 같은 revision) `exact`, 바뀌었으면 quote + prefix/suffix로 지금 글에서 다시 찾아 `relocated`, 못 찾으면 `missing`(해설에 표시하지 않고 `내 하이라이트`에 "해설이 바뀌어 위치를 찾을 수 없습니다"/"이전 AI 해설의 하이라이트"로 남김; 자동으로 지우지 않음).
- **장에 모으기:** 해설·AI 해설 하이라이트는 읽을 때 문제의 **지금** `chapter_id`로 장을 정한다 — 문제를 옮기면(§14) 따라간다. 장의 살아 있는 CONFIRMED 문제만(보관·삭제·초안 문제의 하이라이트는 숨김, 보관 해제하면 다시 보임; 문제 행이 지워지면 cascade). "챕터 없음" 문제는 "챕터 없음" 그룹의 `내 하이라이트` panel(사용자 결정 2026-11-02).
- **정답·해설 비노출:** practice API·범위 풀이 item 응답에는 하이라이트가 없다. 풀이 화면은 해설이 보인 뒤(제출 후)에만 하이라이트를 불러온다. `내 하이라이트`는 사용자가 고른 인용만 보이고 그 주변의 지금 해설 글은 보이지 않는다 — 사용자가 이미 본 글이다(AI 해설을 다시 만들어도 사용자가 보지 않은 새 글은 `내 하이라이트`에 나타나지 않는다). 하이라이트 읽기 권한은 정답·해설을 이미 모든 구성원에게 주는 `GET /questions/{id}`와 같다. 노트 panel 자체는 원래 정답·해설 내용을 보이는 곳이다(§9).
- **검색:** 노트 안 검색(CHNOTE-02)은 지금 버전 본문·각주 목록과 `내 하이라이트`의 해설 하이라이트 인용을 찾는다(노트 본문 하이라이트 행은 찾지 않음 — 같은 글을 두 번 세지 않음, 사용자 결정 2026-11-02).
- **기록:** 하이라이트는 Workspace 활동 기록(`activity_events`, 이력 dialog)을 남기지 않는다(사용자 결정 2026-11-02). 행의 `created_at`·`updated_at`·`deleted_at`이 자기 기록이다. 인용 글은 로그·trace·URL에 넣지 않는다.

## 16. 문제 원문 보기 (QSRC-SPEC 2026-11-04)

화면·AC는 [QSRC-01](screens/question-source-preview.md). 사용자 요청 "문제에 이미지가 포함된 경우 사용자가 볼 수 있어야 한다(범위가 작은 방식으로)", 사용자 결정 2026-11-04.

- **출처 규칙:** 원문 영역은 `question_sources` 중 `import_run_id`가 있는 행(문제 PDF 가져오기·발행이 초안의 `locations`를 복사한 것, Fork도 복사)의 `locations[].{page, bbox}`만 쓴다. `import_run_id`가 없는 행(직접 만든 문제의 쪽 출처, 책 `book` 근거, 생성·모의고사 `evidence`)은 정답이 든 쪽을 가리킬 수 있어 절대 쓰지 않는다. bbox 없는 위치는 건너뛰고 쓸 수 있는 위치가 하나도 없으면 영역이 없다(404, 버튼 숨김).
- **합집합:** 문서·쪽마다 위치들의 bbox 합집합 하나(PDF point, 쪽 왼쪽 위 원점 — 가져오기 초안의 `bbox`와 같은 좌표). 여백을 더하지 않는다. 쪽을 넘는 문제는 쪽마다 한 항목이다.
- **정답 비노출:** API는 문서 id·revision id·쪽·bbox만 돌려주고 글을 돌려주지 않는다. 풀이 session이 필요 없다(제출 전·후 같음). PDF 자체는 기존 `source-url` 중계(구성원 누구나)로 받고, 화면이 영역 밖을 그리지 않는 것이 보장이다 — "해설 포함" PDF는 영역 밖에 정답·해설이 있다. 새 권한을 열지 않는다.
- **삭제된 출처 PDF:** 출처 문서가 삭제(`documents.deleted_at`)되면 그 출처는 "없음"이다(문제는 남음). 문서의 원본 PDF는 불변이라 revision 검사는 없다.
- **모의고사 문제:** `보기 섞기`(`OPTION_SHUFFLE`) 문제만, 원본 문제(`source.question_id`)가 위 규칙으로 영역을 가지면 같은 영역을 돌려준다(`evidence`는 쓰지 않음). AI 변형 문제·원본이 없어졌거나 초안인 경우는 없다.
- **저장·migration 없음.** 풀이·열람 기록을 만들지 않는다(§4). 공유 링크 게스트에게는 이 기능이 없다.

## 17. `다시 풀기`는 정답을 맞춘 문제에만 (RETRY-CORRECT 2026-11-04)

사용자 요청 "다시풀기 버튼은 정답을 맞춘 문제에만 보이도록"과 사용자 결정 2026-11-04(implementation-plan §7). 화면 명세는 [RETRY-01](screens/retry-correct.md).

1. **판정.** 문제의 *마지막 채점 확정 결과가 정답*(Heatmap `정답` 상태와 같은 `last_graded_result = correct`)이면 `다시 풀기`를 켤 수 있다. 합쳐진 중복이 있으면 §10.2의 합친 상태로 판정한다. **가장 최근 제출이 채점 대기(pending)이면 아직 채점되지 않은 것이므로 자격이 없다**(사용자 결정 2026-11-04 D1): toggle은 그 제출이 채점될 때까지 숨겨지고, 정답으로 채점되면 다시 보이며, 오답으로 채점되면 숨겨진 채 4항의 trigger가 플래그를 끈다. 서버의 409 규칙도 "가장 최근 제출이 채점 대기"를 자격 없음으로 본다(Heatmap `is_pending_grading`과 같은 판정).
2. **UI.** 켤 수 없는 문제에는 `RetryToggle`을 렌더링하지 않는다(비활성이 아님). `practice` 풀이 panel은 정답 제출 직후 보이고 이후 오답이면 사라진다. `sequence(bank)`도 같다. `sequence(mock)`·`read-only`는 원래 없다. Heatmap marker 자체에는 `다시 풀기` 토글 조작이 없고(상태 표시만), 다른 곳에서 `RetryToggle`/my-state를 쓰는 경로도 이 규칙을 따른다.
3. **API.** `PATCH /questions/{id}/my-state`는 마지막 채점 결과(합친 상태)가 정답이 아닌 문제의 `needs_retry: true`를 409 `retry-requires-correct`로 거절한다(요청 전체 거절, 아무것도 쓰지 않음). `needs_retry: false`는 늘 허용하며 합쳐진 중복의 행도 함께 끈다(§10.2).
4. **자동 해제 — 규칙의 자리.** 앞으로의 새 채점 결과가 오답이면 `needs_retry`를 끈다. 이 규칙은 API 코드가 아니라 DB trigger(`question_user_states_retry_clear`, `last_graded_result`를 쓰는 insert/update, migration `20261104220000_retry_correct_only.sql`)에 있다. 자동 채점·직접 채점·이후의 모든 채점 경로가 `question_user_states.last_graded_result`를 쓰는 곳을 지나가므로 한 곳에서 보장되고, 합쳐진 중복 행도 같은 trigger가 끈다. 정답 채점은 플래그를 바꾸지 않는다.
5. **기존 데이터는 그대로 (사용자 결정 2026-11-04 변경).** 이미 켜져 있는 플래그는 migration이 끄지 않는다(데이터를 바꾸는 단계 없음). 마지막 채점 결과가 정답이 아닌 문제에 켜진 기존 플래그는 Heatmap `retry` 표시와 `다시 풀기` 필터에 그대로 나오지만, toggle은 보이지 않는다(1~2항) — 그 문제를 정답으로 맞힌 뒤에야 toggle로 끌 수 있다. 새 오답 채점이 오면 4항대로 꺼진다.
6. **이력 불변.** attempt와 `last_graded_result`는 바뀌지 않는다. 플래그만 꺼진다.
6a. **오래된 화면의 409 (D2).** 켜기가 409 `retry-requires-correct`로 거절되면 화면은 전용 문구 "정답을 맞힌 문제만 다시 풀기로 표시할 수 있습니다."를 알리고, 문제 상태를 다시 읽어 toggle을 숨긴다.
7. **알려진 가장자리.** 중복 정리(merge)·되돌리기로 합친 상태의 판정이 바뀌어 플래그가 정답이 아닌 문제에 남을 수 있다 — 그 문제는 toggle이 없고 Heatmap은 `retry`로 보이며, 다음 오답 채점 또는 끄기 PATCH가 정리한다(follow-up).

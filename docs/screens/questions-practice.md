# QPLAY-01 — 문제 풀이 Floating Side Panel

**상태:** 확정 화면 요구사항 v1.5 · UX7-BANK 개정 2026-11-01 (문제 관리: 편집·삭제) · UX7-BANK-2 개정 2026-11-01 (정답·해설 보기·수정 이력·출처·보관 복원) · UX7-QDISPLAY 개정 2026-11-01 (채점 결과 테두리·`보기` 글자·끝 빈 괄호) · UX9-SPEC 개정 2026-11-02 (`다시 풀기` toggle 물음표 아이콘, 해설 하이라이트, 정리 노트 접기 폐지에 따른 분리 규칙)
**Route:** `/workspaces/:workspaceId?question=:questionId` (Workspace 홈 위 panel; 이전 `/questions?question=`은 redirect — UX3c 2026-10-20)
**테스트:** `tests/e2e/questions/questions-practice.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- non-disclosing practice DTO 사용: 답안 제출 전 correct_option_ids와 해설 제공 금지. 정답 확정 시 서버 판정 및 attempt 기록.
- 객관식 보기는 각 줄 앞에 표시 순서대로 번호(`1.` `2.` …)를 보인다(UX5-UI 2026-10-23, 초안 검토와 같은 형식). 섞인 세션은 표시된 순서로 번호를 매긴다. 번호는 표시용(`aria-hidden`)이라 radio/checkbox 이름은 보기 문구이고 위치는 그룹이 읽어 주며, 채점은 번호·위치가 아니라 option ID로 한다(AC02).
- **보기 글자와 끝 빈 괄호 (UX7-QDISPLAY 2026-11-01, 사용자 요청 "문제의 빈 괄호 삭제 / '보기' 문구 삭제"):** 보기 목록 위에 `보기` 글자를 보이지 않는다. 단일 정답 radiogroup의 이름은 시각적으로 숨긴 `보기`로 남고(kit `RadioGroup` `hideLabel`), 복수 정답 checkbox 묶음(fieldset)은 보이는 안내 "정답을 모두 고르세요"와 숨긴 `보기`가 이름이다. 문제 상세 dialog·공유 보기의 보기 목록에도 `보기` 제목이 없고(목록 이름 `보기`, 복수 정답이면 "복수 정답" 글자), 문서 편집기 문제 카드(DOC-02)는 원래 목록 이름만 있다. 문제 내용 끝의 빈 답 괄호(`( )`, `（ ）` 등)는 표시하지 않는다 — 규칙과 적용 범위는 [questions.md §4](../questions.md) 10번(표시 전용: 저장값·편집기 입력값·API 값은 그대로)(AC13).
- **객관식 채점 결과 (UX7-QDISPLAY 2026-11-01, 사용자 요청 "정답이면 정답을 초록 테두리로 감싸기 / 오답이면 선택한 보기는 회색 테두리, 정답인 보기는 빨간 테두리로 감싸기"):** 제출 결과가 오면 보기 행에 테두리를 그린다. 정답이면 고른 보기가 초록(`--color-success`) 테두리, 오답이면 고른 보기가 회색(`--color-border-strong`) 테두리이고 정답 보기가 빨간(`--color-danger`) 테두리다(사용자가 정답 보기를 빨간색으로 지정함 — 바꾸지 않는다). 복수 정답 오답에서 고른 정답 보기는 정답 보기이므로 빨간 테두리다. 색만으로 전달하지 않는다: 테두리가 있는 행마다 "정답"·"내 선택"·"정답 · 내 선택" 글자가 보이고 그 radio/checkbox의 설명(`aria-describedby`)으로 읽힌다. 테두리 두께는 제출 전후 같고(제출 전 투명) 색만 바뀌어 레이아웃이 움직이지 않는다. forced-colors 규칙은 [design-system.md §4.1](../design-system.md) "채점 결과 테두리". 단답형·서술형 결과(직접 채점 포함)는 테두리가 없다(보기가 없음). 이 규칙은 객관식 채점 결과를 보이는 모든 화면에 쓴다 — 지금은 풀이 panel 하나이고(공유 보기는 채점하지 않음, 모의고사는 미구현) 다른 화면이 생기면 같은 표시를 쓴다(AC12).
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.
- **열어 본 문제 client cache (UX7-CACHE 2026-11-01):** 패널은 이번 화면에서 연 practice session(정답·해설이 없는 `PracticeSession` 필드만)을 메모리에 보관한다. 아직 제출하지 않은 문제를 닫았다 다시 열거나 이전/다음으로 돌아오면 같은 session을 요청 없이 바로 보인다(같은 보기 순서, 같은 session으로 제출 — 열람 기록은 처음 열 때 이미 남았다). 보관 범위는 화면 인스턴스 하나와 Workspace 하나(다른 Workspace·로그아웃·다른 화면으로 이동하면 버려짐)이고 브라우저 저장소에는 쓰지 않는다. 제출을 시작한 session, 실패한 session(`이미 제출` 등), 10분이 지난 session은 다시 쓰지 않는다(다른 곳의 문제 수정은 최대 10분 늦게 보일 수 있으나 채점은 항상 session이 고정한 revision 기준이라 보이는 내용과 채점이 어긋나지 않는다). 제출 결과(정답·해설)는 보관하지 않으며 제출한 문제를 다시 열면 새 session을 연다. 이웃 문제 prefetch는 하지 않는다 — session 열기가 열람 기록이므로 실제로 열지 않은 문제를 viewed로 만들 수 없다(AC06).
- **정리 노트와 분리 (DOCSUM-SPEC 2026-10-29):** 풀이 panel은 챕터 정리 노트(CHNOTE-01)의 내용·링크를 보이지 않고 practice API도 노트 필드를 보내지 않는다(제출 전후 모두). UX9-SPEC(2026-11-02)부터 노트 본문은 접히지 않는다: 노트 panel은 modal이라 열린 동안 Heatmap marker로 이 panel을 열 수 없고(사용자 결정 2026-11-02 "정리 노트도 모달로 변경" — 처음의 C9를 대체, CHNOTE-02-AC04), 각주로 열면 이 panel이 노트 위에 쌓이고 열린 동안 노트 내용이 가려진다(CHNOTE-02-AC05). 그 전에는 이 panel이 열리면 펼쳐져 있던 노트 본문이 다시 접혔다(CHNOTE-01-AC05). 이 화면의 기존 AC는 바뀌지 않는다.
- **`다시 풀기` toggle 아이콘 (UX9-SPEC 2026-11-02, 사용자 피드백 "문제별 '다시 풀기' 버튼을 물음표 모양 아이콘으로 변경", 사용자 결정 C10):** header의 `다시 풀기` toggle(`RetryToggle`)은 원 안의 물음표 아이콘(`RetryIcon`, design-system §7 아이콘 목록)이다 — 꺼짐은 윤곽선, 켜짐은 채운 원 + 흰 물음표와 `--color-state-selected` 배경(모양으로도 구분, 색만이 아님). 바뀌는 것은 아이콘뿐이다: 접근성 이름은 지금처럼 상태에 따라 "다시 풀기 표시"/"다시 풀기 해제"로 바뀌고(이름에 "다시 풀기"가 들어감) `data-state="on|off"`이며(`aria-pressed`는 이름이 바뀌므로 두지 않는 기존 결정 유지 — `StudyToggles.tsx`), tooltip은 같은 이름이다(hover·키보드 focus, touch에는 tooltip 없이 이름만). 즐겨찾기 star toggle은 그대로다. 이 toggle이 있는 모든 곳 — 이 panel(QuestionViewer `practice`)과 범위 풀이 `sequence(bank)` header(QVIEW-01) — 이 같은 컴포넌트를 쓴다. Heatmap marker 색(retry=yellow)·상태 필터 `다시 풀기만` 칩·preview 글자 "다시 풀기 표시됨"은 바뀌지 않는다. 검증: QVIEW-01-C08(Vitest), VISUAL-10(toggle 꺼짐·켜짐 baseline).
- **즐겨찾기·다시 풀기 toggle 즉시 반영 (UX9-RETRY-OPT 2026-11-02, 사용자 요청 "문제 다시 보기 버튼의 성능 개선: API 응답 전 버튼의 선택 상태는 미리 변경, 즐겨찾기 버튼 토글 시 다시 보기 버튼이 깜빡이는 현상 수정"):** 두 toggle은 누르는 즉시(my-state 응답 전) 이름·`data-state`·아이콘이 바뀌고 Heatmap marker(색·모양·접근성 이름)도 같은 상태를 보인다. 저장 중에도 toggle은 비활성(`aria-disabled`)이 되지 않는다. 한 문제의 my-state 요청은 한 번에 하나만 보내고, 응답을 기다리는 동안 누른 것은 모아 다음 요청 하나로 보내므로 마지막으로 누른 상태가 남는다(늦게 온 응답이 더 새로운 누름을 덮지 않음). 요청이 실패하면 그 요청이 바꾸려던 항목만 서버 상태로 되돌리고 오류를 toast(polite 알림, 기존 오류 알림과 같음)로 알린다 — 다른 toggle은 그대로다. 한 toggle을 눌러도 다른 toggle의 이름·상태·속성은 바뀌지 않는다(이전에는 저장 중 두 toggle이 서버가 처음 그린 상태로 돌아가 `다시 풀기`가 깜빡였음). 범위 풀이 `sequence(bank)` header의 같은 toggle도 같다(QVIEW-01). 사용자가 누르지 않은 항목은 서버 응답을 따른다(다른 탭에서 바꾼 상태를 되돌리지 않음). 저장 중인 요청이 있는 동안 페이지를 떠나거나 새로 고치면 브라우저 기본 `beforeunload` 확인을 띄우고, 저장 중이 아니면 띄우지 않는다(사용자 결정 2026-11-02). 검증: QOV-01-AC05 E2E(응답을 붙잡아 둔 채 확인), Vitest(`flag-sync.test.ts`, `use-flag-sync.test.tsx`, `questions-overview.test.tsx`, `question-viewer.test.tsx`).
- **해설 하이라이트 (UX9-SPEC 2026-11-02, 사용자 결정 C3·C4):** 제출 뒤 보이는 해설(과 AIEXPL-01이 merge되면 AI 해설)은 공통 `HighlightableText`이고 글자를 고르면 `HighlightMenu`(3색·`하이라이트 지우기`·`복사`)가 뜬다. 만든 하이라이트는 그 문제의 장 정리 노트의 `내 하이라이트`에 모인다. 제출 전에는 해설이 없으므로 하이라이트도 요청·표시하지 않고 practice API에는 하이라이트 필드가 없다. 동작·AC는 [HILITE-01](highlights.md).
- **정리 노트와 분리 (DOCSUM-SPEC 2026-10-29):** 풀이 panel은 챕터 정리 노트(CHNOTE-01)의 내용·링크를 보이지 않고 practice API도 노트 필드를 보내지 않는다(제출 전후 모두). 풀이 panel이 열리면 펼쳐져 있던 정리 노트 본문은 다시 접힌다(CHNOTE-01-AC05). 이 화면의 기존 AC는 바뀌지 않는다.
- **AI 질문·AI 해설·관련 본문 (ASK-SPEC 2026-11-01 사용자 결정, ASK-SYNC 2026-11-02 — 이 panel은 QuestionViewer `practice`, 문제 상세는 `manage`):** 이 panel header와 `문제 관리`/`문제 정보` 메뉴에는 `질문하기`가 없다(사용자 결정 2026-11-01). "문제 상세" dialog footer에 `질문하기`(ASK-01 — 이 문제를 `full`로 첨부한 AI 질문 panel을 dialog 위에 연다). 제출 후 결과 아래에 `AI 해설`(AIEXPL-01)과 "관련 본문"(RELSRC-01) — 서버가 그 session의 제출을 확인한다. 문제 상세 dialog에도 둘 다(사용자 결정 2026-11-01). practice API 응답은 바뀌지 않는다(정답·해설·AI 해설·관련 본문 필드 없음). 이 화면의 기존 AC는 바뀌지 않는다.
- **문제 관리 (UX7-BANK 2026-11-01):** 전체 문제 페이지(QBANK-01)를 없애면서 그 페이지의 문제 편집·삭제를 이 panel로 옮겼다(사용자 결정 "문제 편집/삭제만 홈으로 옮기면 될듯", 폐기 기록 [questions-bank.md](questions-bank.md)). 편집 권한(Owner·Editor)이고 Workspace가 보관되지 않았으면 header의 즐겨찾기·다시 풀기 toggle 옆에 `문제 관리` 메뉴 버튼(아이콘, Radix DropdownMenu)이 있고 항목은 `편집`·`변형 출제`·`삭제`다(UX7-BANK-2부터 읽기 항목과 `보관`이 더해짐, 아래). 보기 권한과 보관된 Workspace에는 `문제 관리` 메뉴가 없다(서버도 거절; UX7-BANK-2부터 그 자리에 읽기 전용 `문제 정보` 메뉴).
  - `편집`: 그 문제의 정답·해설을 포함한 편집용 내용을 그때 불러와(풀이 세션 응답에는 여전히 정답이 없다 — AC01) 기존 "문제 편집" modal dialog를 panel 위에 연다. 저장하면 새 question_revision을 만들고(보기 ID 유지), 이전 풀이 기록은 원래 revision을 가리킨다. 저장 뒤 panel은 새 내용으로 풀이 세션을 다시 연다. 다른 사람이 먼저 고쳤으면(stale revision) 편집기의 "최신 내용 불러오기"를 쓴다(기존 편집기 동작).
  - ~~`변형 출제`: 그 문제의 변형 출제 검토 페이지(`/questions/generate?source=<id>`)로 이동한다~~ → **폐지** (QGEN-RM 2026-11-02, MOCK-SPEC 사용자 결정 1, [MOCK-01](mock-exams.md); [폐지 기록](questions-generation.md)). 이전 URL은 홈의 모의고사 dialog로 redirect한다.
  - `삭제`: 확인 dialog("문제를 삭제할까요?" — Heatmap에서 사라지고 지난 풀이 기록은 이력으로 남는다)에서 `삭제`를 누르면 문제를 삭제하고 panel을 닫으며 그 점이 Heatmap에서 사라진다.
  - ~~보관(`보관`·`보관 해제`)은 옮기지 않았다~~ → UX7-BANK-2에서 `보관`을 되살렸다(아래). 보관 해제는 홈 `문제` 메뉴의 "보관·초안 문제" dialog(QOV-01-AC15).
- **정답·해설·이력 보기와 보관 (UX7-BANK-2 2026-11-01):** 사용자 결정 "Viewers도 answer를 볼 수 있어야 함 / archiving은 개별 문제에서 할 수 있도록 / version history, source links, status filters는 왜?? 화면 삭제와는 상관 없는것 같은데" — 전체 문제 페이지와 함께 없앤 상세 panel의 읽기 기능과 보관을 이 panel에 되살린다.
  - **메뉴 (보기 권한·보관 Workspace의 `문제 정보` 메뉴는 사용자 결정 2026-11-01, UX7 확인 7):** 편집 권한이고 보관되지 않은 Workspace에는 `문제 관리` 메뉴가 `정답·해설 보기` · `수정 이력·출처` | `편집` · `보관` | `삭제` 순서다(| = 구분선; QGEN-RM 전에는 `편집`과 `보관` 사이에 `변형 출제`가 있었다). 보기 권한과 보관된 Workspace(모든 역할)에는 같은 자리에 `문제 정보` 메뉴 버튼(아이콘, 같은 DropdownMenu)이 있고 읽기 항목 `정답·해설 보기` · `수정 이력·출처`만 있다. 보관된 Workspace에서는 즐겨찾기·다시 풀기 toggle이 없어도 이 메뉴는 보인다. 쓰기 항목은 보기 권한·보관 Workspace에 비활성으로도 보이지 않는다(서버도 거절, AC08).
  - **문제 상세 dialog (읽기 전용):** 두 읽기 항목은 같은 modal dialog "문제 상세"(설명: panel 제목 · 유형 · 챕터)를 panel 위에 연다. 내용은 전체 문제 상세 panel과 같다: 유형·상태·버전, 문제 내용, 보기(정답 보기는 테두리 + 체크 아이콘 + "정답" 글자 — 색만으로 전달하지 않음; 복수 정답 표시)·허용 답안·채점 기준·해설, `출처`(출처 문서 이름과 쪽, 문서가 있으면 PDF 열람(DOC-02 `?page=`) 링크; 없으면 "연결된 출처가 없습니다."), `수정 이력`(버전마다 `버전 n (현재) · 날짜` toggle 버튼, `aria-pressed`; 지난 버전을 고르면 그 버전의 내용(문제·보기·정답·해설)을 그 아래 미리보기로 보인다). `수정 이력·출처`로 열면 `수정 이력` 제목에 focus가 간다. 닫으면(닫기·Escape) focus는 메뉴 버튼으로 돌아간다.
  - **불러오기:** 정답이 든 문제(`GET /questions/{id}`, 지난 버전은 `GET /questions/{id}/revisions/{revision_id}` — 전체 문제 페이지가 쓰던 읽기 API, 모든 구성원·보관 Workspace 허용)는 항목을 고를 때만 불러온다. 풀이 session 응답에는 여전히 정답·해설이 없다(AC01). 불러오는 동안 "문제를 불러오는 중입니다." 상태, 실패하면 role=alert 문구와 `다시 시도`.
  - **풀이와의 관계 (사용자 결정 2026-11-01, UX7 확인 7):** 정답 보기는 풀이(attempt)가 아니다: 풀이 기록·채점 결과·Heatmap 상태(열람 기록은 panel을 열 때 이미 남았다)를 바꾸지 않는다. 아직 제출하지 않은 풀이 중에 열어도 그 풀이는 그대로다 — dialog를 닫으면 고르던 답안과 같은 session이 남아 있고 그대로 제출할 수 있으며 보통 제출처럼 채점·기록된다(정답을 봤는지는 기록하지 않는다).
  - **보관:** `보관`은 확인 dialog("문제를 보관할까요?" — Heatmap에서 빠지고 `문제` › `보관·초안 문제`에서 보관 해제할 수 있으며 지난 풀이 기록은 남는다)를 거쳐 문제를 보관(ARCHIVED, 그 순간의 현재 revision 기준)하고 panel을 닫는다. 그 점은 Heatmap에서 사라지고(새로 고침해도), 뒤로가기로 panel이 다시 열리지 않는다. 확정 문제만 보관할 수 있다(서버 규칙: 확정↔보관, 초안→확정).
- **통합 `QuestionViewer` (MOCK-SPEC 2026-11-01):** 이 panel은 공통 `QuestionViewer`의 `practice` 방식(modal `FloatingSidePanel`, 한 문제, 이전·다음 = Heatmap 순서)이 된다(Task QVIEW-W). 범위를 골라 하나씩 푸는 `sequence` 방식과 호출 위치 목록은 [QVIEW-01](question-viewer.md). 이 화면의 기존 AC는 바뀌지 않고 QuestionViewer를 대상으로 그대로 검증한다. header의 `문제 관리`/`문제 정보` 메뉴, 그 위의 "문제 상세" dialog(QuestionViewer `manage`), session cache(AC06), 채점 결과 테두리(AC12), `보기` 글자·끝 빈 괄호 표시(AC13)는 QVIEW-01 호출 위치 표 1·1a·4와 "모든 방식이 지켜야 하는 UX7 동작"에 그대로 옮겨 적었다(MOCK-SYNC 2026-11-02). QGEN-RM(2026-11-02)이 `문제 관리`의 `변형 출제`를 지웠다(→ `정답·해설 보기`·`수정 이력·출처` | `편집`·`보관` | `삭제`); AC09의 "`변형 출제`가 없다"는 그 뒤에도 참이다.

## 수용 기준

### QPLAY-01-AC01

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 미열람 문제를 열면 viewed를 기록하지만 정답 제출 전 응답에 정답과 해설을 포함하지 않는다.

### QPLAY-01-AC02

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 객관식 선택지가 섞여도 표시 순서가 아니라 원본 option ID를 기준으로 채점한다.

### QPLAY-01-AC03

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** Retry 플래그가 켜진 문제는 정답을 맞혀도 Overview 마커가 노란색이며 최근 정답 기록은 유지한다.

### QPLAY-01-AC04

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 서술형 채점 결과가 불확실하면 PENDING으로 유지하고 임의로 정답/오답 처리하지 않는다.

### QPLAY-01-AC05

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** Esc/닫기로 패널을 닫으면 URL query를 갱신하고 열기 버튼으로 포커스가 복귀한다.

### QPLAY-01-AC06

- **Given:** 이번 화면에서 열어 보고 아직 제출하지 않은 문제가 있는 상태
- **When:** 패널을 닫았다 그 문제를 다시 열거나 이전/다음으로 그 문제로 돌아온다
- **Then:** 새 문제 내용 요청(server action·API) 없이 같은 session(같은 보기 순서)을 바로 보이고, 그 session으로 제출하면 한 번만 채점된다. 제출한 문제를 다시 열면 새 session을 연다.

### QPLAY-01-AC07

- **Given:** 풀이 기록(attempt)이 revision 1에 있는 확정 객관식 문제가 있는 Workspace 홈(편집 권한)
- **When:** Heatmap 점으로 풀이 panel을 열고 `문제 관리` › `편집`에서 문제 내용과 보기 하나의 문구를 바꿔 저장
- **Then:** "문제 편집" dialog가 현재 내용으로 열리고, 저장하면 닫히며 panel이 바뀐 문제 내용을 보인다. 서버에는 새 question_revision(version 2)이 생기고 보기 ID와 정답 ID는 그대로이며 바뀐 보기만 문구가 바뀐다. 이전 풀이 기록은 revision 1(원래 문제 내용)을 그대로 가리킨다. panel을 열기만 해서는 정답·해설이 응답에 실리지 않는다(AC01). (QBANK-01-AC03에서 옮김, UX7-BANK)

### QPLAY-01-AC08

- **Given:** 확정 문제가 있는 Workspace 홈: Owner, 보기 권한 멤버, 보관된 Workspace의 Owner, 그리고 다른 Workspace의 사용자
- **When:** Owner가 풀이 panel의 `문제 관리` › `삭제`를 확인하고, 보기 권한·보관된 Workspace에서 panel을 열고, 다른 사용자가 그 question ID로 읽기·수정·삭제 API를 직접 호출
- **Then:** Owner의 삭제는 확인 dialog를 거쳐 문제를 지우고 panel을 닫으며 그 점이 Heatmap에서 사라진다(새로 고침해도). 보기 권한과 보관된 Workspace의 panel에는 `문제 관리` 메뉴(편집·삭제)가 없고, 서버는 그들의 수정·삭제를 거절한다(viewer 403 `insufficient-role`, 보관 403 `workspace-archived`). 다른 사용자의 읽기·수정·삭제와 목록 요청은 알 수 없는 ID와 같은 404 응답을 받고 내용이 새지 않으며, 그 사용자가 홈 URL로 와도 404다. (QBANK-01-AC04에서 옮김, UX7-BANK)

### QPLAY-01-AC09

- **Given:** 해설이 있는 확정 객관식 문제가 있는 Workspace 홈: Owner, 보기 권한 멤버, 보관된 Workspace의 Owner
- **When:** 각자 풀이 panel을 열고(Owner·보기 권한은 보기 하나를 고른 채 제출하지 않음) header 메뉴(편집 권한 `문제 관리`, 그 밖 `문제 정보`) › `정답·해설 보기`를 고른 뒤 dialog를 닫음
- **Then:** 모두 "문제 상세" dialog에서 문제 내용, 정답 보기("정답" 글자와 아이콘), 해설을 본다. panel을 여는 동안 받은 응답에는 정답·해설이 없고(AC01), 정답이 든 문제는 항목을 고른 뒤에만 불러온다. 보기 권한·보관 Workspace의 메뉴에는 `정답·해설 보기`·`수정 이력·출처`만 있고 `편집`·`변형 출제`·`보관`·`삭제`가 없다. dialog를 닫으면 panel의 고른 답안이 그대로 남아 같은 session으로 제출할 수 있다. 정답을 본 것만으로는 풀이 기록(attempt)이 생기지 않는다. (UX7-BANK-2; QBANK-01 상세 panel의 정답·해설)

### QPLAY-01-AC10

- **Given:** 두 번 수정되어 버전 3까지 있고 책 문서의 쪽을 출처로 가진 확정 문제가 있는 Workspace 홈(보기 권한 멤버)
- **When:** 풀이 panel의 `문제 정보` › `수정 이력·출처`를 고르고, 버전 1을 고른 뒤 출처 링크를 누름
- **Then:** "문제 상세" dialog가 열리고 `수정 이력` 제목에 focus가 있다. 수정 이력은 버전 3(현재)·2·1을 최신순으로 보이고 현재 버전이 눌린 상태(`aria-pressed="true"`)다. 버전 1을 누르면 그 버튼이 눌린 상태가 되고 버전 1의 문제 내용이 미리보기로 보인다. 출처는 문서 이름과 쪽을 보이고, 링크는 그 문서의 PDF 열람 페이지 그 쪽(`/documents/<id>?page=<n>`)을 연다. (UX7-BANK-2; QBANK-01 상세 panel의 수정 이력·출처)

### QPLAY-01-AC11

- **Given:** 확정 문제 둘이 있는 Workspace 홈: Owner, 보기 권한 멤버, 보관된 Workspace의 Owner
- **When:** Owner가 풀이 panel의 `문제 관리` › `보관`을 취소했다가 다시 골라 확인하고, 보기 권한 멤버와 보관된 Workspace에서 panel 메뉴를 열고 보관 API를 직접 호출
- **Then:** 취소하면 아무것도 바뀌지 않는다. 확인하면 문제가 보관(ARCHIVED)되고 panel이 닫히며 그 점이 Heatmap에서 사라지고(새로 고침해도), 뒤로가기로 panel이 다시 열리지 않으며, 그 문제는 `문제` › `보관·초안 문제`의 `보관됨`에 있다(QOV-01-AC15). 보기 권한과 보관된 Workspace의 메뉴에는 `보관`이 없고 서버는 그들의 보관을 거절한다(viewer 403 `insufficient-role`, 보관 403 `workspace-archived`). (UX7-BANK-2; QBANK-01 상세 panel의 `보관`)

### QPLAY-01-AC12

- **Given:** 해설이 있는 확정 단일 정답 객관식 문제와 복수 정답 객관식 문제가 있는 Workspace 홈(Owner)
- **When:** 단일 정답 문제를 풀이 panel에서 정답 보기로 제출하고, 새로 열어 오답 보기로 제출하고, 복수 정답 문제를 정답 하나와 오답 하나를 골라 제출
- **Then:** 제출 전 보기 행에는 보이는 테두리가 없다(투명). 정답 제출 뒤 고른 보기 행은 `--color-success` 테두리와 "정답 · 내 선택" 글자를 갖고 다른 행은 테두리·글자가 없다. 오답 제출 뒤 고른 보기 행은 `--color-border-strong`(회색) 테두리와 "내 선택", 정답 보기 행은 `--color-danger`(빨강) 테두리와 "정답"을 갖고 나머지 행은 표시가 없다. 복수 정답 오답에서는 고른 정답 보기도 빨간 테두리와 "정답 · 내 선택"이다. 글자는 각 radio/checkbox의 접근 가능한 설명이다. 테두리 두께는 제출 전후 같아 보기 행의 가로 위치·폭과 첫 행의 위치가 바뀌지 않는다(표시 글자 줄은 그 행 아래에 더해진다). (UX7-QDISPLAY)

### QPLAY-01-AC13

- **Given:** 문제 내용이 "… 옳은 것은? ( )"처럼 끝에 빈 답 괄호가 있고 문장 중간에 빈칸 괄호 "( )"가 있는 확정 객관식 문제가 있는 Workspace 홈(Owner)
- **When:** Heatmap 점에 focus해 preview를 보고, 풀이 panel을 열고, `문제 관리` › `정답·해설 보기`로 문제 상세 dialog를 열고, `편집`으로 문제 편집 dialog를 엶
- **Then:** preview·풀이 panel·문제 상세 dialog의 문제 내용은 끝의 빈 괄호 없이 "… 옳은 것은?"으로 끝나고 문장 중간의 빈칸 괄호는 그대로 보인다. 풀이 panel과 문제 상세 dialog의 보기 목록 위에 `보기` 글자가 보이지 않지만 radiogroup(목록)의 접근 가능한 이름은 `보기`다. 문제 편집 dialog의 `문제 내용` 입력값과 API의 문제 내용은 저장된 그대로(끝의 빈 괄호 포함)다. (UX7-QDISPLAY)

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.

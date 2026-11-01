# QPLAY-01 — 문제 풀이 Floating Side Panel

**상태:** 확정 화면 요구사항 v1.4 · UX7-BANK 개정 2026-11-01 (문제 관리: 편집·삭제)
**Route:** `/workspaces/:workspaceId?question=:questionId` (Workspace 홈 위 panel; 이전 `/questions?question=`은 redirect — UX3c 2026-10-20)
**테스트:** `tests/e2e/questions/questions-practice.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- non-disclosing practice DTO 사용: 답안 제출 전 correct_option_ids와 해설 제공 금지. 정답 확정 시 서버 판정 및 attempt 기록.
- 객관식 보기는 각 줄 앞에 표시 순서대로 번호(`1.` `2.` …)를 보인다(UX5-UI 2026-10-23, 초안 검토와 같은 형식). 섞인 세션은 표시된 순서로 번호를 매긴다. 번호는 표시용(`aria-hidden`)이라 radio/checkbox 이름은 보기 문구이고 위치는 그룹이 읽어 주며, 채점은 번호·위치가 아니라 option ID로 한다(AC02).
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.
- **열어 본 문제 client cache (UX7-CACHE 2026-11-01):** 패널은 이번 화면에서 연 practice session(정답·해설이 없는 `PracticeSession` 필드만)을 메모리에 보관한다. 아직 제출하지 않은 문제를 닫았다 다시 열거나 이전/다음으로 돌아오면 같은 session을 요청 없이 바로 보인다(같은 보기 순서, 같은 session으로 제출 — 열람 기록은 처음 열 때 이미 남았다). 보관 범위는 화면 인스턴스 하나와 Workspace 하나(다른 Workspace·로그아웃·다른 화면으로 이동하면 버려짐)이고 브라우저 저장소에는 쓰지 않는다. 제출을 시작한 session, 실패한 session(`이미 제출` 등), 10분이 지난 session은 다시 쓰지 않는다(다른 곳의 문제 수정은 최대 10분 늦게 보일 수 있으나 채점은 항상 session이 고정한 revision 기준이라 보이는 내용과 채점이 어긋나지 않는다). 제출 결과(정답·해설)는 보관하지 않으며 제출한 문제를 다시 열면 새 session을 연다. 이웃 문제 prefetch는 하지 않는다 — session 열기가 열람 기록이므로 실제로 열지 않은 문제를 viewed로 만들 수 없다(AC06).
- **정리 노트와 분리 (DOCSUM-SPEC 2026-10-29):** 풀이 panel은 챕터 정리 노트(CHNOTE-01)의 내용·링크를 보이지 않고 practice API도 노트 필드를 보내지 않는다(제출 전후 모두). 풀이 panel이 열리면 펼쳐져 있던 정리 노트 본문은 다시 접힌다(CHNOTE-01-AC05). 이 화면의 기존 AC는 바뀌지 않는다.
- **문제 관리 (UX7-BANK 2026-11-01):** 전체 문제 페이지(QBANK-01)를 없애면서 그 페이지의 문제 편집·삭제를 이 panel로 옮겼다(사용자 결정 "문제 편집/삭제만 홈으로 옮기면 될듯", 폐기 기록 [questions-bank.md](questions-bank.md)). 편집 권한(Owner·Editor)이고 Workspace가 보관되지 않았으면 header의 즐겨찾기·다시 풀기 toggle 옆에 `문제 관리` 메뉴 버튼(아이콘, Radix DropdownMenu)이 있고 항목은 `편집`·`변형 출제`·`삭제`다. 보기 권한과 보관된 Workspace에는 메뉴가 없다(서버도 거절).
  - `편집`: 그 문제의 정답·해설을 포함한 편집용 내용을 그때 불러와(풀이 세션 응답에는 여전히 정답이 없다 — AC01) 기존 "문제 편집" modal dialog를 panel 위에 연다. 저장하면 새 question_revision을 만들고(보기 ID 유지), 이전 풀이 기록은 원래 revision을 가리킨다. 저장 뒤 panel은 새 내용으로 풀이 세션을 다시 연다. 다른 사람이 먼저 고쳤으면(stale revision) 편집기의 "최신 내용 불러오기"를 쓴다(기존 편집기 동작).
  - `변형 출제`: 그 문제의 변형 출제 검토 페이지(`/questions/generate?source=<id>`)로 이동한다(이전 전체 문제 상세의 `변형 출제`).
  - `삭제`: 확인 dialog("문제를 삭제할까요?" — Heatmap에서 사라지고 지난 풀이 기록은 이력으로 남는다)에서 `삭제`를 누르면 문제를 삭제하고 panel을 닫으며 그 점이 Heatmap에서 사라진다.
  - 보관(`보관`·`보관 해제`)은 옮기지 않았다: Heatmap은 확정 문제만 보이므로 홈에서 보관하면 되돌릴 곳이 없다.

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

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.

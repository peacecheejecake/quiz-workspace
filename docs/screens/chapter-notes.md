# CHNOTE-01 — 챕터 정리 노트 Floating Side Panel

**상태:** 확정 화면 요구사항 v1.0 · DOCSUM-SPEC 신규 2026-10-29 (사용자 요청 "문제 및 해설로부터 챕터별 내용 정리 생성 — 추가한 내용은 문제 출처를 주석에 명시", 사용자 결정 Q4·Q6·Q7·Q10)
**Route:** `/workspaces/:workspaceId?panel=chapter-note&chapter=:chapterId` (Workspace 홈 Heatmap의 챕터 그룹 header `정리 노트` 버튼이 여는 non-modal panel) · 공유 게스트는 `/share/:shareId?panel=chapter-note&chapter=:chapterId`
**테스트:** `tests/e2e/questions/chapter-notes.spec.ts` (계약: `tests/integration/questions/chapter_notes/test_chapter_notes_contract.py`, `apps/worker` · `packages/core` unit test)
**Phase:** CHNOTE.0 (RED) → CHNOTE-B → CHNOTE-W
**연계:** [Questions 명세](../questions.md) §9, [QOV-01](questions-overview.md), [QPLAY-01](questions-practice.md), [WS-VIEW-01](workspace-shared-view.md), [공유 명세](../workspace-sharing.md) §8, [디자인 시스템](../design-system.md) §5, [E2E 규칙](../e2e-strategy.md)

```yaml
id: CHNOTE-01
route: /workspaces/:workspaceId?panel=chapter-note&chapter=:chapterId
actor: workspace_member (보기) · editor/owner (만들기·다시 만들기) · share guest (최신 노트 보기)
permission: read · edit
status: confirmed
api: [GET /api/v1/workspaces/:id/chapter-notes, GET /api/v1/chapters/:chapterId/note, POST /api/v1/chapters/:chapterId/note, GET /api/v1/shared/:shareId/chapter-notes, GET /api/v1/shared/:shareId/chapters/:chapterId/note]
components: [FloatingSidePanel, Button, Disclosure, Select, Badge]
linked_tests: [CHNOTE-01-AC01 … CHNOTE-01-AC06]
```

## 목적과 정책

- Heatmap의 챕터 그룹 하나(같은 `chapter_id`의 문제 묶음)마다, 그 장에 **확정된(CONFIRMED) 문제와 해설만**으로 장의 내용을 정리한 노트를 만든다(사용자 결정 Q4). 초안·보관·삭제된 문제, 다른 장의 문제는 입력이 아니다. 장 본문(발행 revision 블록)은 용어·문장 확인을 위한 참고 입력일 뿐이고, 노트의 모든 항목은 문제에서 나온 내용이어야 한다.
- **문제 출처 각주 (필수):** 노트의 모든 항목은 근거가 된 문제를 1개 이상 각주로 단다. 항목 끝의 각주 번호(`[1]`)는 노트 아래 각주 목록 `[^1] 3장 12번 — <문제 발문 앞 40자>`로 이어지고, 각주는 그 문제를 연다. 입력에 없는 문제를 가리키는 각주, 각주가 없는 항목, 본문에 없는 인용은 저장·표시하지 않는다(서버 검증; 지어낸 출처는 절대 보이지 않음). "3장 12번"의 번호는 Heatmap 미리보기와 같은 문제 번호다.
- **생성 시점:** 편집 권한자가 장마다 필요할 때 만든다(Q5 기본값; 자동 생성 없음). 다시 만들면 새 버전이 생기고 이전 버전은 지우지 않는다(`버전` 선택으로 열람).
- **최신 여부(stale):** 노트를 만든 뒤 그 장의 확정 문제가 추가·수정(새 revision)·삭제·보관되거나 다른 장으로 옮겨지면 노트에 글자 badge "문제가 바뀌어 최신이 아닙니다"를 단다(읽을 때 계산; 노트 내용은 그대로). 더 이상 그 장의 확정 문제가 아닌 문제를 가리키는 각주는 "삭제되었거나 옮긴 문제"로 보이고 링크가 없다.
- **공유 게스트·Fork는 출처가 일치하는 노트만 (Codex P1 2026-10-29):** 노트 본문은 각주 문제의 정답·해설에서 나왔으므로, 공유 링크 게스트와 Fork에는 **출처 일치** 노트만 준다: `question_refs`의 모든 문제가 살아 있고 CONFIRMED이며 그 active revision이 노트에 고정된 `question_revision_id`와 같다. 문제가 삭제·보관·수정(새 revision)되면 그 노트는 다시 만들어 출처가 일치할 때까지 게스트에게 본문 없이 "정리 노트가 갱신 중이거나 없습니다."만 보이고(API 404), Fork에는 복제되지 않는다. 문제 추가만으로 생긴 stale은 인용한 내용이 여전히 공개 범위라 막지 않는다. 구성원에게는 그대로 stale badge와 함께 보인다.
- **보이기 (Q6·Q7):** 모든 구성원과 공유 링크 게스트(위 출처 일치 조건)가 볼 수 있다. 사람의 승인 없이 바로 보이고 편집할 수 없으며 `AI 생성` 글자 badge를 단다. 노트 본문은 정답·해설에서 나온 내용이므로 panel을 열 때마다 본문은 접혀 있고 "정답·해설 포함" disclosure를 펼쳐야 보인다.
- **풀이와 분리:** 문제 풀이 panel(QPLAY-01)과 practice API는 정리 노트 내용·링크를 보이거나 보내지 않는다(제출 전후 모두; 풀이 panel에는 진입점이 없음). 풀이 panel이 열리면 펼쳐져 있던 노트 본문은 다시 접힌다.
- **환경별 사용 여부:** 노트 생성은 worker 설정 `WORKER_CHAPTER_NOTES`가 켜져 있고 LLM이 설정된 환경에서만 가능하다. 꺼진 환경에서도 저장된 노트는 읽을 수 있다.

## 레이아웃 및 컴포넌트

- **진입 (QOV-01 Heatmap):** 챕터 그룹 header(장 제목·문제 수) 오른쪽에 `정리 노트` 버튼(글자 버튼, 접근성 이름 "<장 제목> 정리 노트", 모든 구성원). "챕터 없음" 그룹에는 없다. 노트가 만들어지는 중이면 버튼 옆에 "만드는 중" 글자 상태. 상태 필터는 노트 입력에 영향을 주지 않는다(필터와 무관하게 그 장의 모든 확정 문제).
- **panel:** 공통 `FloatingSidePanel`(non-modal). 다른 홈 dialog와 함께 열리고 나중에 연 것이 위(QOV-01-AC10). 한 번에 장 하나(다른 장의 `정리 노트`를 누르면 같은 panel의 장이 바뀐다). 즉시 열리고 불러오는 동안 skeleton(QOV-01-AC09).
  - header: 제목 "정리 노트", 부제 장 제목, `AI 생성` badge, 메타 줄 "문제 n개 기준 · <생성 시각>", stale badge(해당 시), 닫기 버튼.
  - `버전` 선택(구성원, 버전이 둘 이상일 때; 항목 "버전 k · <생성 시각>", 최신에 "(최신)"). 이전 버전을 고르면 "이전 버전" 안내가 붙는다.
  - **"정답·해설 포함" disclosure:** 버튼 "정답·해설 포함 — 펼쳐서 보기"(`aria-expanded`, `aria-controls`) 아래 설명 "이 노트에는 문제의 정답과 해설 내용이 들어 있습니다." 기본 접힘이고 panel을 다시 열면 다시 접힌다(기억하지 않음).
  - 펼친 본문: 소제목(`h3`)별 항목 목록. 항목 끝 각주 번호는 같은 panel 안의 각주로 가는 링크(접근성 이름 "각주 1"). 그 아래 `각주` 목록(`ol`): `[^k] <장> <번호>번 — <발문 앞 40자>`, 각 줄은 그 문제를 여는 링크(구성원은 `?question=<id>` 풀이 panel, 게스트는 공유 문제 panel). 노트 본문은 Markdown 일부(문단·목록·강조)만 렌더링하고 HTML·링크·이미지는 글자로 다룬다.
- **동작(편집 권한, 활성 Workspace):** 노트 없음 → "아직 정리 노트가 없습니다." + 안내 "이 장의 확정 문제 n개와 해설로 정리합니다. 문제와 해설이 AI 서비스로 전송됩니다." + `정리 노트 만들기`. 대기·실행 → "정리 노트를 만드는 중"(진행 막대 없음, 큰 장은 "k/m 묶음"). 실패 → alert "정리 노트를 만들지 못했습니다" + 이유 + `다시 시도`. 노트가 있으면 header에 `다시 만들기`(stale이면 안내 문구 옆에도 보임). 상태는 색이 아니라 글자로 전달한다.
- **오류 이유 문구:** `llm_unavailable`·`llm_timeout` → "AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.", `note_citation_invalid`(검증 후 남은 항목 없음) → "문제 출처를 확인할 수 있는 내용을 만들지 못했습니다. 다시 시도하세요.", 그 밖 → "정리 노트를 만들지 못했습니다. 다시 시도하세요."
- **공유 화면 (WS-VIEW-01):** 공유 Workspace 화면에 `정리 노트` 카드가 생기고 최신 성공 버전이 출처 일치인 장만 나열한다(장 제목 버튼 → 읽기 전용 panel). 딥링크로 연 장의 노트가 없거나 출처 일치가 아니면 panel은 본문 없이 "정리 노트가 갱신 중이거나 없습니다."만 보인다. `버전`·만들기·상태·오류는 없다.
- 키보드: Tab 순서 header → `버전` → disclosure → 항목·각주 → 동작 버튼; Escape·닫기로 닫으면 focus를 연 버튼으로 돌린다. 풀이 panel(modal)을 각주에서 열었다 닫으면 노트 본문은 접혀 있으므로 focus는 "정답·해설 포함" disclosure 버튼으로 돌아온다.

## 화면 상태

| 상태 | 편집 권한 | 보기 권한 | 공유 게스트 |
|---|---|---|---|
| 노트 없음 | 안내 + `정리 노트 만들기` | "아직 정리 노트가 없습니다." | 장이 목록에 없음 |
| 대기·실행 | "정리 노트를 만드는 중"(이전 버전이 있으면 그 노트를 함께 보임) | 같음(버튼 없음) | 이전 최신 버전(출처 일치일 때만) |
| 성공 | 노트 + `다시 만들기` + `버전` | 노트 + `버전` | 최신 노트(읽기 전용) |
| stale(문제 추가만) | badge + `다시 만들기` | badge | badge와 함께 노트 |
| stale(인용 문제 삭제·보관·수정) | badge + `다시 만들기` | badge | 본문 없음: "정리 노트가 갱신 중이거나 없습니다."(API 404) |
| 실패 | alert + `다시 시도`(이전 버전 유지) | alert | 이전 최신 버전(출처 일치일 때만) |
| 확정 문제 없는 장 | "이 장에는 확정된 문제가 없습니다." | 같음 | 404 |
| 기능 꺼짐(환경) | `정리 노트 만들기`·`다시 만들기` 비활성 + 이유 | 저장된 노트 읽기 | 저장된 노트 읽기 |
| 보관된 Workspace | 읽기 전용 | 읽기 전용 | 공유 규칙 그대로 |
| 다른 Workspace·삭제된 장 딥링크 | "장을 찾을 수 없습니다." | 같음 | 404 |

## 수용 기준

### CHNOTE-01-AC01

- **Given:** 편집 권한자가 연 Workspace 홈, 한 교재 장에 해설이 있는 확정 문제 3개와 같은 장의 등록되지 않은 import 초안 1개, 다른 장의 확정 문제 1개, 결정적 fake LLM 시나리오(`tests/fixtures/llm/chapter-note-scenarios.json`)
- **When:** Heatmap에서 그 장 그룹 header의 `<장 제목> 정리 노트`를 누르고 `정리 노트 만들기`를 두 번 빠르게 누른 뒤 완료를 기다린다
- **Then:** panel이 바로 열리고(`?panel=chapter-note&chapter=<id>`) "아직 정리 노트가 없습니다."와 "확정 문제 3개" 전송 안내를 보인다. 만들기 후 "정리 노트를 만드는 중"을 거쳐 `AI 생성` badge, "문제 3개 기준 · <생성 시각>"을 보이고, 본문은 접힌 "정답·해설 포함 — 펼쳐서 보기"(`aria-expanded="false"`) 뒤에 있다. 노트의 입력과 각주는 그 장의 확정 문제 3개뿐이다(초안·다른 장 문제 없음 — API `question_refs`). 두 번 눌러도 버전은 1개다(Idempotency-Key).

### CHNOTE-01-AC02

- **Given:** AC01처럼 만든 노트. fake 시나리오는 올바른 항목 외에 입력에 없는 문제(`Q99`)를 인용한 항목 하나와 각주 없는 항목 하나를 함께 돌려준다
- **When:** "정답·해설 포함"을 펼치고, 항목의 각주 번호와 각주 목록의 링크를 키보드로 따라간 뒤 풀이 panel을 닫는다
- **Then:** 보이는 모든 항목 끝에 각주 번호가 1개 이상 있고, 각주 목록의 각 줄은 `[^k] <장> <번호>번 — <발문 앞부분>` 형식이며 입력한 3개 문제만 가리킨다. `Q99` 인용 항목과 각주 없는 항목은 어디에도 보이지 않는다. 각주 링크는 그 문제의 풀이 panel(`?question=<id>`)을 열고, 풀이 panel이 열리면 노트 본문은 다시 접힌다. 풀이 panel을 닫으면 노트는 접힌 채이고 focus는 "정답·해설 포함" disclosure 버튼으로 돌아온다(누른 각주는 접힌 본문 안에 있어 focus를 받을 수 없다).

### CHNOTE-01-AC03

- **Given:** 버전 1 노트가 있는 장(확정 문제 3개)
- **When:** 편집 권한자가 전체 문제 페이지에서 그 장 문제 하나의 해설을 고치고 다른 하나를 삭제한 뒤 노트 panel을 열고, `다시 만들기`를 눌러 완료를 기다린 다음 `버전`에서 버전 1을 고른다
- **Then:** 다시 만들기 전 panel은 "문제가 바뀌어 최신이 아닙니다" badge(글자)를 보이고 삭제한 문제의 각주는 "삭제되었거나 옮긴 문제"로 링크가 없다. 다시 만들면 버전 2가 "문제 2개 기준"으로 보이고 badge가 사라진다. `버전`에서 버전 1을 고르면 "이전 버전" 안내와 함께 버전 1 내용이 그대로 보인다(이전 버전은 삭제되지 않음).

### CHNOTE-01-AC04

- **Given:** 노트가 있는 장과 없는 장이 있는 Workspace의 보기 권한자, 같은 Workspace의 유효한 공유 링크(비로그인 게스트), 그리고 Workspace를 보관한 상태
- **When:** 보기 권한자가 두 장의 `정리 노트`를 열고 `POST /chapters/{id}/note`를 직접 부른다. 게스트가 `/share/:shareId`의 `정리 노트` 카드에서 장을 열고 각주를 누르며, 다른 Workspace 장의 공유 노트 API를 부른다. Owner가 보관된 Workspace에서 노트 panel을 연다
- **Then:** 보기 권한자는 노트를 읽고 `버전`을 고를 수 있지만 `정리 노트 만들기`·`다시 만들기`가 없고 POST는 403이다. 게스트의 카드에는 노트가 있는 장만 있고, panel은 최신 버전을 같은 접힌 disclosure로 보이며 `버전`·만들기·상태·오류가 없다. 게스트의 각주는 공유 문제 panel(조회 전용)을 열고, 다른 Workspace 장은 404다. 이어서 편집 권한자가 그 노트가 인용한 문제 하나를 삭제(또는 해설 수정)하면, 게스트의 카드에서 그 장이 빠지고 이미 열린 panel을 다시 불러오면 본문 없이 "정리 노트가 갱신 중이거나 없습니다."만 보이며 공유 노트 API는 404다(이전 정답·해설 내용이 남지 않음); 구성원은 stale badge와 함께 계속 본다. 보관된 Workspace에서는 Owner에게도 만들기·다시 만들기가 없고 POST는 403이다.

### CHNOTE-01-AC05

- **Given:** 노트가 있는 장의 아직 풀지 않은 문제, 그 장의 노트 panel이 펼쳐진 상태
- **When:** Heatmap에서 그 문제의 marker를 눌러 풀이 panel을 열고, 답을 제출하기 전 화면과 `practice-sessions` 응답을 확인한 뒤 답을 제출하고 panel을 닫고, 노트 panel을 닫았다가 다시 연다
- **Then:** 풀이 panel이 열리는 순간 노트 본문이 접히고(`aria-expanded="false"`), 풀이 panel에는 제출 전후 모두 정리 노트 내용·링크가 없으며 practice API 응답에 노트 필드가 없다(정답·해설 비노출 규칙 유지). 노트 panel을 다시 열면 본문은 접힌 상태로 시작한다.

### CHNOTE-01-AC06

- **Given:** "챕터 없음" 그룹이 있는 Heatmap, 확정 문제가 없는(초안만 있는) 장의 id, 실패하도록 설정된 fake 시나리오의 장, 노트 생성이 진행 중인 장, 그리고 노트 기능이 꺼진 환경
- **When:** 각 그룹 header를 보고, 확정 문제 없는 장을 딥링크로 열고, 실패 장에서 만들기를 누르고, 진행 중인 장에 POST를 직접 보내고, 기능이 꺼진 환경에서 노트 panel을 연다
- **Then:** "챕터 없음" 그룹에는 `정리 노트` 버튼이 없다. 확정 문제 없는 장은 "이 장에는 확정된 문제가 없습니다."이고 만들기 버튼이 없으며 POST는 409 `no-chapter-questions`다. 실패하면 alert "정리 노트를 만들지 못했습니다"와 이유, 편집 권한자에게 `다시 시도`가 보이고 보기 권한자에게는 버튼이 없다. 진행 중인 장의 POST는 409 `note-generation-running`이다. 기능이 꺼진 환경에서는 `정리 노트 만들기`가 비활성(`aria-disabled`)이고 "이 환경에서는 AI 정리 노트를 사용할 수 없습니다."를 보이며 POST는 409 `note-generation-disabled`, 저장된 노트는 읽힌다.

## 계약 요구사항 (pytest·unit, 화면 AC 아님)

`tests/integration/questions/chapter_notes/test_chapter_notes_contract.py`, `apps/worker/tests`, `packages/core/tests`, `supabase/tests`(pgTAP).

| ID | 요구사항 |
|---|---|
| CHNOTE-01-C01 | **입력 범위:** 입력은 요청 시점에 그 장(`section_key`가 같은 현재 revision 챕터)에 속한 살아 있는 CONFIRMED 문제의 active revision(발문·보기 글·정답 글·해설)뿐이다. 초안·보관·삭제 문제, 다른 장·다른 Workspace 문제는 넣지 않는다. 입력 문제 목록(`question_refs`: tag, `question_id`, `question_revision_id`, 번호 표시)과 `input_fingerprint`(정렬된 `question_id:question_revision_id` 목록 + 참고 본문 hash의 SHA-256)를 노트 행에 고정하고 job은 그 목록만 읽는다. |
| CHNOTE-01-C02 | **인용 검증:** 모든 항목은 입력 tag(`Q1`…`Qn`)를 1개 이상 가져야 한다. 모르는 tag가 있거나 본문 인용(`quote`)이 참고 본문에 그대로 없으면 그 응답을 거절하고 한 번 다시 요청한다. 다시 받은 응답에서도 모르는 tag·인용 불일치 항목은 버리고, tag 없는 항목도 버린다. 남은 항목이 없으면 `note_citation_invalid`로 실패한다. 저장된 각주는 모두 `question_refs`에 있는 문제만 가리킨다(property test). |
| CHNOTE-01-C03 | **stale·이력:** stale은 읽을 때 현재 장의 확정 문제 fingerprint와 저장된 것을 비교해 계산한다(추가·revision 변경·삭제·보관·장 이동 각각 test). 만들기·다시 만들기는 새 버전 행을 만들고 이전 버전에 `superseded_at`을 적을 뿐 지우지 않는다. 장마다 대기·실행 중인 생성은 하나(partial unique; 두 번째는 409 `note-generation-running`, 같은 Idempotency-Key는 같은 결과). |
| CHNOTE-01-C04 | **큰 장:** 확정 문제가 120개 또는 입력 60,000자를 넘으면 묶음으로 나눠 노트를 만들고 소제목 단위로 합친다(각주 tag는 장 전체 기준으로 다시 매김). 묶음 수·usage·`cost_usd`를 노트 행에 기록한다. |
| CHNOTE-01-C05 | **인가 matrix:** GET(목록·노트·버전)은 모든 구성원(보관 Workspace 포함), POST는 owner·editor이고 활성 Workspace만(보관 403), 다른 Workspace·삭제된 장 404, 기능 꺼짐 409 `note-generation-disabled`. 공유 API는 최신 성공 버전이 출처 일치(모든 `question_refs` 문제가 살아 있고 CONFIRMED이며 active revision = 고정된 `question_revision_id`)일 때만 주고 아니면 404(목록에서도 제외), 각주는 현재 CONFIRMED이고 발행 범위인 문제만 링크·발문 앞부분을 주고 그 밖은 "삭제되었거나 옮긴 문제"로만 표시한다; 버전 목록·상태·오류·usage는 주지 않는다. `practice-sessions`·`submit` 응답에는 노트 필드가 없다. |
| CHNOTE-01-C06 | **유출 금지:** 문제·해설·노트 본문·prompt·LLM 응답은 API·worker 로그, job `result`(항목 수·버린 항목 수·usage·오류 코드만), 활동 기록(`chapter_note.generated` 등은 id만), trace에 남지 않는다. |
| CHNOTE-01-C07 | **Fork:** Fork는 장마다 최신 성공 버전 노트가 snapshot 기준 출처 일치일 때만(C05와 같은 조건, 고정된 snapshot의 문제 revision으로 판정) 새 id로 복제하고 `question_refs`의 문제·revision id를 새 id로 재매핑한다. 출처가 일치하지 않는 노트는 복제하지 않는다(이전 버전으로 대체하지 않음; 이전 버전·실패 기록·usage도 복제하지 않음). 따라서 복제된 노트의 각주는 모두 재매핑된다. |
| CHNOTE-01-C08 | **공유 철회 회귀:** 공유 노트를 읽은 뒤 인용 문제를 삭제·보관·수정하면 같은 공유 세션의 노트·목록 요청이 즉시 404/제외로 바뀌고 응답에 이전 본문·각주 발문이 없다(삭제·보관·revision 변경 각각; 문제 추가만이면 계속 200). |

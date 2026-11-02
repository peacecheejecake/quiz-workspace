# HOMEDLG-01 — Workspace 홈 dialog는 modal, 열고 닫아도 배치가 변하지 않음

**상태:** 확정 화면 요구사항 v1.0 · UX9-SPEC 신규 2026-11-02 (사용자 요청 "문서 관리, 중복 문제 정리 등도 modal로 변경하고 해당 dialog의 열고 닫힘에 따라 본문 layout이 변하지 않게", "정리 노트도 모달로 변경. 모달을 닫고 문제를 누르도록 유도" — 사용자 결정 2026-11-02 D3)
**Route:** 별도 route 없음 — Workspace 홈(`/workspaces/:workspaceId`)의 모든 floating dialog(`?panel=…`)와 정리 노트 panel. QOV-01(phase M5.0, CI에서 GREEN)의 dialog 규칙을 바꾸는 새 동작을 따로 추적한다.
**테스트:** `tests/e2e/workspaces/home-dialogs.spec.ts`
**Phase:** UX9.0 (RED) → UX9-MODAL
**연계:** [QOV-01](questions-overview.md) 4(뒤로가기)·AC10·AC14, [CHNOTE-02](chapter-note-tools.md), [UX9-SCROLL](overlay-scroll.md), [디자인 시스템](../design-system.md) §5.1·§5.5, [E2E 규칙](../e2e-strategy.md)

```yaml
id: HOMEDLG-01
route: (Workspace 홈의 모든 dialog)
actor: workspace_member
permission: read
status: confirmed
components: [FloatingSidePanel, ModalDialog, ConfirmDialog]
linked_tests: [HOMEDLG-01-AC01 … HOMEDLG-01-AC03]
```

## 대상

UX9 전에는 non-modal이던 Workspace 홈 dialog — 코드 `apps/web/src/components/workspaces/workspace-home.tsx`의 `FloatingSidePanel modal={false}`와 화면별 panel — 를 모두 **modal**로 바꾼다:

| dialog | URL | 화면 |
|---|---|---|
| 문서 관리 | `?panel=documents` | DOC-01 |
| 중복 문제 정리 | `?panel=question-duplicates` | QOV-01-AC16 |
| 보관·초안 문제 | `?panel=inactive-questions` | QOV-01-AC15 |
| 모의고사(목록·만들기·상세) | `?panel=mock-exams` | MOCK-01 |
| 이력 | `?panel=history` | HISTORY-01 |
| 링크 공유 | `?panel=share` | WS-SHARE-01 |
| 챕터 재분배(새) | `?panel=chapter-redistribution` | CHREDIST-01 |
| 정리 노트 | `?panel=chapter-note&chapter=` | CHNOTE-01·CHNOTE-02 (사용자 결정 "정리 노트도 모달로 변경") |
| 문서 요약 | `?panel=document-summary&document=` | DOCSUM-01 — modal, 문서 관리 행의 `요약`에서 열리면 문서 관리 위에 쌓임(사용자 결정 2026-11-02) |

이미 modal이던 것(풀이 panel `?question=`, 범위 풀이 `?practice=`, 문제 등록 `?panel=question-create`, 문제 상세, 확인 dialog)은 그대로다. **홈 밖의 floating panel도 모두 modal이다**(사용자 결정 2026-11-02 — 처음 제안(non-modal 유지)과 다름): 본문 검색 페이지의 "본문 발췌"(SEARCH-02), 가져오기 페이지의 원본 비교(`source-compare-panel`, "원본 PDF", QIMPORT-01), 공유 게스트 화면의 문제 미리보기·문서 요약·정리 노트 panel(WS-VIEW-01). 그 뒤의 목록(검색 결과·초안 목록·공유 목록)은 panel이 열린 동안 `inert`이고, 같은 배치 고정 규칙이 적용된다(그 페이지들에서 데스크톱 panel 옆으로 목록이 비켜서던 동작도 없어짐). 목록의 다른 항목으로 옮기는 길은 panel 안의 이전·다음 (제안 — 사용자 확인 필요: panel header의 `이전`·`다음` 버튼과 Alt+↑/Alt+↓로 목록 순서대로 옮기고, 다른 항목을 고르려면 닫고 고름. 대안: 닫고 고르기만). DOC-02의 docked 목차(DOCVIEW-01)만 페이지 배치의 일부라 non-modal로 남는다.

## 규칙

- **modal:** 열면 focus가 dialog 안(제목 또는 첫 조작)으로 가고 Tab·Shift+Tab은 dialog 안에서만 돈다. 배경(header·Heatmap·다른 열린 dialog)은 `inert`이고 backdrop(`--color-backdrop`)이 덮는다 — pointer·keyboard·화면 낭독기 어느 쪽으로도 닿지 않는다. 닫기 버튼·Escape(dialog 안 어디서든)·backdrop click(확인 없이 잃을 입력이 없을 때만 — 모의고사 만들기·문제 등록처럼 입력 중인 dialog는 backdrop click으로 닫지 않음)으로 닫고, 닫으면 focus는 연 버튼(없으면 `h1` 다음의 홈 첫 조작)으로 돌아간다.
- **여러 개가 쌓일 수 있고 맨 위 하나만 활성 (사용자 결정 2026-11-02):** header·Heatmap은 dialog가 열린 동안 비활성이므로 버튼으로는 홈 수준 dialog를 하나씩만 연다(이전 QOV-01-AC10의 "옆에 두고 다른 버튼으로 하나 더 열기·가려진 dialog 다시 위로"는 없어짐). 딥링크로 들어오면 여러 홈 dialog가 함께 쌓여 열린다(아래 "뒤로가기"). 쌓인 것 중 맨 위 하나만 활성이고 그 아래는 모두 `inert`이다. dialog **안에서** 연 dialog·panel은 그 위에 modal로 쌓인다 — 문서 관리 → `요약`(문서 요약), 보관·초안 문제 → 문제 상세, 정리 노트 → 각주의 풀이 panel·문제 상세, 모든 확인 dialog. 위의 것을 닫으면 아래 것으로 돌아가고 focus는 그것을 연 조작으로 간다. dialog 안의 링크가 홈을 떠나면(문서 관리 → `문제 검토` → 가져오기 페이지, `PDF 열기` → DOC-02) 페이지 이동이고 dialog는 이동과 함께 닫힌다(지금과 같음 — 뒤로가기는 지금처럼 그 dialog가 열린 홈 기록 항목으로 돌아간다).
- **뒤로가기 (QOV-01 4, UX7-BACK·UX7-BACK-2 그대로):** 열면 기록 항목 하나, 열린 동안 뒤로가기 한 번 = 맨 위 dialog 하나 닫기, 닫힌 dialog는 어느 방향 기록에도 남지 않음, 닫으면 열기 전 주소(열린 동안 바꾼 필터·검색어 유지). 쌓인 dialog는 위부터 하나씩 닫힌다. 딥링크로 홈 수준 dialog가 둘 이상인 주소(`?panel=documents&panel=mock-exams`)는 **모두 연다**(사용자 결정 2026-11-02 — 처음 제안 "마지막 하나만"과 다름): URL의 `panel` 매개변수 순서대로 쌓고 마지막이 맨 위에서 focus를 받는다; 주소는 바꾸지 않는다(replace 없음). Escape·닫기·뒤로가기는 맨 위부터 하나씩 닫고(UX7-BACK-2의 "딥링크 dialog도 열린 순서로 친다" 그대로), 하나를 닫으면 그 아래 것이 활성이 되며 focus는 그 dialog 안의 마지막 focus(없으면 제목)로 간다. 안에서 연 조합(`?panel=documents&panel=document-summary&document=<id>`, `?panel=chapter-note&chapter=<id>&question=<id>`)도 같은 규칙이다.
- **배치가 변하지 않음 (사용자 결정 D3):** dialog를 열고 닫아도 홈 내용(header·문제 검색·Heatmap·marker)의 위치·크기가 한 픽셀도 바뀌지 않는다. (1) 데스크톱에서 열린 dialog 옆으로 홈 내용이 비켜서던 동작(QOV-01 4·AC10, UX3c)은 없어진다 — modal이 위를 덮는다. (2) scroll 잠금 때문에 scrollbar가 사라져 내용이 옆으로 밀리지 않도록 페이지 scroll root는 `scrollbar-gutter: stable`이고, scroll 잠금(Radix `RemoveScroll`)은 `body`에 `padding-right`·`margin-right` 보정을 넣지 않는다(gutter가 자리를 지키므로 보정하면 오히려 밀림). (3) iOS·overlay scrollbar 환경은 scrollbar 폭이 0이라 그대로다. (4) dialog 등장·퇴장 애니메이션은 dialog 자신의 transform·opacity만이다. design-system §5.5.
- **scroll 격리:** overlay 안 scroll은 페이지로 이어지지 않는다(UX9-SCROLL — modal이 되어도 AC01~AC03 그대로, AC04는 "modal 위 wheel이 페이지를 scroll하지 않음"으로 바뀜 — 남는 non-modal floating 표면이 없음).

## 수용 기준

### HOMEDLG-01-AC01

- **Given:** Owner의 Workspace 홈(확정 문제·문서·이력·모의고사·노트가 있음, 공유 가능)
- **When:** 위 표의 dialog(문서 관리, 중복 문제 정리, 보관·초안 문제, 모의고사, 이력, 링크 공유, 챕터 재분배, 정리 노트)를 하나씩 버튼으로 열고, 각각 Tab을 dialog의 조작 수보다 많이 누르고, dialog 밖의 Heatmap marker와 header 버튼을 click하고, Escape로 닫는다
- **Then:** 각 dialog는 `role="dialog"`·`aria-modal="true"`이고 열리면 focus가 dialog 안에 있으며 Tab·Shift+Tab이 dialog 밖으로 나가지 않는다. 열린 동안 홈 배경은 `inert`(marker·header 버튼 click이 아무것도 열지 않고 URL이 그대로)이다. Escape는 dialog를 닫고 focus를 연 버튼으로 돌리며 `panel=` 값이 URL에서 빠진다. 닫은 뒤 뒤로가기·앞으로가기로 다시 열리지 않는다(QOV-01-AC14).

### HOMEDLG-01-AC02

- **Given:** 문서 하나(요약 있음)와 보관 문제 하나가 있는 Workspace 홈(Owner), 그 전에 Workspace 목록을 연 기록
- **When:** 문서 관리를 열고 그 행의 `요약`을 누르고, 뒤로가기를 두 번 누르고; 보관·초안 문제에서 행을 눌러 문제 상세를 열고 Escape를 두 번 누르고; `?panel=documents&panel=mock-exams` 딥링크를 열고 Escape를 누르고 뒤로가기를 누르고; `?panel=documents&panel=document-summary&document=<id>`를 연다
- **Then:** 문서 요약은 문서 관리 위에 modal로 쌓이고(둘 다 열려 있고 요약이 위, 문서 관리는 `inert`), 첫 뒤로가기는 요약만 닫고 focus를 `요약` 버튼으로 돌리며 둘째 뒤로가기가 문서 관리를 닫는다. 문제 상세도 같은 식으로 위에서부터 Escape 한 번에 하나씩 닫힌다. `?panel=documents&panel=mock-exams`는 두 dialog를 모두 열고 모의고사가 맨 위(focus가 그 안, 문서 관리는 `inert`)이며 주소는 그대로다. Escape는 모의고사만 닫아 문서 관리가 활성이 되고(URL에서 `panel=mock-exams`만 빠짐), 그 뒤 뒤로가기가 문서 관리를 닫는다(앞으로가기로 다시 열리지 않음). 쌓임 조합 주소는 문서 관리 위에 요약을 쌓아 연다.

### HOMEDLG-01-AC03

- **Given:** 세로 scroll이 생길 만큼 확정 문제가 많은 Workspace 홈: 데스크톱 Chromium 1280px(고전 scrollbar가 보이도록 `--hide-scrollbars` 없이 실행, scrollbar 폭 > 0 확인)와 iPad Pro 11 WebKit, 페이지를 중간까지 scroll한 상태
- **When:** header·Workspace header·문제 검색 입력란·Heatmap 첫 장 그룹·첫 marker·마지막으로 보이는 marker의 `getBoundingClientRect()`와 `document.documentElement.clientWidth`·`body`의 computed `padding-right`·`margin-right`를 재고; 문서 관리 dialog를 열어(애니메이션 끝까지 기다림) 다시 재고; 닫고(focus 복귀 뒤) 다시 재고; 정리 노트·모의고사·이력에 대해서도 같은 일을 한다
- **Then:** 세 번 잰 모든 bounding box(x·y·width·height)가 같고(허용 오차 0px), `clientWidth`가 바뀌지 않으며, `body`의 `padding-right`·`margin-right`가 0으로 남고, `window.scrollY`도 열기 전과 같다. 루트의 computed `scrollbar-gutter`는 `stable`이다. 열린 동안 홈 내용이 dialog 옆으로 비켜서지 않는다(데스크톱에서도 x 좌표 그대로).

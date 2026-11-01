# (폐기) QBANK-01 전체 문제 목록·편집

**상태:** 폐기 — UX7-BANK 2026-11-01. 이 문서는 화면 요구사항이 아니라 폐기 기록이다(화면 표 `index.md`와 e2e-trace 대상에서 빠짐).
**이전 Route:** `/workspaces/:workspaceId/questions/bank` → 이제 Workspace 홈(`/workspaces/:workspaceId`)으로 redirect한다. `?question=<id>`는 그대로 넘겨 홈의 문제 풀이 panel(QPLAY-01)을 연다. 다른 query(`q`, `type`, `chapter`, `status`, `create`)는 버린다.
**연계:** [Workspace 홈](questions-overview.md), [문제 풀이 panel](questions-practice.md)

## 결정

사용자 결정(2026-11-01): "'전체 문제' 페이지 삭제. 문제 편집/삭제만 홈으로 옮기면 될듯. 나머지는 이미 홈에 있음."

- **홈으로 옮긴 것**
  - 문제 직접 등록: 홈 header `문제` 메뉴 › `직접 추가`와 빈 Heatmap의 `문제 등록`이 홈 위에 같은 "문제 등록" dialog(기존 편집기)를 연다(`?panel=question-create`) — QOV-01-AC12.
  - 문제 편집·삭제: 문제 풀이 panel header의 `문제 관리` 메뉴 › `편집`(기존 "문제 편집" dialog, 새 revision)·`삭제`(확인 dialog). 편집 권한이고 보관되지 않은 Workspace에서만 보인다 — QPLAY-01-AC07·AC08. 같은 메뉴의 `변형 출제`는 이전 상세 panel의 `변형 출제`처럼 그 문제의 검토 페이지를 연다.
  - 하위 페이지 뒤로가기·breadcrumb 규칙(문제 PDF 가져오기·문제 변형 출제·PDF 열람) — QOV-01-AC13.
- **이미 홈에 있다고 본 것 (옮기지 않음)**: 챕터별 목록(= Heatmap 챕터 그룹), 문제 검색·유형·챕터 필터(= 통합 검색의 `문제` 범위와 설정), 문제 PDF 관리 dialog(`문제` 메뉴 › `PDF 관리`; UX7-DOCS 2026-11-01부터 문서 관리, DOC-01-AC09), 여러 문제 선택 변형 출제(`문제` 메뉴 › `변형 출제` dialog의 `여러 문제` tab, QGEN-01-AC06·AC07).
- **없어진 것**: 상태 필터 `초안`·`보관됨`·`전체 상태`, 문제 `보관`·`보관 해제`(Heatmap은 확정 문제만 보이므로 홈에서 보관하면 되돌릴 곳이 없다 — 보관은 옮기지 않았다. API `PATCH /questions/{id}` `publication_status`는 그대로다), 상세 panel의 수정 이력(버전 목록)·출처 링크 목록, "더 보기" 목록 paging.

## AC 처리

| 이전 AC | 처리 | 이어받은 AC |
|---|---|---|
| QBANK-01-AC01 빈 상태의 직접 등록·PDF 가져오기 | 옮김 | QOV-01-AC12(빈 Heatmap의 `문제 등록`이 홈 위에 편집기를 연다; PDF는 `문제` 메뉴 › `PDF 관리`, QIMPORT-01-AC05 → UX7-DOCS부터 문서 관리, DOC-01-AC09) |
| QBANK-01-AC02 유효한 객관식 저장 → 챕터별 목록 | 옮김 | QOV-01-AC12(저장하면 그 챕터의 Heatmap 점). 검색·유형·챕터 필터는 SEARCH-01-AC07·QOV-01 필터가 이미 다룬다 |
| QBANK-01-AC03 수정 → 새 question_revision, 이전 풀이 기록 유지 | 옮김 | QPLAY-01-AC07 |
| QBANK-01-AC04 다른 사용자 question ID 수정 차단(+ viewer/보관 읽기 전용) | 옮김 | QPLAY-01-AC08 |
| QBANK-01-AC05 하위 페이지 뒤로가기·breadcrumb | 옮김(전체 문제 페이지 부분은 폐기) | QOV-01-AC13 |
| QBANK-01-AC06 검색·필터 접기, 빈 문제은행 버튼, PDF 가져오기 dialog | 폐기 | — (PDF dialog는 QIMPORT-01-AC05) |

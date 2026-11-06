# UX12-SEARCHPAGE — 본문 검색 header의 AI에게 묻기

**E2E:** `tests/e2e/search/ux12-search-page.spec.ts`

**Phase:** `UX12-SEARCHPAGE.0`

**상태:** UX12 HOME-3 신규 2026-11-06 (사용자 피드백 "AI에게 묻기 버튼 위치 header로"). **연계:** [SEARCH-02](search-page.md), [ASK-01](ask-llm.md), [UX12 계획](../implementation/ux12/index.md) §4.3.

## 규칙

- `AI에게 묻기`는 본문 검색 페이지의 `PageHeader` 동작 자리에 있다. 검색 form 안에는 없다. 다른 화면으로 옮기지 않는다.
- 동작은 그대로다. 검색어와 문서·장 범위를 새 대화에 채우고 자동 전송하지 않으며, 보관 Workspace와 기능 꺼짐 환경에서는 숨긴다.

## 수용 기준

### UX12-SEARCHPAGE-AC01
**Header 위치:** 본문 검색 페이지에서 `AI에게 묻기`는 검색 form 밖, form 위의 페이지 header에 있다. 검색어를 입력하고 누르면 AI 질문 panel이 그 글자를 입력란에 채워 열리고 전송하지 않으며 URL은 바뀌지 않는다.

### UX12-SEARCHPAGE-AC02
**좁은 화면:** 폭 375px에서도 버튼은 header에 있고 화면 안에 다 보이며 가로 스크롤이 생기지 않는다.

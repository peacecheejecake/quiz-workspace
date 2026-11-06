# UX12-CHAPTERSCROLL — `문서 N` 수와 floating 목록 스크롤

**상태:** 구현 중 · [UX12 계획](../implementation/ux12/index.md) §4.3b HOME-7 · [UX12-HEADER](ux12-home-header.md)
**Route:** `/workspaces/:workspaceId`
**테스트:** `tests/e2e/quality/ux12-doc-count-chapter-scroll.spec.ts` (단위: `apps/web/test/document-kinds.test.tsx`)
**Phase:** UX12-CHAPTERSCROLL.0

## `문서 N` (HOME-7)

사용자 요청(2026-11-06): 홈의 `문서 N`은 문제 PDF와 본문 PDF를 나누지 않은 PDF 수다.

**세는 기준:** 문서 관리 목록의 행 수다. 사용자가 그 목록에서 보는 수와 늘 같다.

- 종류를 나누지 않는다. `교재`, `문제지`, `교재+문제`, 분류 전(`분석 중`) 모두 센다.
- 처리에 실패한 PDF도 목록에 행이 있으므로 센다. 이 탭에서 올리는 중인 파일도 행이 있으므로 센다.
- 문서에는 보관 상태가 없다. 삭제한 문서는 API 목록과 문서 관리에 없으므로 세지 않는다.

## 수용 기준

### UX12-CHAPTERSCROLL-AC01

교재 하나와 문제지 하나가 있는 Workspace의 홈에서 `문서 N`은 2다. 문서 관리 목록의 행도 2개이고, 문제지를 지우면 둘 다 1이 된다.

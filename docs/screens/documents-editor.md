# DOC-02 — PDF 열람·원문 교정

**상태:** 확정 화면 요구사항 v1.3
**Route:** `/workspaces/:workspaceId/documents/:documentId`
**테스트:** `tests/e2e/documents/documents-editor.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- 좌측 목차·중앙 PDF.js 뷰어·우측 canonical text 블록 편집기. Draft/Published revision 분리, error recovery 지원.
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.

## 수용 기준

### DOC-02-AC01

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 파싱 완료 문서의 목차에서 장·절을 선택하면 PDF 페이지와 해당 원문 블록으로 이동한다.

### DOC-02-AC02

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** canonical 텍스트 블록을 수정·저장하면 draft revision을 새로 생성하지만 PDF 원본 파일은 변경하지 않는다.

### DOC-02-AC03

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** Draft를 발행하면 색인 작업 후 새 published revision이 검색에 반영된다.

### DOC-02-AC04

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 재색인에 실패하면 이전 published revision 검색을 유지하면서 오류와 재시도 안내를 제공한다.

### DOC-02-AC05

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 읽기 전용 사용자는 편집 UI와 쓰기 API가 차단된다. 공유 Viewer에게도 같은 제약 적용.

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.

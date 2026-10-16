# QIMPORT-01 — 문제 PDF 가져오기

**상태:** 확정 화면 요구사항 v1.3
**Route:** `/workspaces/:workspaceId/questions/import`
**테스트:** `tests/e2e/questions/questions-import.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- 상태별 Empty/Loading/Failure/Success UI, 반응형 Layout과 Floating Side Panel, 접근성 지원.
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.

## 수용 기준

### QIMPORT-01-AC01

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 문제 5개 포함 PDF 업로드/추출 시 원본 PDF 페이지를 연결한 draft 5개를 표시한다.

### QIMPORT-01-AC02

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 정답 없는 PDF의 추출 결과는 정답 null로 저장하며 모델이 임의로 정답을 생성하지 않는다.

### QIMPORT-01-AC03

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 사용자가 검토·승인한 초안만 문제은행에 확정 등록하고 Heatmap 마커를 증가시킨다.

### QIMPORT-01-AC04

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 작업 실패 후 재시도 시 초안·확정 문제를 중복 등록하지 않는다.

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.

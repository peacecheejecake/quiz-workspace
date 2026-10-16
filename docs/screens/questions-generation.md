# QGEN-01 — 문제 변형 출제

**상태:** 확정 화면 요구사항 v1.3
**Route:** `/workspaces/:workspaceId/questions/generate`
**테스트:** `tests/e2e/questions/questions-generation.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- 상태별 Empty/Loading/Failure/Success UI, 반응형 Layout과 Floating Side Panel, 접근성 지원.
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.

## 수용 기준

### QGEN-01-AC01

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 확정 객관식 문제의 보기만 섞을 때 원본 문제의 연습 세션에 순서만 저장하고 신규 문제나 Heatmap 점을 생성하지 않는다.

### QGEN-01-AC02

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 문구 변형 초안 생성 후 원본과 diff, 근거 출처, 정답 검증 상태를 표시한다.

### QGEN-01-AC03

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** '틀린 것'을 '맞는 것'으로 바꿔 복수 정답이 생기면 경고하고 검증 통과 전 승인을 차단한다.

### QGEN-01-AC04

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 유사 개념 변형을 승인하면 원본 lineage와 문서 근거를 가진 새로운 확정 문제를 만든다.

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.

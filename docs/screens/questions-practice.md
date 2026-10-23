# QPLAY-01 — 문제 풀이 Floating Side Panel

**상태:** 확정 화면 요구사항 v1.3
**Route:** `/workspaces/:workspaceId?question=:questionId` (Workspace 홈 위 panel; 이전 `/questions?question=`은 redirect — UX3c 2026-10-20)
**테스트:** `tests/e2e/questions/questions-practice.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- non-disclosing practice DTO 사용: 답안 제출 전 correct_option_ids와 해설 제공 금지. 정답 확정 시 서버 판정 및 attempt 기록.
- 객관식 보기는 각 줄 앞에 표시 순서대로 번호(`1.` `2.` …)를 보인다(UX5-UI 2026-10-23, 문제은행 상세·초안 검토와 같은 형식). 섞인 세션은 표시된 순서로 번호를 매긴다. 번호는 표시용(`aria-hidden`)이라 radio/checkbox 이름은 보기 문구이고 위치는 그룹이 읽어 주며, 채점은 번호·위치가 아니라 option ID로 한다(AC02).
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.

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

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.

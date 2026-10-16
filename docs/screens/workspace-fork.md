# WS-FORK-01 — Workspace Fork

**상태:** 확정 요구사항 (v1.3)
**화면:** `/share/:shareId?panel=fork`
**연계:** [공유·Fork 명세](../workspace-sharing.md), [인증](../auth.md), [디자인 시스템](../design-system.md)

## 목적 및 UI
- 권한 경계: 로그인된 링크 Viewer + 원 저작자 Fork 허용; Floating Dialog 및 비동기 작업.
- 모바일/데스크톱 레이아웃, 로딩·에러·빈 상태, 키보드 포커스·스크린리더, URL/token 로그 비노출을 충족한다.

## 수용 기준

### WS-FORK-01-AC01

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then 공유 링크가 유효하고 Fork ON일 때만 로그인 사용자에게 Fork 대화상자를 제공한다.

### WS-FORK-01-AC02

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then 비로그인·Fork OFF·만료 링크·권한 없는 사용자에게 Fork 요청 API를 거부한다.

### WS-FORK-01-AC03

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then 복제 범위, 독립 Workspace, 개인별 진행 상태 미복제, 저작권 주의사항을 보여주고 새 이름을 입력받는다.

### WS-FORK-01-AC04

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then Fork 시작시 202 + job id를 제공하며 중복 요청에는 멱등 처리, 진행률·완료·실패 상태를 표시한다.

### WS-FORK-01-AC05

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then 완료된 Workspace의 published PDF·문서·질문·해설은 동일하지만 ID·소유자가 새로 발급되고 풀이·즐겨찾기·다시 풀기가 초기화된다.

### WS-FORK-01-AC06

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then 복제 진행 중 Owner가 링크를 철회하거나 Fork를 OFF로 바꾸면 CANCELLED·임시 데이터 정리; 완료된 Fork는 원본 삭제에도 유지된다.

## E2E 우선 개발
- 같은 AC ID를 사용하는 `tests/e2e/workspaces/fork.spec.ts`를 화면 구현 전에 작성한다.
- API 인가 검증은 UI 버튼 숨김만으로 대체할 수 없다.

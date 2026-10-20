# WS-SHARE-01 — Owner Workspace 공유 관리

**상태:** 확정 요구사항 (v1.3) · UX3c 개정 2026-10-20 (공유하기 버튼 → 링크 공유 floating dialog)
**화면:** `/workspaces/:workspaceId?panel=share` (Workspace header의 `공유하기` 버튼, Owner만; 이전 `/workspaces/:workspaceId/settings/sharing`은 여기로 redirect)
**연계:** [공유·Fork 명세](../workspace-sharing.md), [인증](../auth.md), [디자인 시스템](../design-system.md)

## 목적 및 UI
- 권한 경계: Owner 전용 설정; Floating Side Panel 사용.
- UX3c 2026-10-20: 별도 "공유 설정" 섹션·화면 제목은 없다. Owner가 Workspace header의 `공유하기`를 누르면 "링크 공유" non-modal floating dialog가 바로 열리고(링크 정보를 불러오는 동안 skeleton) 아래 AC의 모든 동작을 그 안에서 한다. Owner가 아니면 `공유하기` 버튼이 없고 `?panel=share`도 열리지 않는다.
- 모바일/데스크톱 레이아웃, 로딩·에러·빈 상태, 키보드 포커스·스크린리더, URL/token 로그 비노출을 충족한다.

## 수용 기준

### WS-SHARE-01-AC01

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then Owner가 공유 설정(`공유하기` → 링크 공유 dialog)을 열면 기본 OFF, 공개 범위·저작권 주의 문구와 Fork 기본 OFF를 표시한다.

### WS-SHARE-01-AC02

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then Owner가 링크를 생성하면 보기 전용 비밀 URL을 1회만 노출하고 복사·만료 설정이 가능하다. Viewer 멤버십을 만들지 않는다.

### WS-SHARE-01-AC03

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then Owner는 Fork 허용 여부와 만료일을 변경할 수 있다. owner가 아닌 계정의 동일 API 요청을 거부한다.

### WS-SHARE-01-AC04

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then Owner의 링크 철회·Rotate 즉시 이전 URL과 기존 공유 세션이 무효화된다.

### WS-SHARE-01-AC05

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then Archived Workspace에서는 링크 철회와 정책 수정만 가능하고 삭제된 Workspace의 링크는 사용 불가능하다.

## E2E 우선 개발
- 같은 AC ID를 사용하는 `tests/e2e/workspaces/sharing-owner.spec.ts`를 화면 구현 전에 작성한다.
- API 인가 검증은 UI 버튼 숨김만으로 대체할 수 없다.

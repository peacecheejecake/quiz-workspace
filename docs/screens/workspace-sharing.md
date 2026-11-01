# WS-SHARE-01 — Owner Workspace 공유 관리

**상태:** 확정 요구사항 (v1.3) · UX3c 개정 2026-10-20 (공유하기 버튼 → 링크 공유 floating dialog) · UX7-SHARE-EXPIRY 개정 2026-11-01 (만료일 삭제 AC06, 만료일 영역 너비 AC07, 복사 완료 표시 AC08)
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

### WS-SHARE-01-AC06

- Given 만료일이 저장된(만료 전이거나 이미 지난) 링크가 있는 Owner의 링크 공유 dialog
- When Owner가 만료일 옆 `만료일 삭제` 버튼(키보드로 도달 가능, 접근 가능한 이름)을 누름
- Then 만료일이 지워져 무제한으로 저장되고(API `PATCH … {"expires_at": null}`, 목록의 `expires_at`은 null) dialog는 만료일 칸 아래에 `만료 없음`을 표시한다. 만료일이 이미 지난 링크도 다시 열리고, 링크로 연 기존·신규 공유 세션은 이전 만료일이 지나도 계속 열린다. 보관된 Workspace에서도 만료일 삭제는 정책 수정(AC05)이라 가능하다. 만료일이 비어 있으면 `만료일 삭제` 버튼은 없다.

### WS-SHARE-01-AC07

- Given 링크 공유 dialog (데스크톱 1280px, iPad 834px, 휴대폰 375px; light·dark)
- When 만료일 영역(라벨·날짜 입력·`만료일 삭제`·도움말·오류)을 표시
- Then 그 영역의 어떤 요소도 dialog 본문의 content box(좌우 padding 안쪽)를 넘지 않고, dialog 본문에 가로 스크롤이 생기지 않는다. 글자 크기를 줄이지 않고 레이아웃(줄바꿈·`min-width: 0`)으로 맞춘다.

### WS-SHARE-01-AC08

- Given 방금 만든 링크가 표시된 링크 공유 dialog
- When Owner가 `링크 복사`를 누름
- Then 복사에 성공하면 버튼 안 아이콘이 체크로 바뀌고 버튼 이름이 `복사됨`이 되며, polite live region이 "링크를 복사했습니다."를 한 번 알린다(성공 toast는 띄우지 않는다). 약 2초 뒤 원래 아이콘·이름으로 돌아오고, 바뀌는 동안 버튼 크기·위치는 변하지 않는다. 실패하면 체크를 표시하지 않고 링크 칸을 선택한 채 오류 toast를 띄운다. 애니메이션은 없다(`prefers-reduced-motion`과 무관하게 즉시 교체).

## E2E 우선 개발
- 같은 AC ID를 사용하는 `tests/e2e/workspaces/sharing-owner.spec.ts`를 화면 구현 전에 작성한다.
- API 인가 검증은 UI 버튼 숨김만으로 대체할 수 없다.

# WS-VIEW-01 — 링크 기반 공유 Workspace 조회

**상태:** 확정 요구사항 (v1.3)
**화면:** `/share/:shareId`
**연계:** [공유·Fork 명세](../workspace-sharing.md), [인증](../auth.md), [디자인 시스템](../design-system.md)

## 목적 및 UI
- 권한 경계: 비로그인 링크 Viewer; 원본 수정·진도 저장 불가.
- 모바일/데스크톱 레이아웃, 로딩·에러·빈 상태, 키보드 포커스·스크린리더, URL/token 로그 비노출을 충족한다.
- **요약·정리 노트 (DOCSUM-SPEC 2026-10-29):** 게스트는 현재 발행 revision의 문서 요약(문서 목록 행의 `요약`, [DOCSUM-01-AC06](documents-summary.md))과 인용 문제와 출처가 일치하는 장별 최신 정리 노트(`정리 노트` 카드, [CHNOTE-01-AC04](chapter-notes.md))를 읽기 전용으로 볼 수 있다. 텍스트 내보내기(DOC-03)는 게스트에게 없다. 이 화면의 기존 AC는 바뀌지 않는다.

## 수용 기준

### WS-VIEW-01-AC01

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then 로그인하지 않은 사용자가 유효한 공유 링크에 접속하면 Published 목차·문서·문제만 조회할 수 있다.

### WS-VIEW-01-AC02

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then 문서 원문·PDF·검색 결과를 클릭해 열 수 있으며 SourceLocation과 페이지를 확인할 수 있다.

### WS-VIEW-01-AC03

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then 문제 Preview와 Floating Side Panel은 조회 전용이고 풀이·즐겨찾기·다시 풀기·편집 결과가 저장되지 않는다.

### WS-VIEW-01-AC04

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then 다른 Workspace ID, 미발행 revision, Owner 개인 기록·비공개 데이터의 direct API 요청이 차단된다.

### WS-VIEW-01-AC05

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then 링크가 잘못되었거나 만료·철회·삭제되면 접근 불가 안내를 보여주고 기존 공유 세션도 무효화한다.

### WS-VIEW-01-AC06

- Given 해당 화면에 필요한 사용자/링크 상태
- When 사용자가 기능을 수행하거나 직접 API를 호출
- Then Fork OFF라면 Fork 버튼을 숨긴다. ON이면 로그인 및 독립 복제 안내와 Fork 진입 기능을 제공한다.

## E2E 우선 개발
- 같은 AC ID를 사용하는 `tests/e2e/workspaces/share-public.spec.ts`를 화면 구현 전에 작성한다.
- API 인가 검증은 UI 버튼 숨김만으로 대체할 수 없다.

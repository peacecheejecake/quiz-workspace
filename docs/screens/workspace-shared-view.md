# WS-VIEW-01 — 링크 기반 공유 Workspace 조회

**상태:** 확정 요구사항 (v1.3)
**화면:** `/share/:shareId`
**연계:** [공유·Fork 명세](../workspace-sharing.md), [인증](../auth.md), [디자인 시스템](../design-system.md)

## 목적 및 UI
- 권한 경계: 비로그인 링크 Viewer; 원본 수정·진도 저장 불가.
- 모바일/데스크톱 레이아웃, 로딩·에러·빈 상태, 키보드 포커스·스크린리더, URL/token 로그 비노출을 충족한다.
- **요약·정리 노트 (DOCSUM-SPEC 2026-10-29):** 게스트는 현재 발행 revision의 문서 요약(문서 목록 행의 `요약`, [DOCSUM-01-AC06](documents-summary.md))과 인용 문제와 출처가 일치하는 장별 최신 정리 노트(`정리 노트` 카드, [CHNOTE-01-AC04](chapter-notes.md))를 읽기 전용으로 볼 수 있다. 텍스트 내보내기(DOC-03)는 게스트에게 없다. 이 화면의 기존 AC는 바뀌지 않는다.
- **문서 보기 개선 (DOCVIEW 2026-11-01):** 공유 문서 화면은 DOC-02의 viewer 부품을 쓰므로 연속 스크롤 PDF·PDF↔원문 동기화·쪽별 묶음·확정된 가져온 문제의 문제 형식(정답·해설은 접힘, 발행 문제 범위)이 같다([DOC-02-AC07–AC09·AC11](documents-editor.md)). 배치(보기 설정 막대·docked 목차 panel·함께 보기/원본/변환본·좌우/상하 분할·위치 바꾸기, 이 브라우저에 기억)도 DOC-02와 같다([DOCVIEW-01](documents-viewer-layout.md), AC12; DOCVIEW-PORT 2026-11-02에 이전 목차 panel·폭 조정 구분선을 대신함). 편집 UI는 계속 없다. 이 화면의 기존 AC는 바뀌지 않는다.
- **통합 `QuestionViewer` (MOCK-SPEC 2026-11-01):** 게스트의 문제 미리보기(정리 노트 각주에서 여는 것 포함)는 공통 `QuestionViewer`의 `read-only` 방식(non-modal — **UX9-SPEC 사용자 결정 2026-11-02부터 modal**, 발행 문제·정답·해설, 저장 없음)이 된다([QVIEW-01](question-viewer.md) 호출 위치 6). 게스트에게 모의고사(MOCK-01)와 범위 풀이(`문제 풀기`)는 없다. 이 화면의 기존 AC는 바뀌지 않는다.
- **AI 질문·AI 해설 (ASK-SPEC 2026-11-01, 초안):** 게스트에게 AI 질문(ASK-01)은 없다(`?panel=ask` 무시, API 401/404). 공유 문제 panel은 이미 만든 최신 AI 해설(AIEXPL-01)을 읽기 전용으로 보인다(사용자 결정 2026-11-01; 만들기 없음). 이미 저장된 관련 본문(RELSRC-01)도 읽기 전용으로 보인다(제안; 계산 없음). 이 화면의 기존 AC는 바뀌지 않는다.
- **문서 보기 개선 (DOCVIEW 2026-11-01):** 공유 문서 화면은 DOC-02의 viewer 부품을 쓰므로 목차 floating panel·연속 스크롤 PDF·PDF↔원문 동기화·쪽별 묶음·폭 조정 구분선·확정된 가져온 문제의 문제 형식(정답·해설은 접힘, 발행 문제 범위)이 같다([DOC-02-AC06–AC11](documents-editor.md)). 편집 UI는 계속 없다. 이 화면의 기존 AC는 바뀌지 않는다.

## 수용 기준

- **panel은 modal (UX9-SPEC 사용자 결정 2026-11-02, [HOMEDLG-01](home-dialogs.md)):** 공유 화면의 문제 미리보기·문서 요약·정리 노트 panel은 modal이다(처음 제안 non-modal과 다름): 열린 동안 공유 목록(문제·문서·검색 결과·정리 노트 카드)은 `inert`이고 배치는 바뀌지 않는다. 다른 문제로 옮기려면 문제 panel header의 `이전 문제`·`다음 문제`(공유 목록 순서) 또는 닫고 고른다(사용자 결정 2026-11-03). 정리 노트 각주가 여는 공유 문제 panel은 노트 위에 쌓인다. 기존 AC의 내용(조회 전용·저장 없음·차단)은 그대로이며, 목록과 panel을 함께 조작하는 test(AC01·AC03, CHNOTE-01-AC04 게스트 부분, SEARCH-01-AC11의 공유 화면 경우)는 UX9-MODAL이 고친다.

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

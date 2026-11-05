# UX10-HOME — 진입점·검색 설정·상태 필터

## 변경 위치

apps/web/src/components/workspaces/workspace-home.tsx 및 css, questions/overview/questions-overview.tsx 및 css, lib/questions/overview-{filters,data,cache}.ts, API question_overview 및 query parser. tests/e2e/questions/questions-overview.spec.ts와 기존 SEARCH-01 파일을 확인해 확장한다.

## 설계

- header 순서: 문서 버튼 → primary 문제 풀기 → 화살표 dropdown. dropdown의 시각 문구 문제는 없애고 aria-label=문제 메뉴를 유지한다. AI 질문 메뉴 항목은 삭제한다. 독립 AI launcher는 UX10-AI 정책을 따른다.
- 문제 풀기 진입은 UX10-PLAY 통합 화면이다. HOME 구현 시 기존 mock-exams 진입에 연결하고 PLAY가 최종 통합을 소유한다. 예전 practice=new&source=bank 링크는 보존한다.
- 검색창 아래 챕터·유형을 기본 펼침으로 표시한다. 위/아래 아이콘 버튼에 aria-expanded/controls를 둔다. 접어도 필터 조건은 유지한다. 상태 필터는 별도이며 접기 버튼과 hidden 조건을 제거한다.
- 상태는 초기값 전체 선택. 전체 해제는 0건이다. 기존 빈 배열=전체 해석을 UI·URL·API·cache·range parser 전체에서 분리한다. URL status 생략은 전체(기존 링크 호환), 명시 status=none은 빈 선택, 반복 status 값은 부분 선택으로 정규화한다. API도 이 의미를 명시적으로 지원한다. 빈 선택을 query에서 생략하면 안 된다.
- 상태 chip은 로컬 draft를 즉시 갱신하고 350ms 뒤 마지막 상태만 URL·요청에 반영한다. 검색·상태 변경은 하나의 최신 snapshot으로 합쳐 chapter/type 변경을 덮어쓰지 않는다. Back/Forward·Workspace 이동·unmount는 pending debounce를 취소하고 URL 기준으로 동기화한다. stale response는 무시한다.
- favorite/retry의 기존 AND/OR 의미는 바꾸지 않는다. 비어 있는 상태 선택은 해당 조건이 켜져 있어도 0건이다. 전체 선택 복원·빈 검색 안내를 제공한다.
- 장별 문제 수에서 문제 단위만 삭제한다. 접근성 이름은 n문제를 유지할 수 있다.

## 수용 기준

- UX10-HOME-AC01: header 버튼 순서·primary 배경·아이콘 전용 메뉴·AI 질문 항목 부재가 모든 권한에서 맞는다.
- UX10-HOME-AC02: 챕터·유형은 검색창 아래 기본 펼침, 접고 펼쳐도 조건 유지. 상태 filter는 항상 보인다.
- UX10-HOME-AC03: 새 방문 전체 선택·전부 해제 0건·부분 선택·재방문·URL 왕복이 UI/API/cache에서 일치한다.
- UX10-HOME-AC04: 빠른 상태 연타는 마지막 선택만 350ms 뒤 반영하고 검색 동시 입력·Back·Workspace 이동에도 stale 갱신이 없다.
- UX10-HOME-AC05: 장별 count의 시각 단위 문구가 제거되고 모바일 overflow가 없다.

## 검증·DoD

overview-filters unit(round trip·none·unknown·legacy), API contract(0건), fake timers debounce unit, 기존 overview·search E2E/trace, web/API lint·typecheck·unit. shared API 변경은 contracts 재생성. 독립 리뷰 통과·커밋·보고.

## 실행 규칙

- 이 문서의 AC를 구현 직전에 RED로 작성하고 미구현으로 실패함을 확인한 뒤 GREEN으로 만든다. AC 제목은 해당 ID로 시작한다. 기존 화면 AC는 변경된 요구만 갱신하고 나머지는 보존한다.
- 사용자 지시(2026-11-05): Task와 gpt-6.1-terra subagent를 1:1로 배정한다(effort 기본값). 독립 Codex 리뷰 통과 후 커밋하고 main thread에 보고한다. main thread가 재검증·통합·QA하며 QA 수정도 같은 모델 subagent가 수행한다.
- 구현 중 CI 실행은 생략한다. 로컬 format/lint/typecheck·관련 unit/contract/E2E는 생략하지 않는다. 모든 작업을 한 feature PR로 올려 CI GREEN까지 수정 후 develop에 병합한다. 이어 develop → main PR·병합 및 production 배포를 수행한다(사용자 승인 범위).
- 작업 브랜치·worktree를 사용하고 다른 Task scope를 수정하지 않는다. 공통 파일·migration 번호·API client 생성 충돌은 main thread에 보고한다. 공유 DB migration 적용은 main thread만 한다.
- 리뷰는 scripts/codex-review.sh --uncommitted --title "<Task ID>: <summary>"로 커밋 전에 실행한다. 수정 후 재리뷰한다. 기본 모델을 사용한다. RED 및 구현·QA 증거를 보고한다.
- semantic token·Radix·공통 FloatingSidePanel 사용, 한국어 UI, 키보드·터치 동등, reduced-motion 준수. 테스트 skip/fixme 및 API client 수동 편집 금지.

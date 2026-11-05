# UX10-DOC — 전체 높이 문서 뷰어

## 변경 위치

apps/web/src/components/documents/editor/document-viewer-layout.tsx 및 css, lib/documents/viewer-settings.ts, document page shell·공유 문서 host, 대응 test/story. PDF renderer 자체·Storage 권한·교정 로직은 기존 기능을 유지한다.

## 보기 선택

기본 mode=pdf. 원본/변환본 checkbox 두 개로 기존 pdf/text/both를 표현하므로 mode 타입을 불필요하게 바꾸지 않는다. 마지막 선택을 해제하려 하면 유지하고 '하나 이상 선택하세요' 안내를 제공한다. 기존 browser v1 설정의 명시적 mode는 유지하고 저장값 없음·손상값만 원본 기본으로 한다. hydration 전에 양쪽보기가 잠깐 나타나지 않게 한다. 저장 실패는 현재 탭 사용을 막지 않는다.

둘 다 선택하면 desktop/tablet은 기존 분할 방향·위치·비율을 유지한다. mobile <768px도 원본/변환본을 상하 분할하며 기존 한 pane 강제 규칙을 제거한다. mobile 방향은 상하로 제한하고 desktop 저장 방향을 덮어쓰지 않는다. 모바일은 50:50에서 시작해 화면 높이에 맞는 최소값으로 splitter를 제한한다. 기존 desktop의 pane 최소 200px/전체 최소 24rem을 그대로 강제해 작은 화면을 넘기지 않는다. 숨긴 pane은 mount 유지, 편집값·PDF cache·scroll·zoom을 보존한다.

## 높이·header

viewer shell은 100dvh를 채우고 pane 내부만 scroll한다. 문서 page의 title·보기 설정·PDF 도구 등 viewer 제어 header를 상단 overlay로 배치한다. 공유 sidebar와 일반 앱 header가 viewer 높이를 이중 차감하지 않도록 host도 조정한다. 문서 출처 링크·목차·교정·발행·경고가 사라지지 않게 한다.

- 마지막 상단 조작 후 3초에 header를 숨긴다. 상단 48px hotspot에 pointer 이동, hotspot tap 또는 viewer의 chrome 재표시 키보드 경로로 다시 보인다.
- touch hotspot은 PDF annotation·text 선택을 가로채지 않는다. 스크린리더용 보기 도구 표시 버튼은 접근 가능한 경로로 유지한다.
- header 내부 focus, 열린 menu/dialog, 교정 입력, 미저장 경고·중요 오류 표시 중에는 자동 숨김을 중지한다. focus 중인 요소에 hidden/inert를 적용하지 않는다.
- 숨김은 transform/opacity token, pointer-events 차단, 키보드 focus 진입 시 즉시 다시 표시. reduced-motion에서는 즉시 전환한다.
- 숨기기/표시로 PDF 재다운로드·재mount·scroll jump가 없어야 한다. timer·pointer listener는 unmount 시 해제한다. toolbar 숨김과 목차 panel 닫힘은 별개다.

## 수용 기준

- UX10-DOC-AC01: 저장값 없는 새 방문 원본만, 기존 명시 설정은 유지되며 checkbox 조합이 최소 하나를 유지한다.
- UX10-DOC-AC02: 둘 다 선택 시 mobile도 상하 동시 표시, 회전·resize 후 값/페이지/편집 내용 유지, desktop 방향은 보존된다.
- UX10-DOC-AC03: viewer가 화면 전체 높이를 채우고 작은 높이·safe area·공유 host에서도 페이지 전체의 불필요한 overflow가 없다.
- UX10-DOC-AC04: 3초 후 header 숨김, 상단 pointer/tap/keyboard로 복원되며 focus·menu·교정 중에는 사라지지 않는다.
- UX10-DOC-AC05: 목차·PDF/text sync·splitter·zoom·교정·발행·고정 revision·공유 read-only 기능이 회귀하지 않는다.

## 검증·DoD

tests/e2e/documents/documents-viewer-layout.spec.ts 및 기존 DOC-02/공유 E2E 확장. viewer-settings unit(legacy·손상·storage 차단), fake timer header unit, 모바일 pointer·splitter·viewport 검증, web lint·typecheck·unit. Chromium/WebKit, 375px·tablet·desktop 및 낮은 높이에서 확인. 독립 리뷰 통과·커밋·보고.

## 실행 규칙

- 이 문서의 AC를 구현 직전에 RED로 작성하고 미구현으로 실패함을 확인한 뒤 GREEN으로 만든다. AC 제목은 해당 ID로 시작한다. 기존 화면 AC는 변경된 요구만 갱신하고 나머지는 보존한다.
- 사용자 지시(2026-11-05): Task와 gpt-6.1-terra subagent를 1:1로 배정한다(effort 기본값). 독립 Codex 리뷰 통과 후 커밋하고 main thread에 보고한다. main thread가 재검증·통합·QA하며 QA 수정도 같은 모델 subagent가 수행한다.
- 구현 중 CI 실행은 생략한다. 로컬 format/lint/typecheck·관련 unit/contract/E2E는 생략하지 않는다. 모든 작업을 한 feature PR로 올려 CI GREEN까지 수정 후 develop에 병합한다. 이어 develop → main PR·병합 및 production 배포를 수행한다(사용자 승인 범위).
- 작업 브랜치·worktree를 사용하고 다른 Task scope를 수정하지 않는다. 공통 파일·migration 번호·API client 생성 충돌은 main thread에 보고한다. 공유 DB migration 적용은 main thread만 한다.
- 리뷰는 scripts/codex-review.sh --uncommitted --title "<Task ID>: <summary>"로 커밋 전에 실행한다. 수정 후 재리뷰한다. 기본 모델을 사용한다. RED 및 구현·QA 증거를 보고한다.
- semantic token·Radix·공통 FloatingSidePanel 사용, 한국어 UI, 키보드·터치 동등, reduced-motion 준수. 테스트 skip/fixme 및 API client 수동 편집 금지.

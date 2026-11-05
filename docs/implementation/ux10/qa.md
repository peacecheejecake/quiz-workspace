# UX10-QA — 통합 검증·PR·배포

## 책임과 순서

main thread가 각 Task의 독립 Codex 로그·커밋·실제 검증 결과를 확인하고 Task branch를 feature로 --no-ff 통합한다. agent의 완료 보고만으로 수락하지 않는다. QA에서 발견한 수정은 gpt-6.1-terra(기본 effort) 원 소유 Task agent에게 돌려보내고 독립 리뷰·커밋·재검증을 반복한다.

## 검증 matrix

| 영역 | 필수 시나리오 |
|---|---|
| 권한 | owner/editor/viewer, 보관 Workspace, shared guest, 타 Workspace |
| 환경 | 전체 AI off, 개별 flag off, fake AI on, 저장된 AI 콘텐츠 있음/없음 |
| 화면 | desktop light/dark, 375px, tablet, 짧은 높이, 회전·zoom·키보드 |
| 브라우저 | Chromium·WebKit, Pointer Events touch·mouse·keyboard |
| 데이터 | 미풀이·정답·오답·pending, revision 변경, reset 경합/재전송, 빈 범위, 5,000문제 pagination |
| 탐색 | 딥링크·새로고침·Back/Forward, modal stack·swipe·focus 복귀, debounce 중 이동 |
| 문서 | 원본/변환본/함께, mobile 상하, 저장 설정·PDF/text sync·교정·공유 |

## 실행 명령

통합 후 make fmt-check, make lint, make typecheck, make test, make contracts-check. infra가 준비된 경우 affected make test-infra·make db-test·make db-lint. affected Playwright specs를 fixtures/test.ts로 실행하고 strict phase trace를 검사한다. phase 등록은 RED/GREEN과 동시에 조정한다. visual/a11y는 기존 suite를 재사용하고 신규 상태를 확장한다. 실제 정답·토큰·사용자 문서를 trace/screenshot에 남기지 않는다. CI는 여기서 사전 실행하지 않는다.

## 최종 visual baseline 배치

모든 UI/HOME/PLAY/AI/DOC 변경 통합 후 terra QA 수정 agent가 지정 Linux renderer에서 baseline을 한 번에 갱신하고 main thread가 결과 이미지를 검토한다. 기능 Task 리뷰 중 이 단계의 미갱신 baseline P2는 UX10-QA 후속으로 기록하며 기능 결함·실패 테스트를 이 단계로 숨기지 않는다. PR CI 전에는 이 후속까지 완료해야 한다. DOC 예약 ID는 document-editor, document-viewer-outline-open, document-viewer-outline-collapsed, document-viewer-vertical-text-first(desktop/iPad)이며 공통 버튼·홈·풀이 변경에 따른 다른 baseline도 실제 diff로 확인한다. baseline 삭제/skip으로 GREEN을 만들지 않는다.

## 수용 기준·DoD

- UX10-QA-AC01: 모든 Task AC와 기존 영향 화면 AC가 GREEN이며 독립 리뷰 P0/P1 미해결이 없다.
- UX10-QA-AC02: main thread 재검증·QA matrix 결과와 제한을 기록하고 위조된 GREEN/skip이 없다.
- UX10-QA-AC03: feature → develop PR 하나로 전체 feature를 검증, CI 실패는 해당 agent 수정·review·push로 GREEN까지 해결한다. develop 직접 push 금지.
- UX10-QA-AC04: GREEN PR을 develop에 병합하고 develop → main PR도 필요한 CI GREEN 후 병합한다. main/develop 직접 push 및 역방향 merge 금지.
- UX10-QA-AC05: docs/deployment.md·runbook-deploy.md의 현재 절차를 읽고 production migration·서비스 rollout·health/smoke를 검증한다. 배포 실패 시 기존 rollback 절차를 따른다. AI feature flag를 임의 활성화하지 않는다.

사용자는 이번 요청에서 feature push·PR 생성·CI 수정·develop/main 병합·production 배포를 승인했다. 실제 배포에 필요한 계정/자격 증명이 없으면 준비 가능한 부분을 마치고 구체적 차단 사유를 보고한다. 완료 보고에는 PR·CI·배포 링크와 smoke 결과를 남긴다.

## 실행 규칙

- 이 문서의 AC를 구현 직전에 RED로 작성하고 미구현으로 실패함을 확인한 뒤 GREEN으로 만든다. AC 제목은 해당 ID로 시작한다. 기존 화면 AC는 변경된 요구만 갱신하고 나머지는 보존한다.
- 사용자 지시(2026-11-05): Task와 gpt-6.1-terra subagent를 1:1로 배정한다(effort 기본값). 독립 Codex 리뷰 통과 후 커밋하고 main thread에 보고한다. main thread가 재검증·통합·QA하며 QA 수정도 같은 모델 subagent가 수행한다.
- 구현 중 CI 실행은 생략한다. 로컬 format/lint/typecheck·관련 unit/contract/E2E는 생략하지 않는다. 모든 작업을 한 feature PR로 올려 CI GREEN까지 수정 후 develop에 병합한다. 이어 develop → main PR·병합 및 production 배포를 수행한다(사용자 승인 범위).
- 작업 브랜치·worktree를 사용하고 다른 Task scope를 수정하지 않는다. 공통 파일·migration 번호·API client 생성 충돌은 main thread에 보고한다. 공유 DB migration 적용은 main thread만 한다.
- 리뷰는 scripts/codex-review.sh --uncommitted --title "<Task ID>: <summary>"로 커밋 전에 실행한다. 수정 후 재리뷰한다. 기본 모델을 사용한다. RED 및 구현·QA 증거를 보고한다.
- semantic token·Radix·공통 FloatingSidePanel 사용, 한국어 UI, 키보드·터치 동등, reduced-motion 준수. 테스트 skip/fixme 및 API client 수동 편집 금지.

## 최종 로컬 QA 결과 — 2026-11-05

각 Task 및 QA 수정은 terra 담당자가 구현하고 독립 Codex 리뷰 후 커밋했으며, main이 통합하고 검증을 다시 실행했다. 전체 lint/format, TypeScript·Python typecheck(374 sources), 웹 1,365·UI 446·Python 2,655 단위 테스트, 실제 infra 1,036, pgTAP 1,204, db lint가 통과했다. strict trace는 46개 화면·286개 screen AC와 AUTH API AC 3개에 orphan/focus/skip이 없음을 확인했다.

전체 변경 범위 Chromium/WebKit 실행의 최초 246건 중 8건은 기존 API barrier/상태 버튼·재진입 fixture와 PDF reflow 문제였으며, 수정 후 범위/PLAY 전체 34건·문서 전체 40건으로 재검증했다. AI 통합 34건, 접근성 전체 최초 29/30 뒤 ASK/모의고사 후속 11건, Workspace 생성 각 엔진 3회 반복도 통과했다. 리셋·재연습·권한/소유자·계정 변경·public share·리셋 후 늦은 응답도 검증했다.

Linux app desktop/iPad 24건과 Storybook 26건을 main이 기준 이미지 갱신 없이 비교했다. 변경 PNG 147장과 footer 후속 12장의 before/after, 합성 RETURN 모바일/전체화면 이미지를 직접 검토했다. 최종 baseline 커밋은 8346762f다. 로그 감사의 실제 복귀 시나리오 10건은 API·web·worker 로그 유출 0건이며, artifact 감사도 공유 비밀 유출 0건이다.

공유 로컬 스택은 기존 데이터/ERRATA 이력을 보존하고 새 20261106100000·20261106110000을 추가 적용했다. 기존 누락 baseline인 20261105090000도 앞서 별도로 적용했으며 migration 이력은 재작성하지 않았다. 중간 DB 연결 포화(99/100)는 완료된 본 작업 worker의 정확한 PID를 확인해 정상 종료하여 해소했고, 실패한 이미지 검사는 전부 다시 통과했다. 기존 WebKit Workspace 생성 1건은 원인 미확정이나 변경 없는 clean production 반복 검증은 통과했다. PR CI가 이 로컬 QA의 다음 단계이며, CI 결과와 develop/main 병합·배포 결과는 해당 PR과 실행 기록으로 확인한다.

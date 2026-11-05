# UX10 — 구현 기준 및 실행 계획

상태: 구현 착수 기준 · 2026-11-05. 사용자 요청과 후속 결정이 기존 명세의 아래 변경 부분에 우선한다. 기존 보안·권한·데이터 격리 규칙은 유지한다. 이 문서 묶음은 실행용 설계이며 main thread는 구현 brief에 해당 Task 문서를 반드시 포함한다.

## 확정 결정

1. 문제 풀기·모의고사는 화면과 진입점을 통합한다. 은행 문제 풀이는 기존 question_attempts/question_user_states, 생성된 모의고사는 mock_exam_attempts를 쓴다.
2. 리셋은 본인의 해당 은행 문제 풀이 기록과 Heatmap 상태까지 초기화한다. 단순 새 세션 생성이 아니다. 감사·참조 무결성을 위해 immutable 원본 attempt는 유지하되 reset epoch 이전 기록은 사용자 기록·집계에서 제외한다.
3. 문서 보기 기본은 원본. 두 checkbox로 보기 영역을 선택하며 둘 다 선택하면 모바일도 상하 분할한다(최종 사용자 결정). 모두 해제는 금지한다.
4. 보기 순서 기본은 원본 순서다. 문제 순서 무작위와 보기 섞기는 별도 개념이다.
5. 저장된 AI 해설은 기본 펼침. 없는 해설을 자동 생성하지 않는다. 지정된 AI 해설 전송 안내만 삭제하며 다른 기능의 안내를 일괄 삭제하지 않는다.
6. 기능이 꺼지면 AI 동작은 숨긴다. 저장된 콘텐츠 읽기와 신규 생성 권한은 분리한다.

## Task·의존·소유 범위

| Task | 문서 | 의존 | 소유 범위 |
|---|---|---|---|
| UX10-SPEC | [명세 정합성](spec.md) | 없음 | docs, 실행 계획 |
| UX10-UI | [공통 UI](ui.md) | SPEC | packages/ui, ask-icons.tsx |
| UX10-QVIEW | [문제 보기](qview.md) | SPEC | practice API/repository, migrations, practice-viewer 및 관련 모델·테스트 |
| UX10-HOME | [홈](home.md) | UI·QVIEW | workspace-home, questions-overview, overview 필터 API·모델 |
| UX10-PLAY | [풀이 통합](play.md) | UI·QVIEW·HOME | mock-exams, sequence-viewer, range picker, practice run 결과 API |
| UX10-AI | [AI 가용성](ai.md) | PLAY | AI launcher·explanation·notes, capability 전달, 환경별 테스트 |
| UX10-DOC | [문서 뷰어](doc.md) | UI | document-viewer-layout, viewer-settings, 문서 페이지 shell·공유 문서 |
| UX10-QA | [통합 QA](qa.md) | 전체 구현 | 교차 검증·테스트, 수정은 원 소유 Task agent |

통합 순서는 UI → QVIEW → HOME → PLAY → AI이며 DOC는 UI 뒤에 통합한다. 파일 scope가 겹치지 않는 UI/QVIEW/DOC는 SPEC 기준 독립 worktree에서 먼저 구현할 수 있으나, 의존 Task 통합 뒤 반드시 재검증한다. scope가 겹치면 직렬로 수행한다. migration·OpenAPI 생성물·trace registry·CI phase는 통합자가 조정한다.

## 기존 명세 변경 매핑

| 원본 | UX10에서 바꾸는 요구 |
|---|---|
| QPLAY-01 / QVIEW-01 / questions.md | 보기 순서, 제출 이력이 있는 문제 열기, 리셋, 결과 O/X |
| QOV-01 / SEARCH-01 | header 진입점, 필터 기본값·접기·debounce·빈 선택 |
| MOCK-01 / QVIEW-01 | 통합 화면, 변형 0개 경로, 전체 범위, 단계 표시·폼·결과 묶음 |
| ASK-01 / AIEXPL-01 / CHNOTE-01 | AI 가용성, 지정 안내 삭제, 기존 해설 펼침 |
| design-system / HOMEDLG-01 / overlay-scroll | 버튼 테두리, 아이콘, 스와이프 닫기 |
| DOCVIEW-01 / DOC-02 / WS-VIEW-01 | 원본 기본, checkbox, 모바일 함께 보기, header overlay |

## AC와 검증 등록

각 Task 문서의 UX10-*-ACxx는 구현용 수용 기준이다. RED 착수 시 기존 screens 명세의 해당 절에 기준과 linked_tests/phase를 반영하고 scripts/e2e-trace.ts registry를 갱신한다. 현 시점은 테스트 작성 전이므로 기존 AC 개수·CI phase 숫자를 임의 증가시키지 않는다. 새 AC 등록과 테스트가 같은 RED Task에서 대응돼야 한다. 전체 RED를 선행 일괄 작성하지 않는다.

## 실행 규칙

- 이 문서의 AC를 구현 직전에 RED로 작성하고 미구현으로 실패함을 확인한 뒤 GREEN으로 만든다. AC 제목은 해당 ID로 시작한다. 기존 화면 AC는 변경된 요구만 갱신하고 나머지는 보존한다.
- 사용자 지시(2026-11-05): Task와 gpt-6.1-terra subagent를 1:1로 배정한다(effort 기본값). 독립 Codex 리뷰 통과 후 커밋하고 main thread에 보고한다. main thread가 재검증·통합·QA하며 QA 수정도 같은 모델 subagent가 수행한다.
- 구현 중 CI 실행은 생략한다. 로컬 format/lint/typecheck·관련 unit/contract/E2E는 생략하지 않는다. 모든 작업을 한 feature PR로 올려 CI GREEN까지 수정 후 develop에 병합한다. 이어 develop → main PR·병합 및 production 배포를 수행한다(사용자 승인 범위).
- 작업 브랜치·worktree를 사용하고 다른 Task scope를 수정하지 않는다. 공통 파일·migration 번호·API client 생성 충돌은 main thread에 보고한다. 공유 DB migration 적용은 main thread만 한다.
- 리뷰는 scripts/codex-review.sh --uncommitted --title "<Task ID>: <summary>"로 커밋 전에 실행한다. 수정 후 재리뷰한다. 기본 모델을 사용한다. RED 및 구현·QA 증거를 보고한다.
- semantic token·Radix·공통 FloatingSidePanel 사용, 한국어 UI, 키보드·터치 동등, reduced-motion 준수. 테스트 skip/fixme 및 API client 수동 편집 금지.

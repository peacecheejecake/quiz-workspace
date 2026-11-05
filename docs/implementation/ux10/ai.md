# UX10-AI — 환경별 가용성·AI 해설 펼침

## 변경 위치

apps/web/src/components/{ask,questions/ai-explanation,notes} 및 각 launcher/call site, workspace-home의 capability 전달, mock-exam-form AI 선택지. apps/api 설정·기능 metadata 응답을 필요한 범위에서 확장한다. env secret을 browser로 보내지 않는다.

## 설계

- server capability를 단일 판단 근거로 사용한다. 전역 LLM 가용성과 각 feature flag/권한을 함께 검사한다. askEnabled, canGenerateExplanation, canGenerateNotes, canGenerateMockVariations 등 실제 기존 capability에 맞춰 이름을 정리한다.
- LLM이 꺼지면 AI 질문·AI 해설 생성/다시 만들기·AI 노트 생성/다시 만들기·AI 변형 선택·AI 질문 CTA를 숨긴다. 비활성 버튼으로 남기지 않는다. 단순 보기 섞기·bank 풀기·문서 보기·기존 검색 기능은 동작한다.
- 저장된 AI 해설/노트 읽기는 기능의 기존 read 권한을 유지한다. LLM이 꺼져 있어도 이미 허용된 저장 콘텐츠 열람을 막지 않는다. 기능 데이터 자체를 제공하지 않는 환경에서는 빈 생성 UI도 표시하지 않는다. 새 AI 생성은 직접 API 요청에도 기존 서버 409/권한 경계를 유지한다.
- QuestionViewer의 submitted/current result·manage·read-only에서 읽을 수 있는 기존 AI 해설이 있으면 기본 펼침으로 표시한다. 정답 비노출 mode에서는 존재 여부를 이유로 제출 전 본문을 fetch하지 않는다. 해설 없음은 생성 버튼만(가용 시), 자동 LLM 호출 없음. 문제/revision 이동 시 펼침 상태와 async 응답을 scope로 분리한다.
- 정확히 '문제와 정답, 관련 교재 구절이 AI 서비스로 전송됩니다.' 문구와 사용하지 않는 상수를 삭제한다. mock 생성·노트 생성 등 다른 안내는 이번 요청으로 삭제하지 않는다.
- 독립 AI launcher·question CTA·mock management·공유 화면·보관 Workspace 등 모든 call site를 목록화해 검증한다. HOME이 제거한 메뉴 항목을 되살리지 않는다.

## 수용 기준

- UX10-AI-AC01: 전역 LLM off 또는 개별 기능 off 환경에서 해당 신규 AI 버튼/선택지가 DOM·접근성 tree에 없고 일반 풀이·보기 섞기는 사용 가능하다.
- UX10-AI-AC02: 저장된 해설을 제출 후/관리 화면에서 즉시 펼쳐 읽을 수 있고 없는 해설은 자동 생성되지 않는다.
- UX10-AI-AC03: 지정 문구가 삭제되고 제출 전/다른 사용자/다른 revision의 해설이 노출되지 않는다.
- UX10-AI-AC04: on/off·권한·보관·공유 matrix와 직접 API 우회 요청이 기존 권한 규칙을 지킨다.

## 검증·DoD

tests/e2e/questions/ai-explanations.spec.ts 등 실제 기존 ASK/EXPL/CHNOTE test 경로 확인 후 확장. feature matrix unit·API contract·fake LLM 호출 횟수 0 검증, web/API lint·typecheck·unit. 환경 flag 활성화나 real LLM 호출은 필요하지 않다. 독립 리뷰 통과·커밋·보고.

## 실행 규칙

- 이 문서의 AC를 구현 직전에 RED로 작성하고 미구현으로 실패함을 확인한 뒤 GREEN으로 만든다. AC 제목은 해당 ID로 시작한다. 기존 화면 AC는 변경된 요구만 갱신하고 나머지는 보존한다.
- 사용자 지시(2026-11-05): Task와 gpt-6.1-terra subagent를 1:1로 배정한다(effort 기본값). 독립 Codex 리뷰 통과 후 커밋하고 main thread에 보고한다. main thread가 재검증·통합·QA하며 QA 수정도 같은 모델 subagent가 수행한다.
- 구현 중 CI 실행은 생략한다. 로컬 format/lint/typecheck·관련 unit/contract/E2E는 생략하지 않는다. 모든 작업을 한 feature PR로 올려 CI GREEN까지 수정 후 develop에 병합한다. 이어 develop → main PR·병합 및 production 배포를 수행한다(사용자 승인 범위).
- 작업 브랜치·worktree를 사용하고 다른 Task scope를 수정하지 않는다. 공통 파일·migration 번호·API client 생성 충돌은 main thread에 보고한다. 공유 DB migration 적용은 main thread만 한다.
- 리뷰는 scripts/codex-review.sh --uncommitted --title "<Task ID>: <summary>"로 커밋 전에 실행한다. 수정 후 재리뷰한다. 기본 모델을 사용한다. RED 및 구현·QA 증거를 보고한다.
- semantic token·Radix·공통 FloatingSidePanel 사용, 한국어 UI, 키보드·터치 동등, reduced-motion 준수. 테스트 skip/fixme 및 API client 수동 편집 금지.

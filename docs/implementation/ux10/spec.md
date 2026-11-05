# UX10-SPEC — 명세 정합성 및 실행 인계

## 범위·완료 조건

이 묶음 8개 Task 문서를 작성하고 원본 설계에 우선 적용 링크, implementation-plan의 Task·결정·진행, docs 인덱스를 연결한다. 앱 코드는 수정하지 않는다. 구현 AC와 후보 파일·계약·검증을 문서화한다. 기존 문서의 변경되지 않은 요구는 유지한다.

## 인계 절차

1. main thread가 Task 문서와 실제 HEAD를 읽고 scope·AC·DoD·검증 명령을 brief로 전달한다.
2. 해당 Task의 RED 단계에서 screens와 trace registry를 갱신한다. 기존 AC와 중복이면 기존 AC를 개정하고 신규 ID와 대응을 문서에 남긴다.
3. Task 완료 보고에는 변경 파일, RED 실패 이유, GREEN 명령 결과, 리뷰 로그, 커밋, 미해결 항목을 넣는다.
4. 독립 리뷰 지적 P0/P1은 반드시 수정한다. P2/P3도 이번 요구 충족에 필요하면 수정한다. QA를 포함해 미완료를 완료로 표시하지 않는다.

## 검증

Markdown 상대 링크가 존재하는지 확인하고 prettier --check를 수행한다. 구현 테스트를 실행했다는 상태를 문서만으로 기록하지 않는다. 계획·문서 완료와 기능 완료를 별도 관리한다.

## 실행 규칙

- 이 문서의 AC를 구현 직전에 RED로 작성하고 미구현으로 실패함을 확인한 뒤 GREEN으로 만든다. AC 제목은 해당 ID로 시작한다. 기존 화면 AC는 변경된 요구만 갱신하고 나머지는 보존한다.
- 사용자 지시(2026-11-05): Task와 gpt-6.1-terra subagent를 1:1로 배정한다(effort 기본값). 독립 Codex 리뷰 통과 후 커밋하고 main thread에 보고한다. main thread가 재검증·통합·QA하며 QA 수정도 같은 모델 subagent가 수행한다.
- 구현 중 CI 실행은 생략한다. 로컬 format/lint/typecheck·관련 unit/contract/E2E는 생략하지 않는다. 모든 작업을 한 feature PR로 올려 CI GREEN까지 수정 후 develop에 병합한다. 이어 develop → main PR·병합 및 production 배포를 수행한다(사용자 승인 범위).
- 작업 브랜치·worktree를 사용하고 다른 Task scope를 수정하지 않는다. 공통 파일·migration 번호·API client 생성 충돌은 main thread에 보고한다. 공유 DB migration 적용은 main thread만 한다.
- 리뷰는 scripts/codex-review.sh --uncommitted --title "<Task ID>: <summary>"로 커밋 전에 실행한다. 수정 후 재리뷰한다. 기본 모델을 사용한다. RED 및 구현·QA 증거를 보고한다.
- semantic token·Radix·공통 FloatingSidePanel 사용, 한국어 UI, 키보드·터치 동등, reduced-motion 준수. 테스트 skip/fixme 및 API client 수동 편집 금지.

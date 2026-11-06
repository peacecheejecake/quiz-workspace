# UX10-QVIEW — 원래 보기 순서·기존 결과 열기·리셋

## 변경 위치

apps/api/src/quiz_api/api/{practice,mock_practice,practice_runs}.py, repositories/practice.py 및 관련 repository/DTO, practice_grading.py; apps/web/src/components/questions/viewer/{practice-viewer,practice-model,question-viewer}.tsx(ts), lib/questions/practice-*; BFF 및 additive migration·pgTAP. 생성 client는 make contracts로 갱신한다. AI 해설 실제 펼침·안내는 UX10-AI 소유.

## 보기 순서·탐색

세션 생성 요청에 명시적 shuffle_options=false 기본값을 둔다. false는 revision.options 순서 그대로 displayed_option_ids를 저장하며 true만 seed로 섞는다. bank와 mock의 새 세션 모두 적용한다. 이미 열린 세션은 저장된 순서를 유지한다. option ID 기준 채점은 불변이다. 이전·다음은 ArrowLeft/ArrowRight 아이콘 버튼, 접근성 이름 유지, 제출과 동일 높이·touch target. 양 끝 비활성 동작과 키보드 규칙은 보존한다.

## 이미 푼 문제 열기

**캐시 정합성 결정(UX12-OPEN 개정):** Heatmap을 명시적으로 열 때는 서버의 recent/epoch metadata를 먼저 확인한다. 캐시가 있어도 다른 run·탭·기기에서 완료된 풀이를 놓치면 안 된다. 미제출 session의 내용·TTL·200개 제한·비저장은 유지하고, 확인 후 아직 유효하면 같은 session을 재사용한다. 확인과 재사용·새 session 열기는 `POST /api/v1/questions/:id/practice-open` 한 호출, 한 트랜잭션으로 처리한다([ux12-question-open.md](../../screens/ux12-question-open.md)). 기존 UX7의 추가 HTTP 0회 기준은 이 호출 하나만 예외로 개정한다. 확인 전에는 캐시 답 입력으로 제출할 수 없게 한다. 강제 새 풀이도 epoch는 확인하되 이전 결과 대신 새 미제출 session을 연다.

Heatmap의 practice 모드에서는 서버가 본인·해당 문제·현재 reset epoch에서 최신 제출 session을 찾아 결과를 제공한다. 현재 revision과 일치하는 결과만 현재 문제 정답으로 표시한다. revision이 달라졌으면 새 문제 상태로 열고 지난 풀이 안내/이력 링크를 제공한다. pending 결과는 정답/오답으로 위조하지 않는다. 새 미제출 session 응답에는 정답·해설이 없다. sequence는 해당 run session 기준 결과만 표시하며 다른 run의 답을 재사용하지 않는다. 서버 경계에서 membership·session owner를 검사한다.

## 리셋 계약

- 대상은 은행 문제 하나에 대한 현재 사용자의 전체 개인 풀이 기록·학습 상태다. mock 기록·다른 사용자·문제 본문·AI 캐시·개인 하이라이트는 유지한다. favorite/retry를 포함한 question_user_states는 미열람 기본값으로 초기화한다.
- 제안 endpoint POST /api/v1/questions/:id/practice-reset (BFF 동일 의미). 본문에서 user_id를 받지 않는다. JWT sub와 workspace membership을 재검증한다. 보관 Workspace는 쓰기 거부, 삭제·타 Workspace는 404.
- 확인 dialog에 기록·Heatmap 초기화를 명시한다. 성공 시 panel을 닫고 Heatmap을 미열람으로 갱신한다. 새 세션 자동 생성으로 viewed가 즉시 복구되면 안 된다. 다음에 열면 새 미제출 session이다.
- additive reset epoch(또는 동등한 reset event)로 이전 immutable attempt를 사용자 이력·최근 결과·집계에서 제외한다. 물리 attempt 삭제로 FK·감사 기록을 깨지 않는다. 초기화는 사용자에게 전체 기록 삭제와 동일하게 보인다.
- reset과 submit/self-grade/session 생성은 동일 사용자·문제 잠금 순서로 직렬화한다. 오래된 세션·in-flight 요청은 reset 이후 제출/재노출 불가(409 practice-session-reset). reset은 idempotency key로 재전송 안전성을 보장한다.
- 기존 bank practice run의 reset 이전 해당 item은 결과 API에서 정답·시도 기록을 재노출하지 않고 초기화됨으로 표시한다. 그 위치 재개는 새 run 안내를 제공하고 다른 문제의 결과는 유지한다. run summary 집계도 해당 기록을 제외한다. 새로운 run은 새 epoch를 사용한다.
- client의 session·overview·history·result 캐시를 무효화한다. 다른 탭의 오래된 submit도 서버에서 거절한다. 원본 attempt를 내부 보관하는 정책을 API/DB 주석과 운영 문서에 명시한다.

## 수용 기준

- UX10-QVIEW-AC01: Heatmap에서 미풀이 문제를 열면 원본 보기 순서이며 새로고침·재접속도 동일 설정이다. explicit shuffle만 섞고 ID 채점은 같다.
- UX10-QVIEW-AC02: 이전·다음 화살표가 제출과 높이가 같고 label·양 끝 비활성이 정확하다.
- UX10-QVIEW-AC03: 이미 푼 문제 재열기에서 본인의 결과·정답·해설이 즉시 보인다. 다른 사용자·다른 revision·미제출 payload로 정답이 유출되지 않는다.
- UX10-QVIEW-AC04: 리셋 확인 후 기록·Heatmap 상태가 초기화되고 새로고침·다른 탭·이력·기존 run 결과에서도 이전 답이 복구되지 않는다. 취소는 무변경이다.
- UX10-QVIEW-AC05: reset/submit 경합·idempotent 재전송·보관·cross-workspace 요청을 서버가 일관되게 처리한다.

## 검증·DoD

tests/e2e/questions/{questions-practice,question-viewer}.spec.ts에 기존 경로를 확인해 AC 추가. tests/integration/questions/practice 아래 계약 테스트, repository 실제 DB 테스트 및 pgTAP로 epoch·경합·격리 검증. make contracts-check, API/web unit·lint·typecheck, affected E2E GREEN. migration은 적용된 production 최댓값 뒤 번호, 공유 DB 검증은 짧은 rollback transaction. 독립 리뷰 통과 후 커밋한다.

## 실행 규칙

- 이 문서의 AC를 구현 직전에 RED로 작성하고 미구현으로 실패함을 확인한 뒤 GREEN으로 만든다. AC 제목은 해당 ID로 시작한다. 기존 화면 AC는 변경된 요구만 갱신하고 나머지는 보존한다.
- 사용자 지시(2026-11-05): Task와 gpt-6.1-terra subagent를 1:1로 배정한다(effort 기본값). 독립 Codex 리뷰 통과 후 커밋하고 main thread에 보고한다. main thread가 재검증·통합·QA하며 QA 수정도 같은 모델 subagent가 수행한다.
- 구현 중 CI 실행은 생략한다. 로컬 format/lint/typecheck·관련 unit/contract/E2E는 생략하지 않는다. 모든 작업을 한 feature PR로 올려 CI GREEN까지 수정 후 develop에 병합한다. 이어 develop → main PR·병합 및 production 배포를 수행한다(사용자 승인 범위).
- 작업 브랜치·worktree를 사용하고 다른 Task scope를 수정하지 않는다. 공통 파일·migration 번호·API client 생성 충돌은 main thread에 보고한다. 공유 DB migration 적용은 main thread만 한다.
- 리뷰는 scripts/codex-review.sh --uncommitted --title "<Task ID>: <summary>"로 커밋 전에 실행한다. 수정 후 재리뷰한다. 기본 모델을 사용한다. RED 및 구현·QA 증거를 보고한다.
- semantic token·Radix·공통 FloatingSidePanel 사용, 한국어 UI, 키보드·터치 동등, reduced-motion 준수. 테스트 skip/fixme 및 API client 수동 편집 금지.

## 최종 QA: 잠금과 성능 예산

리셋 관련 읽기는 autocommit으로 실행하지 않는다. 트랜잭션 advisory lock 획득과 대기 후 epoch snapshot 조회는 별도 statement로 유지한다. 불필요한 epoch 행 생성·중복 조회 제거 및 안전한 조회 병합 후 상한은 세션 열기 10·제출 6·session GET 6·my-state PATCH 9 DB 왕복이다. 이전 row-lock 없는 GET 전제의 PERF-1 기준은 이 네 경로에 한해 대체한다(구현 계획 §7). 다른 상한·권한 검사·revision/alias/epoch fencing·실제 동시성 검증은 유지한다.

# UX11-RETURN — 다시 풀기 및 보던 문제로 돌아가기

## 확정 요구

- 문제 풀기에 다시 풀기 버튼을 제공한다. 사용자 확정 단위는 **현재 문제만 새 시도, 기존 기록 유지**다. 범위 풀이·모의고사의 **기존 회차 점수·결과는 유지**하고, 다시 푼 현재 문제는 **별도 연습으로 기록**한다. UX10의 기록·Heatmap 초기화와 별개의 동작이며, 명시 승인 없이 시도 기록을 삭제하지 않는다. 원래 sequence의 위치를 재제출하거나 결과를 덮어쓰지 않는다. 별도 연습 session/run 관계를 설계·명세화하고 immutable 과거 시도는 보존한다. bank 연습은 bank 기록, mock 연습은 mock 기록에 남겨 bank·Heatmap에 mock 문제가 섞이지 않게 한다.
- 문제 보기에서 벗어나면 하단 global floating `보던 문제로 돌아가기`와 X 닫기 버튼을 제공한다. 다시 누르면 마지막 question 또는 run의 같은 위치로 복귀한다. 원래 화면에 있는 동안은 숨긴다. X는 floating 표시만 닫고 풀이·기록을 초기화/종료하지 않는다. 다음 명시적 풀이 진입/새 위치 활동 때 다시 대상 갱신 가능.

## 회차 문항의 별도 연습 API

현재 본인 회차에서 읽을 수 있는 문항은 현재 목록에서 빠진 과거 mock generation 문항도 별도 연습할 수 있어야 한다. 기존 일반 mock standalone endpoint의 현재 목록 검증은 완화하지 않는다. `POST /practice-runs/{run_id}/items/{position}/retry-session`처럼 본인 회차를 근거로 하는 좁은 생성 경로를 추가한다(기존 DTO·생성 helper 재사용 우선).

- JWT 사용자 소유 run → workspace membership/보관 여부 → 고정 위치와 원본 문항·generation을 서버가 재검증한다. 클라이언트의 question/user/workspace 식별자로 권한을 대체하지 않는다. 다른 사용자·workspace·삭제/제거되어 기존 회차에서도 unavailable인 문항은 거절한다.
- 생성 session의 practice_run_id/run_position은 비워 원 회차를 재제출하지 않는다. bank/mock 기존 시도 저장소·채점 경로를 유지하며 fresh idempotency key, bank reset epoch·stale/replay 검증을 재사용한다. reset 뒤 옛 idempotency 결과를 다시 노출하지 않는다. 기존 scoring linkage와 구별되는 durable retry origin(run ID·position)을 mock session에 보존하는 additive migration을 허용한다. 이력이 만료되는 idempotency 저장소로 권한 근거를 대체하지 않는다. 생성·읽기/제출/자기채점에서 origin의 소유자·Workspace·source·generation·문항/위치를 재검증하고 기존 일반 standalone의 shown 정책은 유지한다.
- 기존 source의 old-generation read eligibility만 사용하고 현재 목록 정책을 전역 완화하지 않는다. 과거 generation이지만 원 run에서 available인 문항의 성공·정답 선노출 없음·원 결과 불변, 다른 run 소유자/namespace 거절, 실제 삭제·제거의 거절을 계약 테스트한다. OpenAPI/client는 make contracts로 생성한다.

## 복귀 상태·보안

단일 사용자·탭에서 마지막 유효 대상 하나를 보관한다. workspace/question/run/position 등 최소 식별자와 allowlist route만 저장하고 정답·발문·JWT·signed URL·전체 URL을 저장하지 않는다. 기본은 인증 layout에 유지되는 메모리 provider; 새로고침 영속 여부는 구현자가 제안하고 main 확인 후 적용한다. 계정 변경/로그아웃 시 제거한다. auth/share public 화면에서 표시하지 않는다. 접근 불가·삭제·reset된 run은 서버가 재검증하고 복귀 실패 시 대상 정리·안내한다.

Floating은 safe area·작은 화면·키보드·다른 modal과 겹침을 검증한다. 기존 semantic Button/IconButton 및 z-index tokens 사용, X 접근성 이름과 44px touch target. fullscreen 문서의 shell inert 정책과 충돌하지 않도록 명시적 global-control portal 계약을 DOC agent와 조율한다. 다른 modal 위로 focus를 탈출시키지 않는다.

## 구현·검증

활성 PracticeViewer/SequenceViewer는 UX10-QVIEW·PLAY 소유권 인계 뒤 연결한다. AppShell/auth layout의 복귀 provider·floating component·상태 모델은 별도 scope로 먼저 개발할 수 있다. 이전 위치·다른 문서/Workspace 이동·뒤로가기·X·새 풀이·완료/삭제/권한 상실·로그아웃/계정 변경·touch/keyboard 및 modal 순서를 테스트한다.

AC: UX11-RETURN-AC01 확정 단위의 다시 풀기와 기록 보존; AC02 이탈 후 global 복귀·같은 위치 재개; AC03 X는 표시만 닫고 새 활동 시 갱신; AC04 사용자·권한·URL/저장 경계; AC05 작은 화면·문서 fullscreen·다른 modal·접근성. RED에서 dedicated screen·phase·E2E 경로 등록, 계약·단위·브라우저 검증, 독립 리뷰 후 커밋한다.

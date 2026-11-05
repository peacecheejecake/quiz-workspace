# UX10-PLAY — 문제 풀기·모의고사 통합 및 이름 수정

## 변경 위치

apps/web/src/components/questions/mock-exams/{mock-exams-panel,mock-exam-form,mock-exam-model,mock-exam-detail,mock-run}.tsx(ts), viewer/{sequence-viewer,question-range-picker}, lib/questions/practice-runs; practice_runs 결과 API/DTO·BFF, 필요 시 mock config 검증, rename-field. WorkspaceHome header의 primary 풀기 버튼·순서·QuestionMenu 정리 및 onBankStarted 연결도 PLAY가 소유한다(2026-11-05 HOME에서 인계). HOME의 필터 draft·상태·AI header guard는 수정하지 않는다. AC01은 deep link만으로 검증하지 않고 실제 홈 primary 버튼을 눌러 통합 화면과 bank/mock 시작까지 확인한다.

## 화면·기록 경계 — 최종 사용자 변경

- **최종 사용자 결정: 문제 풀기·모의고사 화면·진입점 통합을 다시 추진한다.** 홈 primary 풀기 버튼에서 통합 화면으로 진입하고 기존 문제 그대로 풀기와 변형 출제를 선택한다. 기존 bank/mock 데이터·권한·기록은 각각 유지하며 예전 딥링크·Back/Forward도 지원한다.
- 변형을 아무것도 선택하지 않으면 원본 문제를 practice_runs source=bank로 실행한다. 보기 섞기만 또는 AI 변형을 선택하면 기존 mock 생성·풀기 경로를 사용한다. 변형 0개를 기존 mock API에 보내지 않으며 mock variation_types nonempty 계약은 유지한다. bank를 불필요하게 mock으로 복사하지 않는다.
- 기존 모의고사 목록·상세·생성·풀기도 통합 화면 안에서 접근한다. 기존 모의고사 설정 바꾸기에서 변형 0개 선택은 새 bank 풀이 안내로 연결하고 기존 모의고사를 덮어쓰지 않는다. 보기 권한의 bank 풀이와 mock 만들기 editor 권한 구분, 보관 Workspace 제출 금지는 유지한다.
- 모의고사 목록 및 상세의 이름 수정 UI는 입력 아래 동작 줄에 저장·취소를 함께 표시한다. 편집 중 같은 모의고사의 풀기 버튼은 native disabled로 렌더링하고 menu/keyboard로도 시작할 수 없게 한다. 다른 모의고사는 영향을 받지 않는다.
- 저장 성공·취소 후 풀기는 원래 가용 상태로 복구한다. 저장 중은 중복 저장/취소 경합을 방지하고, 저장 실패는 입력·편집 상태·풀기 disabled를 유지하며 alert를 표시한다. Enter 저장·Escape 취소·focus 복귀를 유지한다.

## 범위·폼

변형 0개 및 보기 섞기만 선택했을 때 모두 전체 범위를 제공한다. 문항 수의 전체 범위 선택은 범위 picker의 전체 선택 checkbox와 다른 개념이며 label로 구분한다. 0개 결과는 시작 불가. bank는 기존 **선택 후보 범위 5,000개 상한**을 유지한다. question_count로 일부만 풀더라도 후보 범위가 5,000개를 넘으면 기존과 같이 422로 거절하며, 이번 Task에서 대규모 범위 해석 용량을 확대하지 않는다. 문항 수 null/생략은 전체, 지정 수는 1~5,000 및 후보 수 이하로 검증한다. 무작위 순서가 꺼지면 Heatmap 순서의 앞 N개, 켜지면 seed로 후보를 섞은 뒤 앞 N개를 고른다. AI 변형은 기존 100 제한, 선택 범위 변경 시 실제 수를 재검증한다. 문제 무작위 순서와 보기 섞기를 구분한다.

옵션/범위는 StepProgress 등 단계 표시만 사용하고 role=progressbar를 사용하지 않는다. 실제 생성 요청 후 진행에만 progressbar·aria-busy·진행 수치를 표시한다. 문항 수/난이도 field는 desktop 동일 1fr/1fr grid, label/help 공간을 맞춰 input 상단을 정렬한다. mobile은 1열. 변형이 없거나 보기 섞기만 선택한 경우 난이도가 원본을 바꾸지 않음을 명확히 하고 AI 전용 난이도 입력은 숨긴다.

다음·시작/만들기 동작 줄은 dialog 하단 bottom=0에 유지한다. dialog 내부 scroll + sticky footer를 기본으로 사용하고 짧은 viewport에서는 viewport 하단 fixed와 body padding을 함께 적용한다. 키보드·safe-area·zoom에서 입력과 마지막 범위 행을 가리지 않는다.

## 결과

정답은 success token의 O, 오답은 danger token의 X. aria-label 정답/오답, 색만으로 구분하지 않는다. pending/skipped/reset은 별도 글자로 둔다. 결과 목록은 장 제목 아래 번호·발문·결과로 묶는다. chapter 없음은 마지막 그룹. bank는 원본 장·번호, mock은 원본 source ref의 장·번호(없는 경우 명시적 fallback)를 사용한다. 현재 run의 위치 링크는 유지한다.

기존 결과 pagination 200개를 유지하고 페이지 경계에 걸친 장도 제목이 있어야 한다. 화면 표시를 위해 5,000개 본문을 한 번에 가져오지 않는다. 결과 API에 chapter 정보가 없다면 정답 없는 metadata를 추가하고 membership/ownership 및 reset epoch 필터를 적용한다.

## 수용 기준

- UX10-PLAY-AC01: 풀기 버튼에서 통합 화면을 열고 변형 0개는 bank, 보기 섞기/AI 변형은 mock 경로를 사용하며 기록이 격리된다. 변형 0개와 보기 섞기는 LLM 호출이 없다.
- UX10-PLAY-AC02: 변형 0개·보기 섞기만 모두 전체 범위 가능, 0건·상한·범위 축소를 UI/서버가 검증한다.
- UX10-PLAY-AC03: 선택 단계는 단계 표시, 생성 중만 progressbar이며 desktop input 정렬·mobile 1열이 맞는다.
- UX10-PLAY-AC04: 짧은 화면·모바일 키보드에서 하단 다음 버튼과 마지막 입력/범위가 접근 가능하다.
- UX10-PLAY-AC05: 결과가 장별 번호·O/X로 표시되고 pending/skipped·장 없음·pagination·reset item도 정확하다. 항목을 누르면 같은 run 위치로 돌아간다.

- UX10-PLAY-AC06: 목록·상세 이름 수정 중 저장/취소가 입력 아래 한 줄에 있고 해당 풀기는 disabled, 저장 성공/취소 후 복구되며 실패 시 disabled와 입력이 유지된다.

## 검증·DoD

기존 mock-exams·question-viewer E2E 확장, mock config/bank routing unit, practice_runs 결과 contract, web/API/core touched unit·lint·typecheck 및 make contracts-check. fake LLM만 사용한다. 독립 리뷰 통과·커밋·보고.

## 실행 규칙

- 이 문서의 AC를 구현 직전에 RED로 작성하고 미구현으로 실패함을 확인한 뒤 GREEN으로 만든다. AC 제목은 해당 ID로 시작한다. 기존 화면 AC는 변경된 요구만 갱신하고 나머지는 보존한다.
- 사용자 지시(2026-11-05): Task와 gpt-6.1-terra subagent를 1:1로 배정한다(effort 기본값). 독립 Codex 리뷰 통과 후 커밋하고 main thread에 보고한다. main thread가 재검증·통합·QA하며 QA 수정도 같은 모델 subagent가 수행한다.
- 구현 중 CI 실행은 생략한다. 로컬 format/lint/typecheck·관련 unit/contract/E2E는 생략하지 않는다. 모든 작업을 한 feature PR로 올려 CI GREEN까지 수정 후 develop에 병합한다. 이어 develop → main PR·병합 및 production 배포를 수행한다(사용자 승인 범위).
- 작업 브랜치·worktree를 사용하고 다른 Task scope를 수정하지 않는다. 공통 파일·migration 번호·API client 생성 충돌은 main thread에 보고한다. 공유 DB migration 적용은 main thread만 한다.
- 리뷰는 scripts/codex-review.sh --uncommitted --title "<Task ID>: <summary>"로 커밋 전에 실행한다. 수정 후 재리뷰한다. 기본 모델을 사용한다. RED 및 구현·QA 증거를 보고한다.
- semantic token·Radix·공통 FloatingSidePanel 사용, 한국어 UI, 키보드·터치 동등, reduced-motion 준수. 테스트 skip/fixme 및 API client 수동 편집 금지.

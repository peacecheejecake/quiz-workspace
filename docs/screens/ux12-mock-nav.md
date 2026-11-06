# UX12-MOCKNAV — 모의고사 진입·상세 메뉴·용어

**Route:** `/workspaces/:workspaceId?panel=mock-exams[&mock=<id>]`

**Phase:** UX12-MOCKNAV.0
**테스트:** `tests/e2e/quality/ux12-mock-nav.spec.ts`

```yaml
id: UX12-MOCKNAV
linked_tests: [UX12-MOCKNAV-AC01, UX12-MOCKNAV-AC02, UX12-MOCKNAV-AC03, UX12-MOCKNAV-AC04]
```

**명세:** [UX12 MOCKUX-2](../implementation/ux12/index.md), [MOCK-01](mock-exams.md), [UX10-PLAY](ux10-play.md), [QVIEW-01](question-viewer.md)

사용자 요청(2026-11-06): 홈 `풀기`는 만들기가 아니라 모의고사 목록을 연다. 상세에는 `풀기`만 버튼으로 두고 나머지는 더보기로 옮긴다. 화면 문구의 `문제 풀기`는 `모의고사`로 부른다.

**더보기 메뉴:** 상세의 `더보기`(아이콘 버튼, 공통 `DropdownMenu`, 목록 행 메뉴와 같은 방식)는 편집 권한자에게만 보이고 항목 순서는 `설정 바꾸기`·`다시 만들기`·`이름 바꾸기`·`삭제`다. 문제를 만드는 중이면 `설정 바꾸기`와 `다시 만들기`가, 다시 만들기를 시작하는 중이면 `다시 만들기`가 비활성이다. 실패 alert의 `다시 시도`는 그대로 alert 안에 있다.

**용어:** 범위를 골라 푸는 화면의 이름은 `모의고사`다. 변형 유형을 고르지 않은 풀이는 문서에서 원본 풀이라고 부른다(UX12-PLAY). 버튼의 동사 `풀기`와 `다시 풀기`는 그대로다.

### UX12-MOCKNAV-AC01

홈의 primary `풀기`는 이름을 유지한 채 모의고사 목록(`?panel=mock-exams`, `mock` 없음)을 연다. 목록의 `추가`가 만들기 화면(`&mock=new`)을 열고, 닫으면 focus가 `풀기`로 돌아온다. 다른 홈 dialog가 열려 있으면 열리지 않는 규칙(`homeOpensBlocked`)은 그대로다.

### UX12-MOCKNAV-AC02

편집 권한자의 상세에는 동작 버튼이 `풀기`와 `더보기`뿐이고, `더보기`에 네 항목이 위 순서로 있다. 이름 바꾸기를 취소하거나 저장한 뒤, 삭제·다시 만들기 확인을 닫은 뒤, 설정 바꾸기를 취소한 뒤 focus는 `더보기`로 돌아온다.

### UX12-MOCKNAV-AC03

보기 권한자의 상세에는 `풀기`만 있고 `더보기`가 없다.

### UX12-MOCKNAV-AC04

도움말의 풀이 절 제목과 원본 풀이의 범위 고르기 제목은 `모의고사`이고, 화면에 `문제 풀기`라는 글자가 없다.

**E2E:** `tests/e2e/quality/ux12-mock-nav.spec.ts`

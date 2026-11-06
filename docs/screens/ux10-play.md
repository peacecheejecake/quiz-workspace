# UX10-PLAY — 통합 모의고사

**Route:** `/workspaces/:workspaceId?panel=mock-exams&mock=new` (기존 모의고사 목록과 상세 URL 유지)

**Phase:** UX10-PLAY.0
**테스트:** `tests/e2e/questions/ux10-play.spec.ts`

```yaml
id: UX10-PLAY
linked_tests: [UX10-PLAY-AC01, UX10-PLAY-AC02, UX10-PLAY-AC03, UX10-PLAY-AC04, UX10-PLAY-AC05, UX10-PLAY-AC06]
```

**명세:** [UX10-PLAY](../implementation/ux10/play.md), [MOCK-01](mock-exams.md), [QVIEW-01](question-viewer.md)

### UX10-PLAY-AC01

홈의 풀기가 연 모의고사 목록의 `추가`에서 통합 옵션을 열고(UX12-MOCKNAV) 변형이 없으면 은행 풀이, 변형이 있으면 모의고사 경로를 사용한다. 두 기록은 격리된다.

### UX10-PLAY-AC02

변형 없음과 보기 섞기는 전체 범위를 지원한다. 빈 범위, 문항 수 상한과 선택 범위를 검증한다.

### UX10-PLAY-AC03

옵션과 범위는 단계로 표시하고 실제 생성 중에만 진행률을 표시한다. 문항 수와 난이도는 데스크톱 두 열, 모바일 한 열이다.

### UX10-PLAY-AC04

짧은 화면과 모바일 키보드에서도 다음 동작과 마지막 입력 및 범위에 접근할 수 있다.

### UX10-PLAY-AC05

결과는 장별로 묶고 번호와 정답 O, 오답 X, 대기·건너뜀·초기화를 구분한다. 페이지 경계와 같은 run 위치 링크를 유지한다.

### UX10-PLAY-AC06

모의고사 이름 편집 중 저장·취소는 입력 아래 한 줄이고 해당 모의고사의 풀기는 비활성이다. 성공·취소 시 복구하고 실패 시 입력과 비활성을 유지한다.

**E2E:** `tests/e2e/questions/ux10-play.spec.ts`

# UX12-CHAPTERRUN — 챕터별 풀기

**Route:** `/workspaces/:workspaceId` → `?practice=<id>&i=<k>`

**Phase:** UX12-CHAPTERRUN.0
**테스트:** `tests/e2e/questions/ux12-chapter-run.spec.ts`

```yaml
id: UX12-CHAPTERRUN
linked_tests: [UX12-CHAPTERRUN-AC01 … UX12-CHAPTERRUN-AC07]
```

**명세:** [UX12 MOCKUX-4](../implementation/ux12/index.md) (사용자 요청 2026-11-06), [QVIEW-01](question-viewer.md), [QOV-01](questions-overview.md), [UX12-MOCKNAV](ux12-mock-nav.md)

홈 Heatmap의 챕터마다 `풀기` 버튼을 둔다. 저장되는 모의고사를 만들지 않고 그 챕터의 확정 문제로 범위 풀이(`practice_run`, `source=bank`)를 바로 시작한다. 시작 전에는 두 옵션만 고른다. 범위 고르기 단계와 `모의고사 목록` 버튼은 없다.

기본값(MOCKUX-4 위임 결정):

- **범위:** 그 챕터의 확정 문제 전체. 홈의 상태·즐겨찾기·유형·검색 필터는 보이는 점만 좁힐 뿐 챕터 풀이의 범위를 좁히지 않는다.
- **권한:** 모든 멤버. 보관된 Workspace에서도 범위 풀이와 같다(시작하고 볼 수 있고 제출은 안 된다, QVIEW-01-AC07).
- **옵션 화면:** 작은 modal dialog. 시작 전에는 서버에 아무것도 만들지 않으므로 주소에 남기지 않는다. 시작하면 기존 `?practice=<run>&i=1`로 들어가 이력, 뒤로 가기, 닫기, `처음부터 다시`, 결과 단계가 범위 풀이와 같다.

### UX12-CHAPTERRUN-AC01

Heatmap에 보이는 챕터의 header마다 `정리 노트` 옆에 `풀기`(`size="sm"`)가 있다. `챕터 없음`에는 `내 하이라이트` 옆에 있다. 눈에 보이는 글자는 `풀기`이고 접근성 이름은 "<장 제목> 풀기"다. 확정 문제가 없는 챕터는 Heatmap에 없으므로 버튼도 없다. 375px에서 버튼은 한 줄로 들어가고 페이지 가로 스크롤이 없으며, 챕터 header의 높이와 점의 위치는 버튼과 무관하다(좁은 화면의 긴 제목은 제목 안에서 줄바꿈한다).

### UX12-CHAPTERRUN-AC02

`풀기`는 "<장 제목> 풀기" dialog를 연다. dialog에는 `보기 섞기`, `문제 순서 무작위` checkbox(둘 다 꺼짐)와 `취소`, `시작`만 있다. 범위 고르기, 문항 수, 필터, `모의고사 목록`은 없다. 닫기, `취소`, Escape는 아무것도 만들지 않고 닫으며 focus는 그 챕터의 `풀기`로 돌아온다. 다시 열면 두 checkbox는 꺼져 있다. 시작 요청 중에는 닫히지 않고, 실패하면 dialog에 이유를 보이며 같은 요청을 다시 시도할 수 있다.

### UX12-CHAPTERRUN-AC03

`시작`은 그 챕터의 문제로 run을 만든다: 요청의 범위는 `chapter_ids: [<장 id>]`(`챕터 없음`은 `["none"]`)이고 필터가 없다. 상태 필터로 일부만 보이는 챕터도 확정 문제 전부를 푼다. 모의고사는 만들어지지 않고(목록과 `GET /workspaces/{id}/mock-exams`가 그대로), 다른 챕터의 문제는 포함되지 않는다.

### UX12-CHAPTERRUN-AC04

시작하면 dialog가 닫히고 범위 풀이 panel이 `?practice=<run>&i=1`로 열린다. 닫기와 뒤로 가기는 홈으로 돌아오고 focus는 그 챕터의 `풀기`로 간다. 보기 권한 멤버도 시작하고 제출한다. 시도와 이력은 Heatmap 범위 풀이와 같다. 보관된 Workspace에서는 시작하고 볼 수 있지만 제출이 없다.

### UX12-CHAPTERRUN-AC05

`문제 순서 무작위`를 켜면 묶음의 순서가 서버 seed shuffle이다(QVIEW-01-C02). 끄면 Heatmap 순서다.

### UX12-CHAPTERRUN-AC06

`보기 섞기`를 켜면 각 객관식 위치의 보기가 그 run에 고정된 순서로 섞인다. 새로 고침, 이전 위치로 돌아가기, 제출 뒤에도 같은 순서다. 채점은 변하지 않는 option ID로 하고, 제출 전에는 정답을 보내지 않는다. 끄면 원본 순서다.

### UX12-CHAPTERRUN-AC07

결과 단계의 `처음부터 다시`는 두 설정을 그대로 잇는다: 새 run도 `보기 섞기`와 `문제 순서 무작위`가 원래 run과 같다.

## 계약

| ID | 내용 |
|---|---|
| UX12-CHAPTERRUN-C01 | **범위:** 챕터 풀이는 새 API가 아니라 `POST /workspaces/{id}/practice-runs`의 `chapter_ids`다. 그 밖의 범위 규칙(QVIEW-01-C01), 권한(C05), 5,000문제 한도는 그대로다. |
| UX12-CHAPTERRUN-C02 | **기록:** `bank` 범위 풀이와 같다(§12 기록). 저장되는 것은 run 자체뿐이다. |
| UX12-CHAPTERRUN-C03 | **`shuffle_options`:** `POST /practice-runs`의 선택 필드(기본 false, `source=bank`만, `source=mock`은 422)이고 `PracticeRun`이 돌려준다. 스키마를 바꾸지 않고 `practice_runs.range` jsonb의 `shuffle_options` 키로 저장한다(키 없음 = 꺼짐, run은 생성 뒤 바뀌지 않음). 위치 k의 보기 순서는 `shuffled_option_ids(옵션 id, run_option_seed(seed, k))`로 정해지므로 세션을 열기 전(`GET /items/{k}`)과 연 뒤가 같고, 세션을 열 수 없는 보관된 Workspace에서도 같다. 세션은 그 순서를 `displayed_option_ids`와 `shuffle_seed`에 저장한다. 제출된 위치의 `다시 풀기`(별도 연습)는 새로 섞는다. |

# UX12-MOCKFORM2 — 모의고사 만들기 단계 순서와 문구

**Route:** `/workspaces/:workspaceId?panel=mock-exams&mock=new`, 상세의 `설정 바꾸기`

**Phase:** UX12-MOCKFORM2.0
**테스트:** `tests/e2e/quality/ux12-mock-form-order.spec.ts` (단위: `apps/web/test/mock-exams.test.ts`, `apps/web/test/mock-exams-async.test.tsx`)

```yaml
id: UX12-MOCKFORM2
linked_tests: [UX12-MOCKFORM2-AC01, UX12-MOCKFORM2-AC02, UX12-MOCKFORM2-AC03, UX12-MOCKFORM2-AC04, UX12-MOCKFORM2-AC05, UX12-MOCKFORM2-AC06]
```

**명세:** [UX12 MOCKUX-8](../implementation/ux12/index.md), [UX12-MOCKFORM](ux12-mock-form.md), [MOCK-01](mock-exams.md), [UX10-AI](ux10-ai.md)

사용자 요청(2026-11-06): 범위를 먼저 고르고 옵션을 정한다. 이름 기본값은 고른 챕터 이름이다. 안내 문구 3개를 지우고, 변형 유형 설명은 물음표 버튼 하나에 모은다.

### UX12-MOCKFORM2-AC01

`StepList`는 `범위 → 옵션`이다. 만들기와 `설정 바꾸기` 모두 같다. 1단계 하단 버튼은 `다음`이고, 선택이 없거나 문제를 읽는 중이거나 읽기에 실패하면 비활성이다. 선택이 없으면 "출제 범위를 고르세요"를 버튼 설명(`aria-describedby`)으로 함께 보인다. 2단계에서 완료된 1단계가 버튼(이름 `범위 단계로 돌아가기`)이며, 누르면 범위로 돌아가고 범위와 옵션 값을 유지한다. `이전` 버튼은 없다. 최종 동작(`만들기`, `다시 만들기`, 변형 없는 풀이의 `시작`), "선택 n문제 중 m문항을 만듭니다", AI 전송 안내는 2단계에만 있다. 1단계의 글자는 "선택 n문제"다. 단계를 옮기면 focus는 그 단계 제목으로 간다.

**E2E:** `tests/e2e/quality/ux12-mock-form-order.spec.ts`

### UX12-MOCKFORM2-AC02

만들기의 이름 기본값은 고른 챕터 이름이다. 한 챕터만 고르면 그 제목, 여러 챕터면 Heatmap 순서의 첫 제목에 ` 외 n개`를 붙인다(n은 나머지 챕터 수). 한 챕터의 문제 일부만 골라도 그 챕터로 센다. 보이는 문제 전체를 고른 경우와 챕터가 없는 문제만 고른 경우는 지금 기본값 "모의고사 <n>"을 쓴다. 챕터 없는 문제가 섞이면 챕터가 있는 쪽만 센다. 합친 이름이 100자를 넘으면 첫 제목을 줄여 100자에 맞춘다.

기본값은 2단계로 들어갈 때 정하고, 사용자가 이름을 고치기 전까지만 적용한다. 고친 이름은 지운 경우를 포함해 범위를 바꾸고 돌아와도 덮어쓰지 않는다. `설정 바꾸기`는 저장된 이름을 그대로 둔다. 변형 유형을 고르지 않으면 `이름`을 숨기는 규칙(UX12-PLAY-AC01)은 그대로다.

**E2E:** `tests/e2e/quality/ux12-mock-form-order.spec.ts`

### UX12-MOCKFORM2-AC03

옵션 단계에 "원본과 보기 섞기는 선택 범위까지 풀 수 있습니다.", "난이도는 원본과 같습니다.", "선택한 범위의 문제를 모두 사용합니다."가 없다. 문항 수의 AI 안내 "1~100문항"과 `선택 범위의 모든 문항` checkbox는 그대로다.

**E2E:** `tests/e2e/quality/ux12-mock-form-order.spec.ts`

### UX12-MOCKFORM2-AC04

`변형 유형` 제목 옆에 `?` 버튼(이름 `변형 유형 설명`) 하나만 있고 유형별 `?`는 없다. 묶음의 접근성 이름은 `변형 유형`이다. kit `Tooltip`은 탭으로 열리지 않으므로(Radix Tooltip은 hover와 keyboard focus만 연다) 이 버튼은 Popover를 연다. 마우스 click, 터치 tap, Enter로 열고, 다시 누르거나 바깥을 누르거나 Escape로 닫으며 Escape는 패널을 닫지 않고 focus를 버튼으로 돌려준다. 내용은 지금 보이는 유형의 이름과 설명을 모두 담는다.

쓸 수 없는 유형의 이유는 설명 밖에 글자로 보인다. 편집 권한이 없으면 "변형 출제에는 편집 권한이 필요합니다."를 유지한다. LLM이 꺼진 환경에서는 AI 유형과 그 이유를 모두 보이지 않는다([UX10-AI-AC01](ux10-ai.md)이 우선). 설명 Popover도 그 유형을 뺀다.

**E2E:** `tests/e2e/quality/ux12-mock-form-order.spec.ts`

### UX12-MOCKFORM2-AC05

`설정 바꾸기`는 저장된 범위가 고른 상태로 1단계에 열려 `다음`을 바로 누를 수 있다. 범위를 건드리지 않으면 저장된 범위 그대로 보낸다. 옵션에는 저장된 이름, 유형, 문항 수가 있다. `취소`는 1단계에 있다.

**E2E:** `tests/e2e/quality/ux12-mock-form-order.spec.ts`

### UX12-MOCKFORM2-AC06

옵션 검사는 최종 동작에서 한다. 이름이나 문항 수가 틀리면 그 칸에 오류를 보이고 focus를 옮기며 저장하지 않는다. 옵션 단계의 입력란에서 Enter는 최종 동작과 같다. 범위 단계에는 Enter로 제출되는 입력이 없다.

선택 수를 먼저 알므로 만들기의 `문항 수` 기본값은 2단계로 들어갈 때 `min(20, 선택 수)`이다. 사용자가 문항 수를 고치면 덮어쓰지 않는다. 문항 수가 선택보다 많으면 최종 동작은 비활성이고 "선택한 범위보다 문항 수가 많습니다."를 보인다.

**E2E:** `tests/e2e/quality/ux12-mock-form-order.spec.ts`

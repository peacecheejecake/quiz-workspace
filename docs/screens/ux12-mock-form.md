# UX12-MOCKFORM — 모의고사 만들기·설정 바꾸기 화면

**Route:** `/workspaces/:workspaceId?panel=mock-exams&mock=new`, 상세의 `설정 바꾸기`

**Phase:** UX12-MOCKFORM.0
**테스트:** `tests/e2e/quality/ux12-mock-form.spec.ts` (단위: `apps/web/test/ux10-range-filters.test.tsx`, `packages/ui/test/step-list.test.tsx`, `packages/ui/test/floating-side-panel.test.tsx`, `apps/api/tests/test_practice_runs_unit.py`)

```yaml
id: UX12-MOCKFORM
linked_tests: [UX12-MOCKFORM-AC01, UX12-MOCKFORM-AC02, UX12-MOCKFORM-AC03, UX12-MOCKFORM-AC04, UX12-MOCKFORM-AC05, UX12-MOCKFORM-AC06]
```

**명세:** [UX12 MOCKUX-1](../implementation/ux12/index.md), [MOCK-01](mock-exams.md), [QVIEW-01](question-viewer.md), [design-system §7](../design-system.md)

사용자 피드백(2026-11-06): 위쪽 `문제 풀기` 제목과 `1. 옵션`, `2. 범위` 목록을 업로드와 비슷한 step UI로 바꾸고, 좌우 흔들림과 하단 버튼 고정 문제를 고친다. 범위 단계의 필터 접기를 없애고 상태 chip에 홈과 같은 색을 넣는다. `유형`은 복수 선택 체크박스로 바꾸고 `이전` 버튼은 없앤다.

### UX12-MOCKFORM-AC01

패널 제목은 `모의고사`다. `문제 풀기` 제목과 글자 단계 목록은 없다. 단계는 kit `StepList`(이름 `모의고사 단계`)로 보이며 업로드의 `StepProgress`와 생김새가 같고 진행 막대(`progressbar`)는 없다. 지금 단계는 `aria-current="step"`이다. `모의고사 목록` BackLink는 단계 위에 있다.

**E2E:** `tests/e2e/quality/ux12-mock-form.spec.ts`

### UX12-MOCKFORM-AC02

단계와 하단 버튼은 패널의 고정 영역(`FloatingPanelPinned`, `FloatingPanelFooter`)에 있어 내용을 스크롤해도 그 자리에 있다. 두 단계 모두 1280×800과 375×667에서 스크롤 영역에 가로 넘침이 없고(`scrollWidth ≤ clientWidth`, `scrollLeft = 0`), 하단 버튼은 패널 맨 아래 안쪽에 보인다. 버튼은 패널 footer 규칙대로 오른쪽에 붙는다. 실패 문구는 버튼 위 줄에 있어 스크롤 위치와 상관없이 보인다.

**E2E:** `tests/e2e/quality/ux12-mock-form.spec.ts`

### UX12-MOCKFORM-AC03

범위 단계의 필터는 언제나 보이고 접기 버튼이 없다. 상태 chip은 홈 chip과 같은 색 견본과 글자 이름을 함께 보인다. 켜짐은 `aria-pressed`로도 알린다. 색만으로 뜻을 전하지 않는다.

**E2E:** `tests/e2e/quality/ux12-mock-form.spec.ts`

### UX12-MOCKFORM-AC04

`유형`은 드롭다운이 아니라 `객관식`, `단답형`, `서술형` 체크박스 묶음(이름 `유형`)이다. 여러 개를 고를 수 있고, 아무것도 고르지 않으면 모든 유형이다. 고른 유형만 목록에 남고 선택에서도 나머지가 빠지며, `필터 초기화`가 함께 지운다. 묶음 아래에 "고르지 않으면 모든 유형을 보여 줍니다."가 있다.

API: `GET …/questions/overview`의 `type`은 반복할 수 있고, 범위 `filters`는 `types`(1~3개)를 받는다. 예전에 저장된 범위의 `type` 하나와 `type: null`은 계속 읽고 `types`로 돌려준다(migration 없음).

**E2E:** `tests/e2e/quality/ux12-mock-form.spec.ts`

### UX12-MOCKFORM-AC05

`이전` 버튼은 없다. 범위 단계에서 완료된 1단계가 버튼(이름 `옵션 단계로 돌아가기`, 높이 24px 이상, 밑줄)이며 마우스, 터치, 키보드로 누를 수 있다. 누르면 옵션으로 돌아가고 입력한 이름, 유형, 문항 수를 유지하며, 다시 `다음`을 누르면 고른 범위와 필터도 그대로다. 아직 가지 않은 2단계는 버튼이 아니다. 저장이 진행되는 동안에는 눌리지 않는다.

**E2E:** `tests/e2e/quality/ux12-mock-form.spec.ts`

### UX12-MOCKFORM-AC06

`설정 바꾸기`도 같은 step UI, 필터, 하단 버튼을 쓴다. 저장된 `types`는 체크된 채 돌아온다.

**E2E:** `tests/e2e/quality/ux12-mock-form.spec.ts`

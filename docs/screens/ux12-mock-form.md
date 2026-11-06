# UX12-MOCKFORM — 모의고사 만들기·설정 바꾸기 화면

**Route:** `/workspaces/:workspaceId?panel=mock-exams&mock=new`, 상세의 `설정 바꾸기`

**Phase:** UX12-MOCKFORM.0
**테스트:** `tests/e2e/quality/ux12-mock-form.spec.ts` (단위: `apps/web/test/ux10-range-filters.test.tsx`, `packages/ui/test/step-list.test.tsx`, `packages/ui/test/floating-side-panel.test.tsx`, `apps/api/tests/test_practice_runs_unit.py`)

```yaml
id: UX12-MOCKFORM
linked_tests: [UX12-MOCKFORM-AC01, UX12-MOCKFORM-AC02, UX12-MOCKFORM-AC03, UX12-MOCKFORM-AC04, UX12-MOCKFORM-AC05, UX12-MOCKFORM-AC06]
```

**명세:** [UX12 MOCKUX-1](../implementation/ux12/index.md), [MOCK-01](mock-exams.md), [QVIEW-01](question-viewer.md), [design-system §7](../design-system.md)

사용자 피드백(2026-11-06): 위쪽 `문제 풀기` 제목과 단계 글자 목록을 업로드와 비슷한 step UI로 바꾸고, 좌우 흔들림과 하단 버튼 고정 문제를 고친다. 범위 단계의 필터 접기를 없애고 상태 chip에 홈과 같은 색을 넣는다. `유형`은 복수 선택 체크박스로 바꾸고 `이전` 버튼은 없앤다.

### UX12-MOCKFORM-AC01

패널 제목은 `모의고사`다. `문제 풀기` 제목과 글자 단계 목록은 없다. 단계는 kit `StepList`(이름 `모의고사 단계`)로 보이며 업로드의 `StepProgress`와 생김새가 같고 진행 막대(`progressbar`)는 없다. 지금 단계는 `aria-current="step"`이고 그 label은 굵게에 더해 primary 색이다(색만으로 구분하지 않는다). 단계 글자는 `--font-size-body`이고 단계 영역 아래에 구분선은 없다(사용자 피드백 2026-11-07, MOCKFORM3). 뒤로 가기는 BackLink가 아니라 패널 header의 제목 바로 왼쪽 아이콘 버튼이다: 첫 단계(범위)에서는 이름 `모의고사 목록`이 목록으로 가고(기록 항목 push), 둘째 단계(옵션)에서는 `이전 단계`가 범위로 돌아가며 범위·필터·옵션 값을 유지한다. 돌아가면 focus는 단계 제목으로 간다(`설정 바꾸기`는 상세 안이라 기존 BackLink를 그대로 쓴다).

**E2E:** `tests/e2e/quality/ux12-mock-form.spec.ts`

### UX12-MOCKFORM-AC02

단계와 하단 버튼은 패널의 고정 영역(`FloatingPanelPinned`, `FloatingPanelFooter`)에 있어 내용을 스크롤해도 그 자리에 있다. 두 단계 모두 1280×800과 375×667에서 스크롤 영역에 가로 넘침이 없고(`scrollWidth ≤ clientWidth`, `scrollLeft = 0`), 하단 버튼은 패널 맨 아래 안쪽에 보인다. 버튼은 패널 footer 규칙대로 오른쪽에 붙는다. 실패 문구는 버튼 위 줄에 있어 스크롤 위치와 상관없이 보인다.

**E2E:** `tests/e2e/quality/ux12-mock-form.spec.ts`

### UX12-MOCKFORM-AC03

범위 단계의 필터는 언제나 보이고 접기 버튼이 없다. 상태 chip은 홈 chip과 같은 색 견본과 글자 이름을 함께 보인다. 켜짐은 `aria-pressed`로도 알린다. 색만으로 뜻을 전하지 않는다.

**E2E:** `tests/e2e/quality/ux12-mock-form.spec.ts`

### UX12-MOCKFORM-AC04

`유형`은 드롭다운이 아니라 `객관식`, `단답형`, `서술형` 체크박스 묶음이다. 보이는 제목(legend)과 안내 글자는 없고 묶음의 접근성 이름만 `유형`이다(사용자 피드백 2026-11-07, MOCKFORM3). 처음에는 모든 유형이 체크되어 있고, `types`는 명시적인 선택이다: 고른 유형만 목록에 남고 선택에서도 나머지가 빠지며, 아무것도 고르지 않으면 모든 유형이 아니라 문제가 하나도 보이지 않는다("조건에 맞는 문제가 없습니다."와 `필터 초기화`, `다음`은 기존 "출제 범위를 고르세요" 이유로 비활성). 불러온 문제에 없는 유형은 비활성이고 체크되지 않으며 선택으로 세지 않는다(한 번 본 유형은 다른 유형을 껐다고 비활성이 되지 않는다). 사용할 수 있는 유형이 모두 체크된 상태가 필터 없음이며 `필터 초기화`는 그 상태로 되돌린다. 예전에 저장된 범위의 `types` 없음은 모든 유형이다. 범위 고르기 부품은 공유이므로 풀이 범위 단계(QVIEW-01)와 챕터 재분배에도 같은 동작이다.

API: `GET …/questions/overview`의 `type`은 반복할 수 있고, 범위 `filters`는 `types`(1~3개)를 받는다. 예전에 저장된 범위의 `type` 하나와 `type: null`은 계속 읽고 `types`로 돌려준다(migration 없음).

**E2E:** `tests/e2e/quality/ux12-mock-form.spec.ts`

### UX12-MOCKFORM-AC05

`이전` 버튼은 없다. 옵션 단계에서 완료된 1단계가 버튼(이름 `범위 단계로 돌아가기`, 높이 24px 이상, 회색 바탕의 체크 표시와 보통 글자색, 평소에는 밑줄 없이 hover·focus에서 밑줄과 배경으로 누를 수 있음을 보인다 — 사용자 피드백 2026-11-07, MOCKFORM3)이며 마우스, 터치, 키보드로 누를 수 있다. 누르면 범위로 돌아가고 고른 범위와 필터를 유지하며, 다시 `다음`을 누르면 입력한 이름, 유형, 문항 수도 그대로다(단계 순서는 [UX12-MOCKFORM2](ux12-mock-form-order.md)). 아직 가지 않은 2단계는 버튼이 아니다. 헤더의 `이전 단계`도 같은 동작이다. 옵션 단계에서는 저장하지 않은 입력 규칙이 적용되지 않아 입력한 이름이 있어도 backdrop(dim)을 누르면 바로 닫힌다. 범위 단계에서 범위·필터를 건드렸으면 닫히지 않는다. Escape와 닫기 버튼은 그대로다. 저장이 진행되는 동안에는 눌리지 않는다.

**E2E:** `tests/e2e/quality/ux12-mock-form.spec.ts`

### UX12-MOCKFORM-AC06

`설정 바꾸기`도 같은 step UI, 필터, 하단 버튼을 쓴다. 저장된 `types`는 체크된 채 돌아온다.

**E2E:** `tests/e2e/quality/ux12-mock-form.spec.ts`

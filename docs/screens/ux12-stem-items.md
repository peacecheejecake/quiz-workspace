# UX12-PASSAGE2 — 한 줄로 붙은 `- 항목` 나열

**Route:** 문제 내용 전체를 보이는 모든 화면(`StemText`·`StemBlocks`)

**Phase:** UX12-PASSAGE2.0
**테스트:** `tests/e2e/questions/ux12-stem-items.spec.ts`

```yaml
id: UX12-PASSAGE2
linked_tests: [UX12-PASSAGE2-AC01, UX12-PASSAGE2-AC02, UX12-PASSAGE2-AC03, UX12-PASSAGE2-AC04, UX12-PASSAGE2-AC05]
```

**명세:** [UX12 VIEW-8](../implementation/ux12/index.md), [questions.md §4 12](../questions.md), [UX12-PASSAGE](ux12-stem-passages.md)

제목 없는 제시문은 질문 문장 뒤에 `- 이름 : 값` 항목만 이어질 수 있고, 가져온 문제는 항목들이 ` - `를 사이에 두고 한 줄로 저장되어 있을 수 있다. 줄마다 저장된 `- 항목`도 문장 끝 없이 같은 목록이다. 화면은 저장값을 바꾸지 않고 항목마다 줄을 나누어 제시 항목 박스(VIEW-7의 제시문 박스와 같은 모양)에 넣는다. 인식 규칙은 questions.md §4 12가 기준이다. 표시 함수와 추출기의 공통 사례는 `tests/fixtures/stem-passages.json`이다.

### UX12-PASSAGE2-AC01

질문 문장 뒤에 `- 이름 : 값 , 값 - 이름 : 값 , 값`이 한 줄로 저장된 문제를 풀이 panel에서 연다. 질문 문장은 박스 밖의 문단이다. `제시 항목` 목록은 항목 둘이고 항목마다 한 줄에서 시작하며, 기호 `-`는 인쇄된 대로 보인다.

### UX12-PASSAGE2-AC02

나열이 아닌 하이픈은 나누지 않는다: 낱말·숫자 사이의 ` - `(`A - B`, `1 - 2`), 날짜(`2023-01`), 복합어, 문장 속 하이픈 하나, 줄 시작이 아니면서 뒤에 `이름 : 값`이 이어지지 않는 ` - `는 전과 같은 문단으로 보이고 `제시 항목` 목록이 없다.

### UX12-PASSAGE2-AC03

표시 전용이다: 문제 API의 저장된 문제 내용은 한 줄 그대로다.

### UX12-PASSAGE2-AC04

제시 항목 박스와 보기 영역은 겹치지 않고 사이가 벌어져 있다. 풀이 panel, 범위 풀이, 모의고사, 문제 상세에서 같다.

### UX12-PASSAGE2-AC05

`<보기>` 제목 뒤에 같은 나열이 오면 제목이 있는 제시문 박스 하나이고 그 안에서 항목마다 줄을 나눈다.

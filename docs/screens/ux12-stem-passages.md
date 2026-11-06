# UX12-PASSAGE — 제시문 구분

**Route:** 문제 내용 전체를 보이는 모든 화면(`StemText`·`StemBlocks`)

**Phase:** UX12-PASSAGE.0
**테스트:** `tests/e2e/questions/ux12-stem-passages.spec.ts`

```yaml
id: UX12-PASSAGE
linked_tests: [UX12-PASSAGE-AC01, UX12-PASSAGE-AC02, UX12-PASSAGE-AC03, UX12-PASSAGE-AC04]
```

**명세:** [UX12 VIEW-7](../implementation/ux12/index.md), [questions.md §4 12](../questions.md), [QPLAY-01](questions-practice.md)

한 줄로 저장된 문제에는 질문 문장 뒤에 `<제목>`이 붙은 제시문이 이어질 수 있다. 화면은 저장값을 바꾸지 않고 제시문마다 제목이 있는 박스를 그리고, 제시문 안의 `∙`·`-` 항목을 줄로 나눈다. 인식 규칙은 questions.md §4 12가 기준이다. 표시 함수와 추출기의 공통 사례는 `tests/fixtures/stem-passages.json`이다.

### UX12-PASSAGE-AC01

질문 문장, 제시문 둘, `(가)`~`(다)` 항목이 한 줄로 저장된 문제를 풀이 panel에서 연다. 질문 문장은 박스 밖의 문단이다. 제시문마다 제목으로 이름 붙은 영역(`section`) 하나가 있고 그 안의 첫 요소는 인쇄된 대로의 제목(`<제목>`, heading)이다. 두 박스는 서로 겹치지 않고 사이가 벌어져 있다. `제시 항목` 목록은 두 박스 뒤에 따로 있고 항목 세 개다.

### UX12-PASSAGE-AC02

제시문 안에서 항목 기호(`∙` 등)로 시작하는 항목은 목록 항목 하나씩이고, ` - ` 하위 항목은 부모 항목 안의 들여쓴 목록이다. 항목 경계가 아닌 글자는 나누지 않는다: 날짜 범위(`2026.6.10. ~ 2028.6.9.`), 낱말 범위(`월요일 - 금요일 : 휴무`), 숫자 빼기(`10 - 3`), 문장 속 하이픈, `A·B` 낱말은 항목 글자 그대로 남는다.

### UX12-PASSAGE-AC03

문장 속 언급(`<보기>에서`, `다음 <보기> 에 대한`)과 박스로 나뉠 본문이 없는 제목(`옳은 것은? <보기> (가) … (나) …`)은 제시문이 아니다. 전과 같이 보인다. 표시 전용이다: 문제 API의 저장된 문제 내용은 한 줄 그대로다.

### UX12-PASSAGE-AC04

375 px 화면과 데스크톱 화면에서 박스는 문제 panel 폭을 넘지 않고 가로 스크롤을 만들지 않는다.

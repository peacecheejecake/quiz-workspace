# UX12-SRCMENU — 더보기 메뉴의 원문 보기

**Route:** 별도 route 없음(URL을 바꾸지 않는다). 풀이 panel(`?question=`)과 범위 풀이(`?practice=`)의 더보기 메뉴

**Phase:** UX12-SRCMENU.0
**테스트:** `tests/e2e/quality/ux12-source-menu.spec.ts`

```yaml
id: UX12-SRCMENU
linked_tests: [UX12-SRCMENU-AC01, UX12-SRCMENU-AC02, UX12-SRCMENU-AC03, UX12-SRCMENU-AC04]
```

**명세:** [UX12 VIEW-4](../implementation/ux12/index.md), [QSRC-01](question-source-preview.md)

사용자 피드백 "원문 보기 버튼 추가 - 더보기 dropdown 메뉴 안에, pdf 부분을 별도의 팝업으로 보여줌". 팝업은 QSRC-01의 "문제 원문" dialog를 그대로 쓴다.

## 규칙

- **항목:** 더보기 메뉴(`문제 관리`·`문제 정보`)의 읽기 항목 끝, `수정 이력·출처` 다음에 `원문 보기`를 둔다.
- **진입점 둘:** 본문의 `문제 원문 보기` 버튼은 그대로 둔다(결정 2026-11-06). 둘은 같은 영역 정보와 같은 dialog를 쓴다.
- **표시 조건:** QSRC-01의 버튼과 같다. 영역 정보가 있는 문제에만 항목이 있고, 없으면(직접 만든 문제, 출처 PDF 삭제, 오류, 확인 중) 항목 자체가 없다. 비활성으로 두지 않는다.
- **보이는 내용:** QSRC-01 그대로 문제 자기 영역만 잘라 보인다. PDF 전체나 다른 쪽은 보이지 않는다. PDF는 메뉴 항목을 고를 때 처음 받는다.
- **닫기:** dialog를 메뉴 항목으로 열었으면 닫을 때 focus가 메뉴 trigger로 돌아온다. 나머지(나란히 배치, 좁은 화면 sheet, Back, Escape, 문제 panel `inert`)는 QSRC-01과 같다.
- **없는 곳:** `sequence(mock)`에는 더보기 메뉴가 없으므로 본문 버튼만 있다. "문제 상세"(`manage`)도 본문 버튼만 있다. 공유 게스트는 영역 정보 API가 거절하므로 항목이 없다.

## 수용 기준

### UX12-SRCMENU-AC01

**메뉴로 열기:** 가져온 문제의 풀이 panel(1280×800)에서 편집 권한 구성원의 `문제 관리` 메뉴에 `수정 이력·출처` 다음 항목으로 `원문 보기`가 있고, 고르기 전에는 PDF 요청이 없다. 고르면 "문제 원문" dialog가 문제 panel 왼쪽에 열려 문제 영역 그림을 보이고 문제 panel은 `inert`이며, 본문 `문제 원문 보기` 버튼도 그대로 있다. Escape는 dialog만 닫고 focus는 `문제 관리` 버튼으로 돌아오며 URL은 바뀌지 않는다.

### UX12-SRCMENU-AC02

**영역이 있을 때만:** 직접 만든 문제의 메뉴에는 `원문 보기`가 없고 다른 읽기 항목은 그대로다. 보기 권한 구성원의 `문제 정보` 메뉴에는 가져온 문제일 때 `원문 보기`가 있고 같은 dialog가 열린다.

### UX12-SRCMENU-AC03

**범위 풀이와 모의고사:** 범위 풀이에서 가져온 문제의 메뉴로 dialog를 열고 닫으면 focus가 메뉴 버튼으로 돌아온다. 다음 위치가 영역 없는 문제면 항목이 없다. 모의고사 풀이(`sequence(mock)`)에는 메뉴가 없고 본문 버튼으로 같은 dialog가 열린다.

### UX12-SRCMENU-AC04

**좁은 화면:** 375×812에서 메뉴로 열면 전체 화면 sheet다. 브라우저 Back은 sheet만 닫고 문제 panel과 URL은 그대로이며 focus는 메뉴 버튼으로 돌아온다.

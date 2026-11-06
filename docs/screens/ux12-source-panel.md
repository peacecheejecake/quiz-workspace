# UX12-SOURCE — 원본 쪽 floating dialog

**Route:** 별도 route 없음(URL을 바꾸지 않는다). 가져오기 페이지, "문제 상세" dialog, 관련 본문, "본문 발췌" panel, 문서 요약 panel 안의 원본 쪽 링크.

**Phase:** UX12-SOURCE.0
**테스트:** `tests/e2e/questions/ux12-source-panel.spec.ts`

```yaml
id: UX12-SOURCE
linked_tests: [UX12-SOURCE-AC01 … UX12-SOURCE-AC06]
```

**상태:** UX12 DOCS-2 신규 2026-11-06 (사용자 피드백 "문제 PDF 가져오기 등의 화면에서 원본 링크 누르면 floating dialog에 pdf 보여주기", 결정 D-13). **연계:** [QIMPORT-01](questions-import.md), [QIMPORT-02](questions-import-layout.md), [RELSRC-01](related-sources.md), [QVIEW-01](question-viewer.md), [QPLAY-01](questions-practice.md), [SEARCH-01](search.md), [SEARCH-02](search-page.md), [DOCSUM-01](documents-summary.md), [AIEXPL-01](ai-explanations.md), [QSRC-01](question-source-preview.md), [UX12 계획](../implementation/ux12/index.md).

## 규칙

- **자리에서 연다:** 아래 원본 쪽 링크는 페이지를 떠나지 않고 `FloatingSidePanel` "원본 PDF"에서 그 쪽을 연다. URL과 history는 바뀌지 않고, 닫으면 focus가 누른 링크로 돌아오며 밑의 화면(스크롤, 고른 답, 선택)은 그대로다.

  | 화면 | 링크 | 여는 것 |
  |---|---|---|
  | 가져오기 초안 | `원본 n쪽` | 기존 원본 비교 panel을 그 쪽에서 연다 |
  | 문제 상세 `출처` | 문서 이름·쪽 | `PdfPageDialog` |
  | 관련 본문 행 | `PDF` | `PdfPageDialog` |
  | 본문 발췌 panel (본문 검색, 관련 본문, AI 해설) | `PDF에서 보기` | `PdfPageDialog` |
  | 문서 요약 핵심 항목 | `p.12–14` | `PdfPageDialog`, 범위의 첫 쪽 |

- **배치:** `PdfPageDialog`는 QSRC-01과 같은 paired 배치다. viewport 868px 이상에서는 연 panel의 왼쪽에 놓이고, 그보다 좁으면 전체 화면 sheet다. PDF는 기존 `GET /documents/:id/source-url` 중계와 `PdfViewer`로 보이며 쪽 이동과 확대가 된다.
- **전체 문서로 가기:** 두 panel 모두 `전체 문서 보기` 링크가 있다. 지금까지 원본 링크가 열던 DOC-02 주소이고 같은 탭에서 이동한다(발췌는 `?page=&block=&revision=`, 나머지는 `?page=`).
- **공유 화면은 그대로:** 게스트의 요약 쪽 링크, 본문 발췌, 관련 본문은 공유 문서 화면으로 이동한다. 게스트 PDF는 다른 경로로 받기 때문이다.
- **AI 질문 panel은 그대로:** AI 질문 대화의 발췌는 `PDF에서 보기`가 지금처럼 DOC-02 링크다. `sequence(mock)`의 `질문하기`로 제출 전에도 열리므로, 풀이 화면 위에 PDF 전체가 뜨면 안 된다(아래 규칙).
- **풀이 화면은 잘린 영역만:** QSRC-01은 풀이 화면에서 PDF 전체를 보이지 않는다(PDF에 정답이 있을 수 있음). 그래서 제출 전 풀이 화면(`practice`, `sequence`)에서는 `PdfPageDialog`에 닿는 길이 없다. 관련 본문과 AI 해설은 그 위치를 제출한 뒤에만 마운트되고, 후보도 `book` 문서뿐이다(RELSRC-01-C02). 다시 풀기로 답을 비우면 함께 사라진다. `문제 원문`(QSRC-01) dialog는 제출 전후 모두 잘린 영역만 보이고 `전체 문서 보기`가 없다.
- **문제 상세**는 정답을 이미 보이는 화면이므로 출처 링크가 그대로 전체 PDF를 연다.

## 수용 기준

### UX12-SOURCE-AC01

가져오기 페이지에서 초안의 `n쪽` 링크를 누르면 "원본 PDF" panel이 열리고 "지금 보는 쪽: n쪽"이다. URL은 같다. 쪽이 여럿인 초안은 누른 쪽에서 시작한다. `전체 문서 보기`는 DOC-02 그 쪽을 가리킨다. 닫으면 focus가 그 링크로 돌아온다. `원본 비교` 버튼은 지금처럼 첫 쪽에서 시작하고, `다음 초안`으로 옮긴 뒤 닫으면 focus가 마지막으로 본 초안의 `원본 비교`로 간다.

### UX12-SOURCE-AC02

"문제 상세" dialog의 `출처` 링크를 누르면 "원본 PDF" dialog가 그 쪽을 연다. URL은 같고, Escape는 이 dialog만 닫으며, focus는 그 링크로 돌아오고 "문제 상세"는 열린 채다.

### UX12-SOURCE-AC03

제출 뒤 관련 본문 행의 `PDF`를 누르면 "원본 PDF" dialog가 그 쪽을 연다. 풀이 panel은 옆에 보이고 URL은 같으며, 닫으면 focus가 `PDF`로 돌아온다. 본문 발췌 panel의 `PDF에서 보기`도 같다. `전체 문서 보기`는 DOC-02 그 쪽으로 이동한다.

### UX12-SOURCE-AC04

본문 검색의 발췌 panel에서 `PDF에서 보기`를 누르면 "원본 PDF" dialog가 그 쪽을 연다. URL은 같고, 닫으면 focus가 `PDF에서 보기`로 돌아오며 검색 결과는 그대로다. 휴대폰 폭에서는 전체 화면 sheet이고 가로 스크롤이 없다.

### UX12-SOURCE-AC05

문서 요약 핵심 항목의 쪽 링크를 누르면 "원본 PDF" dialog가 범위의 첫 쪽을 연다. URL은 같고, 닫으면 focus가 그 링크로 돌아오며 요약 panel은 열린 채다.

### UX12-SOURCE-AC06

제출 전 풀이 panel에는 "원본 PDF" dialog로 가는 링크가 없다(`관련 본문`, `PDF`, `전체 문서 보기` 없음). `문제 원문`은 잘린 영역만 보이고 `전체 문서 보기`가 없다. 제출하면 관련 본문의 `PDF`가 나타나고, 다시 풀기로 새로 푸는 동안에는 다시 없다.

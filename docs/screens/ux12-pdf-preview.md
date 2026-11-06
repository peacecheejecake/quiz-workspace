# UX12-PDFPREVIEW — PDF 출처 미리보기와 PDF 헤더

**Route:** 별도 route 없음(URL을 바꾸지 않는다). 풀이 panel, 범위 풀이, "문제 상세" dialog, 관련 본문, AI 해설, AI 질문의 PDF 출처.

**Phase:** UX12-PDFPREVIEW.0
**테스트:** `tests/e2e/documents/ux12-pdf-preview.spec.ts`

```yaml
id: UX12-PDFPREVIEW
linked_tests: [UX12-PDFPREVIEW-AC01 … UX12-PDFPREVIEW-AC11]
```

**상태:** UX12 DOCS-3 신규 2026-11-06 (사용자 요청 "문제 패널과 해설 패널에서 PDF 출처를 누르면 floating dialog에 해당 부분과 주변 페이지의 PDF 미리보기"). DOCS-4 신규 2026-11-06 (사용자 요청 "PDF 헤더의 간격과 배경색 정리, glassmorphism, 숨겨진 헤더를 탭과 hover로 다시 보기"). **연계:** [UX10-DOC](ux10-doc.md), [DOCVIEW-01](documents-viewer-layout.md), [UX12-SOURCE](ux12-source-panel.md), [QSRC-01](question-source-preview.md), [RELSRC-01](related-sources.md), [AIEXPL-01](ai-explanations.md), [ASK-01](ask-llm.md), [UX12-RUNASK](ux12-run-ask.md), [UX12 계획](../implementation/ux12/index.md).

## 규칙

- **표시:** dialog는 인용한 쪽에서 열리고, 인용 위치(bbox)가 있으면 그 자리에 `원문 위치` 표시를 그리며 그 자리로 스크롤한다. 주변 쪽은 같은 `PdfViewer`의 연속 스크롤로 닿는다. 화면의 쪽과 그 이웃만 그리고 나머지는 스크롤할 때 그린다. 모든 문서는 `pdfjs.ts`의 공유 `PDFWorker` 하나를 쓴다.
- **인용 위치:** 관련 본문, 본문 발췌, 문제 상세 `출처`는 인용 블록을 읽어 `locations`의 bbox를 쓴다. 블록을 읽지 못하거나 bbox가 없으면 표시 없이 그 쪽만 연다. 문서 요약 쪽 링크는 블록이 없으므로 쪽만 연다.
- **제출 전에는 잘린 영역만:** 정답이 안 보이는 문제의 `문제 원문`은 QSRC-01 그대로 잘린 영역만 보인다. 주변 쪽을 보이지 않는다. 문제지의 정답표는 인라인 정답 줄과 달리 서버가 알 수 있는 표시가 없고, 쪽 전체에는 다른 문제의 정답도 있기 때문이다. 그래서 제출 전 문제가 정답 쪽으로 스크롤되는 길이 없다.
- **`문제 원문`이 PDF를 여는 때:**

  | 화면 | 잘린 영역 | PDF 전체(영역 표시) |
  |---|---|---|
  | 풀이 panel(`practice`) | 제출 전, 다시 풀기 뒤 | 제출 뒤 |
  | 범위 풀이(`sequence(bank)`), 모의고사 풀이(`sequence(mock)`) | 풀이가 끝나기 전. 제출한 위치도 같다 | 풀이가 끝난 뒤(`finished_at`) |
  | 문제 상세(`manage`), 모의고사 문제 관리(`manage(mock)`) | 없음 | 언제나(정답을 이미 보인다) |

  범위 풀이가 끝나기 전에는 제출한 위치도 잘린 영역이다. 같은 PDF에 아직 풀지 않은 위치의 정답이 있을 수 있다. 영역이 두 문서에 걸치면 viewer 하나로 보일 수 없으므로 잘린 영역으로 둔다. 제목은 언제나 `문제 원문`이고 `전체 문서 보기` 링크는 없다. tooltip과 그림은 언제나 잘린 영역이다.
- **AI 질문:** 출처의 `PDF에서 보기`는 "원본 PDF" dialog를 연다. 정답이 숨겨진 문제가 아래에 열려 있으면(풀이 panel의 제출 전, 범위 풀이의 제출 전 위치) 지금처럼 DOC-02 링크다. AI 질문 근거는 `book` 문서뿐이다(ASK-01-C02). 범위 풀이의 제출한 위치에서는 관련 본문과 같은 기준으로 dialog를 연다.
- **AI 해설:** 각주는 본문 발췌 panel을 열고(AIEXPL-01), 그 `PDF에서 보기`가 dialog를 연다.
- **공유 게스트는 그대로:** 게스트는 `GET /documents/:id/source-url`을 쓸 수 없다. 출처는 공유 문서 화면으로 이동한다(UX12-SOURCE).
- **권한과 URL:** PDF는 기존 `source-url` 중계로 받는다. 구성원이면 누구나 받을 수 있고 새 권한이 없다. 서명 URL은 로그나 주소에 남지 않는다. 보장은 QSRC-01과 같이 화면 수준이다.
- **닫기:** 쌓기, Escape, Back, focus 복귀는 UX12-SOURCE와 QSRC-01 그대로다. 닫아도 밑의 panel 상태는 바뀌지 않는다.

## PDF 헤더 (DOCS-4)

- **무엇:** 문서 화면과 공유 문서 화면 위쪽의 chrome(제목, 발행 줄, `보기 설정`, PDF 보기 도구)이다. PDF 위에 겹쳐 뜨고 3초 뒤 숨는다(UX10-DOC-AC04).
- **표면:** chrome은 `.glass-surface`다. PDF가 그 뒤에 흐리게 비친다(design-system v1.3.3 사용자 결정). 전체 폭 띠이므로 테두리는 아래쪽만 있다. reduced transparency와 blur 미지원은 `.glass-surface` 규칙대로 단색이다.
- **간격:** 줄 사이는 `--space-2` 하나다. 안쪽 PDF 보기 도구는 자기 padding과 구분선이 없고 chrome의 padding을 쓴다. 제목 header의 아래 margin도 없다.
- **다시 보기:**

  | 입력 | 동작 |
  |---|---|
  | hover | 위쪽 48px로 pointer를 옮기면 나타난다 |
  | 터치, 펜 | PDF 쪽을 탭하면 나타나고, 보이는 동안 다시 탭하면 숨는다 |
  | 키보드 | `보기 도구 표시` 또는 chrome 안 컨트롤에 focus가 가면 나타난다 |

  탭은 10px 이내로 움직이고 500ms 안에 뗀 한 손가락 입력이다. 스크롤, pinch, 길게 누르기, 마우스 click은 탭이 아니다. 컨트롤 위 탭과 변환본 pane의 탭은 chrome을 건드리지 않는다. 고정 조건(교정 중, 경고, focus, menu)이 있으면 숨지 않는다.
- **배치:** chrome은 겹쳐 뜨므로 나타나고 숨어도 PDF가 움직이지 않는다. pane header 위의 3rem은 위쪽 48px hover 구역과 겹치지 않도록 그대로 둔다.
- **reduced motion:** 전환 없이 바로 나타나고 숨는다.
- **`PdfPageDialog`:** dialog의 도구 막대는 panel과 함께 glass 위에 있으므로 유리 층을 또 쌓지 않는다. 숨지 않는다.

## 수용 기준

### UX12-PDFPREVIEW-AC01

풀이 panel에서 제출 전 `문제 원문 보기`를 누르면 잘린 영역만 보인다. 쪽 입력, `PDF 페이지 영역`, `원문 위치`, `전체 문서 보기`가 없다.

### UX12-PDFPREVIEW-AC02

제출 뒤 `문제 원문 보기`를 누르면 그 쪽에서 PDF가 열리고 `원문 위치`가 보이며, 다음 쪽으로 스크롤하면 그 쪽이 그려진다. URL은 같다. 닫으면 focus가 버튼으로 돌아오고 채점 결과가 그대로다. `다시 풀기` 뒤에는 다시 잘린 영역이다.

### UX12-PDFPREVIEW-AC03

제출 뒤 관련 본문의 본문 발췌에서 `PDF에서 보기`를 누르면 "원본 PDF" dialog가 그 쪽을 열고 인용 블록의 `원문 위치`가 보이며 다음 쪽으로 스크롤할 수 있다. 닫으면 발췌 panel이 그대로이고 focus가 `PDF에서 보기`로 돌아온다.

### UX12-PDFPREVIEW-AC04

범위 풀이에서 한 위치를 제출해도 풀이가 끝나기 전에는 `문제 원문`이 잘린 영역이다. 결과 단계로 넘어간 뒤 그 위치를 다시 열면 PDF가 열리고 `원문 위치`가 보인다.

### UX12-PDFPREVIEW-AC05

AI 질문 각주의 본문 발췌에서 `PDF에서 보기`를 누르면 URL이 같은 채로 "원본 PDF" dialog가 그 쪽을 열고, 닫으면 focus가 돌아온다. 같은 대화를 제출 전 문제의 풀이 panel 위에서 열면 `PDF에서 보기`는 링크다.

### UX12-PDFPREVIEW-AC06

"문제 상세"의 `문제 원문 보기`는 그 dialog 위에 PDF를 열고 `원문 위치`를 보인다. Escape는 PDF만 닫고 focus가 버튼으로 돌아온다. 휴대폰 폭에서는 전체 화면 sheet이고 Back은 sheet만 닫으며 URL이 같다.

### UX12-PDFPREVIEW-AC07

문서 화면의 PDF 헤더는 `backdrop-filter` blur가 있고 배경색이 반투명이다.

### UX12-PDFPREVIEW-AC08

헤더가 숨은 뒤 pointer를 위쪽 끝으로 옮기면 나타난다. 숨을 때와 나타날 때 PDF pane의 위치와 크기가 같다.

### UX12-PDFPREVIEW-AC09

터치 화면에서 헤더가 숨은 동안 PDF 쪽을 탭하면 나타나고 다시 탭하면 숨는다. 스크롤, pinch, 길게 누르기, 변환본 pane의 탭은 바꾸지 않는다.

### UX12-PDFPREVIEW-AC10

헤더가 숨은 동안 `보기 도구 표시`에 focus가 가면 나타나고, chrome 안 컨트롤에 focus가 있는 동안 숨지 않는다.

### UX12-PDFPREVIEW-AC11

`prefers-reduced-motion: reduce`에서 헤더의 전환 시간은 0이다.

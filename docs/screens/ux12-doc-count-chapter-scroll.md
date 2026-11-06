# UX12-CHAPTERSCROLL — `문서 N` 수와 floating 목록 스크롤

**상태:** 구현 중 · [UX12 계획](../implementation/ux12/index.md) §4.3b HOME-7, CHAPTER-7 · [UX12-HEADER](ux12-home-header.md) · [UX12-PICKER](ux12-chapter-picker.md) · [UX9-SCROLL](overlay-scroll.md)
**Route:** `/workspaces/:workspaceId`
**테스트:** `tests/e2e/quality/ux12-doc-count-chapter-scroll.spec.ts` (단위: `apps/web/test/document-kinds.test.tsx`, `packages/ui/test/floating-scroll.test.tsx`)
**Phase:** UX12-CHAPTERSCROLL.0

## `문서 N` (HOME-7)

사용자 요청(2026-11-06): 홈의 `문서 N`은 문제 PDF와 본문 PDF를 나누지 않은 PDF 수다.

**세는 기준:** 문서 관리 목록의 행 수다. 사용자가 그 목록에서 보는 수와 늘 같다.

- 종류를 나누지 않는다. `교재`, `문제지`, `교재+문제`, 분류 전(`분석 중`) 모두 센다.
- 처리에 실패한 PDF도 목록에 행이 있으므로 센다. 이 탭에서 올리는 중인 파일도 행이 있으므로 센다.
- 문서에는 보관 상태가 없다. 삭제한 문서는 API 목록과 문서 관리에 없으므로 세지 않는다.

## floating 목록 스크롤 (CHAPTER-7)

사용자 확인(2026-11-06): iPadOS Safari에서 챕터 dropdown 목록이 터치로 스크롤되지 않는다.

**규칙:** modal panel 위로 portal된 floating 목록(`ChapterPicker`, `Select`, non-modal `Popover`, `DropdownMenu`, pointer 기준 preview)은 터치와 휠로 스크롤된다. 판단은 그 표면의 overscroll guard 하나가 한다.

- 안에서 더 스크롤할 수 있는 움직임은 브라우저에 맡기고, 스크롤 잠금에 닿지 않게 전파를 멈춘다. 잠금은 맨 위 잠금 밖의 대상을 취소하므로 modal panel 위의 non-modal 표면은 휠과 터치 모두 막혔다.
- 끝을 넘는 움직임은 지금처럼 취소한다. 아래 페이지와 panel은 움직이지 않는다.
- 손가락이 처음 4px을 움직이는 동안은 방향을 정하지 않는다. 잠금은 시작점에서 거리 0이거나 끝을 넘는 첫 touchmove를 취소했고, iOS는 첫 touchmove가 취소되면 그 제스처 전체를 스크롤하지 않는다. 목록은 맨 위에서 열리므로 iOS에서는 흔들림 한 번으로 스와이프가 죽을 수 있다.
- UA 판별은 없다. 모든 브라우저에서 같은 코드다.

**확인하지 못한 것:** 실제 iPad와 WebKit에서는 확인하지 못했다. 실제 Chromium에서 non-modal popover는 수정 전 휠과 터치 모두 움직이지 않았고 수정 뒤 움직인다. modal picker는 수정 전에도 Chromium에서 움직였다(Chromium은 작은 첫 움직임을 보내지 않는다). 첫 touchmove 취소는 jsdom의 실제 잠금에서만 재현했으므로, 이것이 사용자가 iPad에서 본 증상의 원인인지는 기기에서 확인해야 한다.

## 수용 기준

### UX12-CHAPTERSCROLL-AC01

교재 하나와 문제지 하나가 있는 Workspace의 홈에서 `문서 N`은 2다. 문서 관리 목록의 행도 2개이고, 문제지를 지우면 둘 다 1이 된다.

### UX12-CHAPTERSCROLL-AC02

폭 1024px 터치 환경의 modal `챕터 재분배` dialog에서 챕터가 많은 `옮길 챕터`를 연다. 목록 맨 위의 행에서 흔들림을 포함한 스와이프를 하면 어떤 touchmove도 취소되지 않고 picker는 열려 있다. 휠은 목록을 내리고 dialog는 움직이지 않는다. 끝에서 그 너머로 스와이프하면 취소된다. Chromium의 실제 터치 제스처는 목록을 움직인다.

### UX12-CHAPTERSCROLL-AC03

modal `AI 질문` panel의 non-modal `질문 범위` popover에 내용이 넘칠 때 휠은 popover만 내리고, 터치 스와이프는 취소되지 않으며, 끝을 넘는 움직임은 취소된다.

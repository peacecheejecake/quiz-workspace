# UX12-RUNCLOSE — 풀이 패널 닫기 확인

**Route:** `/workspaces/:workspaceId?practice=<run>&i=<k>`, `?panel=mock-exams&practice=<run>&i=<k>`

**Phase:** UX12-RUNCLOSE.0
**테스트:** `tests/e2e/questions/ux12-run-close.spec.ts`, `apps/web/test/ux12-run-close.test.tsx`

```yaml
id: UX12-RUNCLOSE
linked_tests: [UX12-RUNCLOSE-AC01 … UX12-RUNCLOSE-AC07]
```

**명세:** [UX12 MOCKUX-13](../implementation/ux12/index.md) (사용자 요청 2026-11-06), [QVIEW-01](question-viewer.md), [UX12-RESUME](ux12-run-resume.md), [HOMEDLG-01](home-dialogs.md), [design-system §5.1·§5.5](../design-system.md)

범위 풀이 패널(`QuestionViewer sequence`, `bank`·`mock`)을 풀이 도중에 닫으면 확인을 묻는다. QVIEW-01의 "닫기·Escape는 확인 없이 닫는다"(사용자 결정 2026-11-01)를 이 문서가 바꾼다. Heatmap 셀로 연 풀이 panel(`practice`)은 그대로 묻지 않는다.

## 결정

- **언제 묻나.** `solve` 단계에서 묶음을 읽었고, `finished_at`이 없고, 제출한 위치가 묶음 위치보다 적을 때다. 보관된 Workspace의 묶음도 같다.
- **묻지 않는 때.** `풀이 결과` 단계, 끝난 묶음, 모든 위치를 제출한 묶음(이어 풀 위치가 없어 목록에도 없다, UX12-RESUME), 시작 전 범위 단계, 묶음이나 위치를 읽는 중이거나 읽지 못한 때, 찾을 수 없는 묶음. 이때는 지금처럼 바로 닫는다.
- **어떤 닫기.** 닫기 버튼, Escape, backdrop click, swipe 닫기가 모두 같은 확인을 보인다. swipe는 패널이 제자리로 돌아오고 확인이 뜬다.
- **Back.** 브라우저 Back은 기존 기록 규칙 그대로 묻지 않는다(QOV-01-AC14). 확인이 열린 채 Back이나 Forward로 위치가 바뀌면 확인은 사라진다.
- **확인.** 공용 `ConfirmDialog`. 제목 `풀이를 닫을까요?`, 설명 `제출한 답은 저장되어 있습니다. 모의고사 목록의 이어 풀기로 계속 풀 수 있습니다.`, 버튼 `계속 풀기`와 `닫기`.
- **focus.** 처음 focus와 Escape는 `계속 풀기`다. `계속 풀기`로 돌아오면 확인을 부르기 전 패널 안의 focus로, 그런 곳이 없으면 패널 제목으로 돌아온다. `닫기`는 패널을 닫아 지금처럼 opener로 돌아온다.
- **쌓임.** 확인은 패널 위에 쌓이고 맨 위 하나만 활성이다. Escape는 design-system §5.5대로 맨 위부터 닫는다. 패널 위에 `문제 원문`이나 AI 질문 panel이 열려 있으면 그것부터 닫고, 그다음 Escape가 확인을 부른다. 확인은 backdrop으로 닫히지 않는다.
- **입력 중인 답.** 제출하지 않은 답은 저장되지 않는다. 그래서 설명은 `제출한 답`이라고 쓴다. `계속 풀기`는 고르던 답을 그대로 둔다.
- **닫은 뒤.** `닫기`는 기존 닫기와 같다. 기록 항목을 되돌리고, Heatmap과 모의고사 목록을 다시 읽고, 모의고사 목록에서 연 풀이는 그 목록으로 돌아간다. 묶음은 끝내지 않는다.

## 수용 기준

### UX12-RUNCLOSE-AC01

- **Given:** 3문제 원본 풀이의 1번을 풀고 있다
- **When:** 패널 닫기 버튼을 누른다
- **Then:** `풀이를 닫을까요?` 확인이 패널 위에 뜨고, 설명은 저장과 `이어 풀기`를 말하며, focus는 `계속 풀기`에 있다. URL은 그대로다.

### UX12-RUNCLOSE-AC02

- **Given:** AC01의 확인. 패널에서 보기를 하나 골랐다
- **When:** `계속 풀기`를 누른다. 다시 확인을 열어 Escape를 누른다
- **Then:** 두 번 다 확인만 닫히고 같은 위치의 패널이 그대로이며 고른 보기도 그대로다. focus는 확인을 부른 패널 닫기 버튼으로 돌아온다.

### UX12-RUNCLOSE-AC03

- **Given:** 모의고사 목록의 `이어 풀기`로 패널을 열고 확인을 불렀다
- **When:** `닫기`를 누른다
- **Then:** 확인과 패널이 모두 닫히고 dialog가 더 뜨지 않는다. `practice` URL 값이 빠지고 focus는 opener로 돌아오며, Back이 패널을 다시 열지 않는다. 목록은 새로 고침 없이 다시 읽힌다.

### UX12-RUNCLOSE-AC04

- **Given:** 풀이 도중의 패널
- **When:** Escape, backdrop click, swipe 닫기를 차례로 쓰고 매번 `계속 풀기`로 돌아온다
- **Then:** 매번 같은 확인이 하나만 뜨고 패널은 열려 있다. swipe한 패널은 제자리로 돌아온다.

### UX12-RUNCLOSE-AC05

- **Given:** `풀이 결과` 단계, 끝난 묶음의 위치, 시작 전 범위 단계, 또는 모든 위치를 제출한 묶음
- **When:** 닫기 버튼이나 Escape로 닫는다
- **Then:** 확인 없이 바로 닫힌다.

### UX12-RUNCLOSE-AC06

- **Given:** 모의고사 목록에서 저장된 모의고사의 풀이를 시작해 풀고 있다
- **When:** 패널을 닫고 확인의 `닫기`를 누른다
- **Then:** 모의고사 화면으로 돌아온다. 풀이 URL 값은 빠지고 `panel=mock-exams`는 남는다.

### UX12-RUNCLOSE-AC07

- **Given:** 2번 위치의 패널
- **When:** 브라우저 Back을 누른다. 다음으로 확인을 연 채 Back을 누른다
- **Then:** Back은 확인 없이 1번 위치로 돌아간다. 확인이 열려 있으면 위치가 바뀌며 확인이 사라지고 Forward로 돌아와도 다시 뜨지 않는다.

# UX12-QEDIT — 보기 순서 끌기·줄바꿈 입력

**Route:** `/workspaces/:workspaceId?question=<id>` › 문제 관리 › 편집 (같은 입력을 가져오기 초안 편집기·모의고사 문제 편집기가 공유)

**Phase:** UX12-QEDIT.0
**테스트:** `tests/e2e/questions/ux12-question-edit.spec.ts`

```yaml
id: UX12-QEDIT
linked_tests: [UX12-QEDIT-AC01 … UX12-QEDIT-AC04]
```

**명세:** [UX12 VIEW-3](../implementation/ux12/index.md) (사용자 피드백 "dnd: 문제 편집 > 보기 순서 조정", "보기 줄바꿈 유지"), [QPLAY-01-AC07](questions-practice.md), [UX12-OPTIONS](ux12-options.md), `docs/questions.md` §4.3

## 규칙

- **범위:** `QuestionContentFields`의 객관식 보기 목록. 문제 편집, 가져오기 초안 편집, 모의고사 문제 편집이 같은 동작을 얻는다.
- **순서와 채점:** 보기 ID와 정답 표시는 보기와 함께 움직인다. 저장 요청은 보기를 새 순서로, 정답을 같은 ID로 보낸다. 표시 번호 `보기 N`만 새 위치를 따른다.
- **손잡이:** 각 보기 왼쪽의 세로 손잡이(`GripIcon`, `data-option-handle`)를 포인터나 터치로 끈다. 손잡이 밖의 입력과 버튼은 끌기를 시작하지 않는다. 4px 이상 움직여야 끌기가 시작되고 목록의 세로 방향으로만 움직인다. 터치에서는 손잡이가 페이지 대신 끌기를 받는다(`touch-action: none`).
- **끄는 중 표시:** 끄는 보기의 미리보기가 포인터를 따라간다. dialog에 transform이 있어도 위치가 어긋나지 않도록 `document.body`로 portal하고, dialog보다 위에 놓는다. 동작 줄이기 설정에서는 놓을 때 미리보기가 날아가는 동작이 없다.
- **키보드·보조 기술:** 끌기의 대체 수단은 기존 `위로`·`아래로` 버튼이다(WCAG 2.5.7). 손잡이는 포인터 전용이므로 tab 순서와 접근성 트리에 들어가지 않는다.
- **줄바꿈 입력:** 보기 입력은 여러 줄 입력(`Textarea`)이다. Enter는 줄을 나누고 저장하지 않는다. 공백과 줄바꿈뿐인 보기는 빈 보기와 같은 오류다. 표시는 [UX12-OPTIONS](ux12-options.md)의 `pre-wrap`을 따른다.
- **배치:** 입력 폭을 지키려고 정답·위로·아래로·삭제는 입력 아래 줄로 옮긴다.

### UX12-QEDIT-AC01

**끌어서 순서 변경:** 문제 편집에서 정답인 `보기 1`의 손잡이를 끌어 `보기 3` 자리에 놓으면 끄는 동안 미리보기가 포인터 옆에 있고, 놓은 뒤 입력 순서가 바뀌고 `보기 3 정답`이 선택된 상태다. 저장하면 문제의 보기 ID는 그대로이고 순서만 바뀌며 `correct_option_ids`는 같다. 풀이 panel에서 그 보기를 고르고 제출하면 정답이다.

### UX12-QEDIT-AC02

**터치 끌기:** 손잡이의 `touch-action`은 `none`이고, `pointerType: 'touch'`의 포인터 이벤트로 끌어도 같은 결과다. 짧게 건드리기만 하면(4px 미만) 순서가 바뀌지 않는다.

### UX12-QEDIT-AC03

**키보드 순서 변경:** `보기 N 위로 이동`·`보기 N 아래로 이동` 버튼으로 끌기와 같은 순서 변경이 된다. 손잡이는 `aria-hidden`이고 focus를 받지 않는다.

### UX12-QEDIT-AC04

**줄바꿈 입력:** 보기 입력에서 Enter를 누르면 dialog가 닫히거나 저장되지 않고 줄이 나뉜다. 저장 후 다시 열어도 줄바꿈이 남고, 풀이 panel에서 줄이 나뉘어 보인다. 공백과 줄바꿈뿐인 보기는 저장되지 않고 해당 보기에 오류가 뜬다.

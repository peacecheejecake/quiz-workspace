# UX12-SETTINGS — 화면 테마·드래그 자동 복사

**Route:** `/settings/preferences`, 인증된 앱 셸의 사용자 메뉴

**Phase:** UX12-SETTINGS.0
**테스트:** `tests/e2e/quality/ux12-settings.spec.ts`

```yaml
id: UX12-SETTINGS
linked_tests: [UX12-SETTINGS-AC01, UX12-SETTINGS-AC02, UX12-SETTINGS-AC03, UX12-SETTINGS-AC04, UX12-SETTINGS-AC05, UX12-SETTINGS-AC06, UX12-SETTINGS-AC07, UX12-SETTINGS-AC08]
```

**명세:** [UX12 SHELL-3·SHELL-4](../implementation/ux12/index.md) (결정 D-5), [design-system §3.2](../design-system.md), [HILITE-01](highlights.md)

사용자 피드백 "light/dark mode 버튼", "설정: 드래그 → 자동 복사".

## 화면 테마

### UX12-SETTINGS-AC01

사용자 메뉴에 `화면 테마` radio 묶음이 있고 `시스템`·`라이트`·`다크`를 고른다. 고른 적이 없으면 `시스템`이다. 화살표 키로 고를 수 있고, 고른 뒤에도 메뉴는 열려 있으며 선택 상태는 radio 표시와 `aria-checked`로 전달한다.

### UX12-SETTINGS-AC02

`라이트`·`다크`를 고르면 바로 적용되고 이 브라우저의 `quiz-theme` cookie에 저장된다. 새로고침·재방문하면 서버가 응답 HTML의 `<html>`에 `data-theme`을 찍어 보내므로 다른 테마가 잠깐 보이지 않는다. 인라인 script를 쓰지 않아 CSP nonce는 그대로다. 잘못된 cookie 값은 없는 것으로 다룬다.

### UX12-SETTINGS-AC03

`시스템`에서는 cookie를 지우고 `<html>`에 `data-theme`을 두지 않아 token의 `prefers-color-scheme` media query가 테마를 정한다. 운영체제 설정이 바뀌면 script 없이 바로 따라간다.

## 드래그 자동 복사

설정은 이 브라우저의 `localStorage`에만 저장한다(계정에 동기화하지 않음, 기본 꺼짐). 동작 범위는 인증된 앱 셸이다. 공유 게스트 화면과 로그인 화면에는 없다.

### UX12-SETTINGS-AC04

사용자 메뉴의 `설정` 링크가 `/settings/preferences`를 연다. 화면에 `드래그하면 자동 복사` Switch가 있고 기본은 꺼짐이다. 꺼져 있으면 글자를 끌어 골라도 클립보드와 토스트가 변하지 않는다. 미인증 진입은 `/login?next=`로 보낸다.

### UX12-SETTINGS-AC05

켜면 설정 화면을 떠나지 않아도 바로 적용되고 새로고침 뒤에도 유지된다. 마우스로 글자를 끌어 고르면 고른 글자를 클립보드에 쓰고 토스트 `복사했습니다.`를 표시한다. 더블클릭 단어 선택도 포인터 선택이다. 연달아 고르면 토스트는 하나만 남는다. 클립보드를 쓸 수 없는 브라우저와 권한 거부에서는 토스트 없이 넘어간다(드래그마다 오류를 띄우지 않음).

### UX12-SETTINGS-AC06

복사는 포인터 선택에서만 일어난다. 키보드로 넓힌 선택, 오른쪽 버튼, 이미 있는 선택을 그대로 둔 클릭(하이라이트 메뉴 항목 포함)은 복사하지 않는다. `input`·`textarea`·`select`·contenteditable 안에서 시작했거나 그 안에 있는 선택도 복사하지 않는다.

### UX12-SETTINGS-AC07

`HighlightableText`(정리 노트·해설)에서는 복사 내용이 Ctrl+C·OS 복사와 같다(하이라이트 메뉴의 `복사`는 2026-11-07에 없앴다): 숨김 라벨과 각주 표시를 뺀 `rangeText` 결과다. 하이라이트 메뉴는 평소처럼 열리고, 자동 복사가 선택을 지우거나 focus를 옮기지 않는다. 그 밖의 화면은 브라우저 기본 복사와 같은 `Selection.toString()`을 쓴다(문단 줄바꿈 유지).

### UX12-SETTINGS-AC08

터치는 데스크톱 우선 범위 밖이다. iOS는 긴 누름 선택이 끝나는 시점을 안정적으로 알 수 없고 클립보드 쓰기에 사용자 제스처가 필요하므로, 터치 포인터로는 복사하지 않는다. 설정 설명에 데스크톱 우선임을 적는다.

고른 글자는 클립보드 외의 곳으로 보내지 않는다: 로그·서버 요청·저장소·trace에 남기지 않는다.

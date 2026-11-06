# UX12-SHARE — 공유 범위 선택과 Owner 기록 읽기 전용 공개

**E2E:** `tests/e2e/quality/ux12-share-scope.spec.ts`

**Phase:** `UX12-SHARE.0`

공유·Fork의 공통 규칙은 [workspace-sharing.md](../workspace-sharing.md) §1·§3·§5·§6·§11·§12가 정한다. 이 문서는 UX12-SHARE-1·SHARE-2에서 더한 AC만 둔다. 사용자 결정(2026-11-06, UX12 D-9): 제외 선택을 먼저 만들고, 게스트가 Owner 기록을 읽기 전용으로 볼 수 있는 옵션을 더한다. Fork에는 복사하지 않는다.

## 링크 옵션

| 옵션 | 기본값 | 끄거나 켰을 때 |
|---|---|---|
| `include_notes` | 켜짐 | 끄면 정리 노트 카드가 없고 `/chapter-notes`·`/chapters/{id}/note`가 404, Fork에 노트 복사 없음 |
| `include_ai_explanations` | 켜짐 | 끄면 문제 panel에 AI 해설이 없고 `/questions/{id}/ai-explanation`이 404, Fork에 AI 해설 복사 없음 |
| `include_summary` | 켜짐 | 끄면 `요약` 버튼이 없고 `/documents/{id}/summary`가 404, Fork에 요약·자동 갱신 설정 복사 없음 |
| `include_owner_records` | 꺼짐 | 켜면 `공유자의 기록` 카드가 생기고 `/owner-attempts`·`/owner-highlights`가 열림. 꺼지면 카드가 없고 둘 다 404 |

기존 링크는 migration의 기본값으로 지금과 똑같이 동작한다. 재발급은 네 옵션을 그대로 옮긴다. 404 응답은 없는 id와 같은 본문이다.

### UX12-SHARE-AC01
Owner가 `링크 공유` dialog를 열면 `공유 범위`에 `정리 노트`·`AI 해설`·`문서 요약`이 켜진 스위치로, `내 풀이 이력·하이라이트`가 꺼진 스위치로 보인다. 링크가 있으면 바꾸는 즉시 저장되고 다시 열어도 유지되며, 재발급한 링크도 같은 값을 갖는다. 링크가 없으면 다음 링크를 만들 때 그 값을 쓴다. Owner가 아닌 계정의 같은 PATCH는 403이다.

### UX12-SHARE-AC02
`문서 요약`을 끈 링크의 게스트에게는 `요약` 버튼이 없고, 요약 API는 없는 문서와 같은 본문의 404다. 다시 켜면 같은 세션에서 다시 보인다.

### UX12-SHARE-AC03
`정리 노트`를 끈 링크의 게스트에게는 `정리 노트` 카드가 없고, 노트 목록·노트 API는 404다.

### UX12-SHARE-AC04
`AI 해설`을 끈 링크의 게스트가 문제 panel을 열면 사람이 쓴 해설은 보이고 `AI 해설` 영역은 없으며, AI 해설 API는 404다.

### UX12-SHARE-AC05
Fork는 요청 시점의 옵션을 manifest에 고정하고 commit 직전에 링크를 다시 읽는다. 두 시점 중 한 번이라도 꺼진 항목은 사본에 없다(이후 다시 켜도 그 Fork에는 없다). 옵션 변경만으로 Fork가 취소되지는 않는다. Owner 기록(`question_attempts`, `question_user_states`, `user_highlights`)은 옵션과 무관하게 복사되지 않는다.

### UX12-SHARE-AC06
`내 풀이 이력·하이라이트`가 꺼진 링크(기본)의 게스트에게는 `공유자의 기록` 카드가 없고, `/owner-attempts`·`/owner-highlights`는 없는 id와 같은 본문의 404다. 응답 어디에도 풀이·하이라이트가 없다(WS-VIEW-01-AC04).

### UX12-SHARE-AC07
옵션을 켠 링크의 게스트는 `공유자의 기록` panel에서 Owner의 풀이 이력(문제 번호·발문 앞부분·결과·제출 시각)과 하이라이트(인용문·색·문제 또는 장 이름)를 읽기 전용으로 본다. 응답과 화면 어디에도 Owner의 id·이름·이메일, 다른 구성원의 풀이·하이라이트, 제출 답안 원문이 없고, 만들기·바꾸기·지우기·즐겨찾기 조작이 없다. 공유 세션으로 쓰기 API를 불러도 저장되지 않는다.

### UX12-SHARE-AC08
옵션을 켜도 공개 범위 밖의 기록은 나오지 않는다. 확정되지 않았거나 지워진 문제의 풀이·하이라이트, 해설이 바뀌어 현재 해설에서 찾을 수 없는 인용문, 게스트가 지금 읽을 수 없는 노트 버전의 하이라이트, `정리 노트`를 끈 링크의 노트 하이라이트는 없다. 모의고사 풀이도 없다. 공유 설정의 공개 범위 안내는 옵션을 켜면 Owner 기록이 공개된다고 바꿔 말한다.

# UX12-HELP — 도움말

**Route:** `/help`

**Phase:** UX12-SETTINGS.0
**테스트:** `tests/e2e/quality/ux12-help.spec.ts`

```yaml
id: UX12-HELP
linked_tests: [UX12-HELP-AC01, UX12-HELP-AC02, UX12-HELP-AC03]
```

**명세:** [UX12 SHELL-6](../implementation/ux12/index.md) (결정 D-6)

사용자 피드백 "Release note → help center?". 사용자 메뉴에서 여는 정적 페이지이며 릴리스 노트는 그 한 절이다. 서버 데이터가 없고 내용은 코드에 있다.

### UX12-HELP-AC01

사용자 메뉴의 `도움말` 링크가 `/help`를 연다. 메뉴는 닫히고 앱 셸(사용자 메뉴 포함)이 유지되며, 제목 `도움말`과 절 제목(h2)이 차례로 보인다.

### UX12-HELP-AC02

`릴리스 노트` 절은 최신 묶음부터 날짜 제목(h3)과 사용자가 알아볼 말로 쓴 변경 목록을 보여 준다. 실제로 포함된 변경만 적고 내부 Task ID는 쓰지 않는다.

### UX12-HELP-AC03

`/help`는 `/settings/**`처럼 보호 구역이다. 미인증 진입은 `/login?next=/help`로 보내고 로그인하면 돌아온다. 320px 폭에서 가로로 넘치지 않는다.

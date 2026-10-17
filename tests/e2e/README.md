# 화면 명세 우선 Playwright E2E — v1.3 (P0.10 harness)

E2E는 `docs/screens/*.md`의 AC를 먼저 테스트로 옮기고(RED) 구현으로 GREEN을 만드는 계층이다. 원칙은 [e2e-strategy](../../docs/e2e-strategy.md), 순서는 [implementation-plan](../../docs/implementation-plan.md)을 따른다. 이 문서는 harness 사용법이다.

## 디렉터리

| 경로 | 내용 |
|---|---|
| `harness/*.spec.ts` | harness 자체 검사(`HARNESS-nn`). stub route·헤더·locale/timezone·fixture 동작 확인 |
| `fixtures/` | `test.ts`(공용 `test`/`expect`), `auth.ts`(사용자 팩토리·로그인), `mailpit.ts`(메일 링크), `local-env.ts`(로컬 URL·키, 비로컬 거부) |
| `setup/` | `auth.setup.ts`/`auth.teardown.ts`: authenticated 프로젝트용 공용 사용자와 `storageState` |
| `_pending/` | harness 이전 starter spec. **실행·lint·format 대상 아님**. 각 RED Task가 화면 명세 경로로 옮겨 확장한다 |
| 그 외 `auth/`, `workspaces/`, `documents/`, `questions/` … | 화면 명세에 선언된 경로의 AC spec (RED Task가 생성) |

## 실행

```bash
make e2e-browsers   # 최초 1회: Chromium + WebKit만 설치 (Firefox 미사용)
make infra-up       # Supabase(Auth, Mailpit) + Qdrant/Redis — @infra 테스트와 사용자 fixture에 필요
pnpm e2e            # = make e2e. 웹 서버가 없으면 apps/web production build 후 next start
pnpm e2e --project harness-chromium        # 프로젝트 하나만
pnpm e2e --grep-invert @infra              # 인프라 없이 돌 수 있는 테스트만
pnpm exec playwright show-report           # 실패 trace/스크린샷 확인
pnpm e2e:trace      # = make e2e-trace. AC ↔ test 대조 리포트 (항상 exit 0)
make infra-down
```

- **웹 서버**: `next build` + `next start`(production)로 띄운다. 실제 배포와 같은 헤더·번들이며 dev overlay/HMR로 인한 flaky가 없다. 로컬에서는 `E2E_BASE_URL`(기본 `http://127.0.0.1:3000`)에 이미 서버가 떠 있으면(`make web-dev` 등) 재사용한다. CI는 항상 새로 빌드한다.
- **브라우저 환경 고정**: 모든 프로젝트 `locale: ko-KR`, `timezoneId: Asia/Seoul`, `reducedMotion: reduce`, `colorScheme: light`. 시계가 필요한 테스트는 `page.clock`으로 각자 고정한다.
- **인프라 의존 테스트**: title에 `@infra` tag를 붙인다. 스택이 꺼져 있으면 skip이 아니라 **실패**한다(`make test-infra`와 같은 원칙).

## 프로젝트

| 프로젝트 | 대상 | 세션 |
|---|---|---|
| `harness-chromium` / `harness-webkit` | `harness/*.spec.ts` | 없음 |
| `unauthenticated-chromium` / `unauthenticated-webkit` | `auth/*.spec.ts`(단, `account-security.spec.ts` 제외), `workspaces/share-public.spec.ts` | 없음(cookie 없는 새 context) |
| `setup` → `authenticated-chromium` / `authenticated-webkit` → `teardown` | 위 이외의 모든 spec | `playwright/.auth/user.json` |

`setup`/`authenticated-*`/`teardown`은 **authenticated spec이 하나라도 생겼을 때만** 등록된다. `setup`은 사용자 팩토리로 확인 완료 사용자를 만들고 실제 `/login` UI로 로그인해 `storageState`를 저장하므로, `/login`이 stub인 지금은 통과할 수 없다. 세션 형식(Supabase SSR cookie)은 A2.1이 정하며 그때 `setup/auth.setup.ts`를 마무리한다. 가짜 cookie 형식을 만들어 넣지 않는다.

## Fixture

```ts
import { expect, test, signIn, waitForMailLink } from '../fixtures/test.ts';

test('AUTH-01-AC02 ...', async ({ page, userFactory }) => {
  const user = await userFactory.create({ label: 'auth01-ac02' }); // 확인 완료 사용자
  // userFactory.create({ confirmed: false }) → 미확인 사용자(가입·인증 흐름)
  // signIn(user) → Auth API 세션(accessToken/refreshToken) — API contract 준비용
  // waitForMailLink(email, { since }) → Mailpit 최신 메일의 단일 링크 (AUTH-03/05/06)
});
```

- 테스트마다 고유 사용자(`e2e-<label>-<uuid>@example.test`, 무작위 비밀번호)를 만들고 **teardown에서 삭제**(실패해도 삭제)하며 해당 주소의 Mailpit 메일도 지운다. 쓰기 테스트는 공유 fixture에 병렬로 쓰지 않는다.
- 사용자 생성·삭제는 Supabase Auth admin API를 쓴다. 키는 `SUPABASE_SECRET_KEY`/`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` 환경 변수 또는 `pnpm exec supabase status -o json`에서 실행 시 읽고 메모리에만 둔다. 커밋·로그·에러 메시지에 남기지 않는다.
- 모든 fixture는 `E2E_BASE_URL`·`NEXT_PUBLIC_SUPABASE_URL`·`E2E_MAILPIT_URL`이 loopback(127.0.0.1/localhost)이 아니면 즉시 실패한다(운영 프로젝트 보호).
- 앱에 test 전용 seed/reset endpoint를 만들지 않는다. 데이터는 공개 API(또는 로컬 Auth admin API)로 만든다.
- **데이터 fixture**(M3.0): `workspaceFactory`(`fixtures/workspaces.ts`) — `member(label)`은 사용자 + API 세션, `create/list/archive/softDelete`는 공개 Workspace API를 호출한다. `fixtures/documents.ts` — 합성 PDF를 공개 업로드 흐름(upload-intent → Storage 직접 업로드 → complete-upload)으로 올리고 `GET /jobs/{id}`를 `expect.poll`로 기다리며, 검색 API를 호출한다. API 호출은 `fixtures/api.ts`(Node `fetch`, trace에 토큰 미기록)로 하고, 엔드포인트가 없으면 `POST /api/v1/workspaces not implemented (404)`처럼 실패한다. 요청/응답 형태와 UI label 계약은 각 파일 머리 주석(`workspace-ui.ts` 포함)에 있다.
- **DB superuser**(`fixtures/db.ts`, `psql`): teardown에서 테스트 사용자가 소유한 Workspace를 hard delete(`owner_id`가 `on delete restrict`, API는 soft delete만 함)하고, 공개 API가 없는 상태 중 서버 거부가 AC인 경우(DOC-02-AC05 viewer membership)에만 seed한다.
- **FastAPI**: `playwright.config.ts`가 웹 서버와 함께 `python -m quiz_api.serve`를 `NEXT_PUBLIC_API_BASE_URL`(기본 :8000)에 띄운다(로컬은 이미 떠 있으면 재사용). 병렬 worktree와 포트가 겹치면 `E2E_BASE_URL`/`NEXT_PUBLIC_API_BASE_URL`을 다른 포트로 지정한다(인증 메일 링크는 Supabase `site_url` :3000을 가리키므로 HARNESS-09·메일 기반 AUTH 테스트는 기본 포트에서만 통과).
- **확장 지점**(`fixtures/test.ts`): S0 owner/guest/recipient 공유 fixture. 같은 패턴(생성 → 추적 → teardown 삭제)으로 추가한다.

## Trace/artifact와 비밀값

- `trace: retain-on-failure`, `screenshot: only-on-failure`, `video: on-first-retry`. CI artifact(`playwright-report/`, `test-results/`) 보존 기간 7일.
- Playwright trace는 `page`/`request`의 네트워크 본문과 `fill` 입력값을 기록한다. 그래서 fixture는 Auth/Mailpit 호출에 **Node `fetch`만** 쓰고, admin 키·세션 토큰·메일 링크는 trace에 들어가지 않는다(실패 trace를 직접 검사해 확인). 메일 링크·토큰을 test title, `console.log`, attachment에 넣지 않는다.
- 남는 위험: UI 로그인(`setup`, AUTH 화면 테스트)의 trace에는 입력한 비밀번호와 응답 cookie가 포함된다. 모두 **로컬/CI 일회용 스택의 합성 사용자**(테스트 후 삭제, 로컬 전용 서명 키, 1시간 만료)이므로 실사용 비밀이 아니다. 실제 계정·운영 URL은 E2E에 절대 쓰지 않는다.
- 공유 링크 비밀값은 이 예외에 포함되지 않는다. 공유 spec(`workspaces/{sharing-owner,share-public,fork}.spec.ts`)은 trace·screenshot·video를 끄고, 실패 시 비밀값을 가린 페이지 텍스트(`page-text-redacted`)만 첨부한다. 실행 직후 `pnpm e2e:artifact-audit`가 `test-results/`·`playwright-report/`(trace zip, report 내장 zip 포함)에서 알려진 비밀값과 `#k=` fragment를 찾아 있으면 실패한다(규칙: `fixtures/sharing.ts` 머리 주석).

## RED Task가 할 일

1. `_pending/`의 starter가 있으면 화면 명세에 선언된 경로로 옮기고(`questions/overview.spec.ts` → `questions/questions-overview.spec.ts` 등) `../fixtures/test.ts`의 `test`를 쓰도록 바꾼다. 하드코딩된 `e2e-ws` 같은 ID 대신 factory로 만든 데이터를 쓴다.
2. test title은 AC ID로 시작한다(`AUTH-01-AC03 ...`). API contract test(예: `AUTH-API-AC01`)는 `tests/integration/`의 pytest 함수 이름에 ID를 넣는다(`def test_auth_api_ac01_missing_jwt_is_401`).
3. `pnpm e2e`로 RED를 확인한다. 실패 원인이 서버·seed·네트워크가 아닌 **미구현 기능**이어야 한다.
4. `pnpm e2e:trace --strict --phase <Task>`(예: `A0`)로 해당 화면에 orphan AC/잘못된 경로가 없는지 확인한다. `--screens WS-01,DOC-01`로 화면을 직접 지정할 수도 있다.
5. Phase가 GREEN이 되면 `.github/workflows/ci.yml`의 `E2E_PHASES`에 Task ID를 추가한다. CI는 `tests/e2e`의 모든 spec에서 **목록에 없는 phase의 화면 spec만 빼고** 실행하며(`e2e:trace --list-specs --exclude-phase`; harness·a11y 등 phase에 속하지 않는 spec은 항상 실행), 목록의 phase에 trace를 강제한다(develop의 진행 중 RED는 CI에서 돌리지 않음). E2E는 `e2e:log-audit --worker`(web :3000, API :8000, `APP_ENV=test` worker)로 돌고 이어서 `e2e:artifact-audit`를 실행한다.

`e2e:trace`는 `docs/screens/*.md`의 `### <ID>-ACnn` 제목과 선언된 spec 경로, `docs/auth.md` §7의 `AUTH-API-ACnn`을 읽고 `tests/e2e/**/*.spec.ts`(`_pending` 제외) title과 `tests/integration/**/*.py`의 test 함수 이름을 대조해 orphan AC, orphan test, 경로 불일치, ID 없는 title, `test.only/skip/fixme`를 보고한다.

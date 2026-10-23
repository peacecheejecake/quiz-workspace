# Screen-Spec-Driven E2E Development — v1.0 (Platform v1.2)

**원칙:** 기능을 구현한 뒤 테스트를 붙이지 않는다. **화면별 요구사항(AC) 문서를 먼저 승인하고, AC를 검증하는 실패하는 Playwright E2E를 먼저 커밋한 뒤 구현을 진행**한다. 이 문서와 `docs/screens/`가 UI 기능·테스트·릴리즈 게이트의 기준이다.

## 1. Spec-first RED → GREEN → REFACTOR → RELEASE

```text
User story / change request
   ↓
Screen spec in docs/screens/SCREEN.md
   - route, actor, goal, UI states
   - visible behavior, URL/navigation
   - error, empty, loading, access control
   - desktop/iPad/mobile, keyboard, a11y
   - Given / When / Then acceptance criteria (AC IDs)
   ↓
Write Playwright E2E for each AC + deterministic fixture
   ↓
Run E2E: RED (기대한 미구현 실패인지 확인)
   ↓
Implement API/schema/worker/UI to meet contract
   ↓
Run E2E: GREEN + unit/integration
   ↓
Refactor + visual/accessibility regression
   ↓
PR: Spec AC ↔ test ID ↔ implementation ↔ run evidence
```

- 먼저 실패한 이유가 **기능 미구현**인지 반드시 확인한다. 서버 미기동, 테스트 데이터 미설치, 네트워크 오류로 인한 RED는 인정하지 않는다.
- 아직 구현할 수 없는 화면은 안정적인 stub route/contract를 두어 RED 원인이 명확하도록 한다. 임의의 `test.skip`으로 완료 처리하지 않는다.
- API/DB 계약이 선행되어야 하는 기능은 contract tests(먼저 RED) → API 구현 → 브라우저 E2E(GREEN) 순서로 진행하되, 브라우저 AC 테스트 파일 자체도 UI 구현 전에 존재해야 한다.
- E2E 실패를 구현 스텝에 맞춰 cherry-pick하는 방식은 가능하나, main branch에는 의도적으로 실패하는 테스트를 합치지 않는다. feature branch의 RED evidence는 PR에 남기고 GREEN 전 merge 금지.

## 2. Screen Requirement Template

각 화면은 `docs/screens/<name>.md`에 아래 항목을 반드시 기록한다.

```yaml
id: QUESTIONS-OVERVIEW
route: /workspaces/:workspaceId/questions
actor: workspace_member
permission: read
status: confirmed
api: [GET /api/v1/workspaces/:id/questions/overview]
components: [QuestionHeatmap, QuestionMarker, FloatingSidePanel]
linked_tests: [QOV-AC01, QOV-AC02]
```

1. 목적 / 전제조건 / 역할 및 접근 제어
2. 화면 계층(layout), 공통 design components, URL/route
3. 주요 사용자 흐름 및 행동 결과
4. 화면 상태: initial/loading/empty/success/error/offline/unauthorized/archived
5. Given/When/Then 형식의 AC, 고유한 `SCREEN-ACXX` ID
6. 모바일·터치·키보드·스크린리더 요구사항
7. 관련 API, 데이터 필드, 이벤트 이력, 실패 재시도
8. Playwright E2E 파일명, test title(`AC ID` 포함), fixture 명세

스크린 하나가 바뀌면 해당 AC와 E2E를 같은 PR에서 함께 변경한다. API도 바뀌는 경우 OpenAPI 계약과 backend integration test를 동기화한다.

## 3. E2E 프로젝트/데이터 설계

- Framework: **Playwright** (Chromium Desktop baseline + WebKit/iPad 주요 flow + Mobile Chrome smoke).
- `tests/e2e/unauthenticated`: 로그인/가입/리셋, 미인증 라우트 차단. Cookie 없는 새 context 사용.
- `tests/e2e/authenticated`: Workspace/Documents/Search/Questions 등. test setup project에서 로그인하거나 API로 세션 설정 후 `storageState` 재사용.
- **쓰기 가능한 테스트는 test별 고유 사용자·Workspace·문서·문제 fixture**를 사용하고 동일 데이터에 병렬 쓰기를 피한다.
- Postgres: Supabase CLI local (`supabase start`/migration/seed), Mailpit로 auth 이메일 확인·복구 링크 테스트.
- Qdrant/Redis: Docker Compose로 실제 실행, CI에서는 fixture-size 인덱스·경량 mocked Embedding/Reranker/LLM adapter 사용해 결정론적 결과 확보.
- Full search benchmark/performance/model-compatibility는 별도 integration/nightly job에서 실제 Qwen 모델로 검증. **mock 기반 E2E 통과 ≠ 검색 알고리즘 품질 검증**.
- PDF fixture: 한국어/영어 2~5페이지, 표·목차·문단·출처와 문제가 포함된 소형 합성 파일. 실사용 저작권 서적을 CI artifact로 배포하지 않음.
- 시간·난수: seed 고정, 시계 fake/freeze, locale/timezone 테스트 기준 고정, animation disable for screenshots.

## 4. E2E 품질 계층

| Layer | 대상 | 실행 |
|---|---|---|
| Unit | 상태 우선순위, shuffle/정답 매핑, JWT claim 검사, chunk boundary | 모든 PR |
| Contract/Integration | FastAPI·DB·Storage 정책·Qdrant 색인, authorization 401/403 | 모든 PR |
| Browser E2E | 화면별 AC에 대응하는 전체 사용자 흐름 | 모든 PR의 핵심 시나리오 |
| Visual Regression | heatmap square/star, hover scale, floating panel, auth forms, themes | 관련 화면 변경 PR |
| Accessibility | 키보드, focus return, aria label, axe WCAG 2.2 AA 목표 | 모든 주요 페이지 |
| Model/Evaluation | KO↔EN Recall@K, parsing/extraction quality, hallucinated answer detection | nightly / release |
| Deployment Smoke | live Auth, direct PDF upload, API, worker, Qdrant, backup restore | staging + 릴리즈 |

## 5. Acceptance Traceability Matrix

| Screen | 대표 AC | E2E 파일 | 의존 milestone |
|---|---|---|---|
| AUTH-01 | AUTH-01-AC01~03 | `auth/login.spec.ts` | A1–A2 |
| AUTH-02/03 | AUTH-02-AC01/02, AUTH-03-AC01/02 | `auth/signup-verify.spec.ts` | A2 |
| AUTH-05/06 | AUTH-05-AC01, AUTH-06-AC01/02 | `auth/recovery.spec.ts` | A2 |
| ACCOUNT-01 | ACCOUNT-01-AC01/02 | `account/security.spec.ts` | A2 |
| WS-01 | WS-01-AC01~04 | `workspaces/overview.spec.ts` | M3 |
| DOC-01 | DOC-01-AC01~03 | `documents/library.spec.ts` | M3 |
| DOC-02 | DOC-02-AC01~04 | `documents/editor.spec.ts` | M3 |
| SEARCH-01 | SEARCH-01-AC01~04 | `search/search.spec.ts` | M3 |
| QOV-01 | QOV-01-AC01~06 | `questions/overview.spec.ts` | M5 |
| QBANK-01 | QBANK-01-AC01~03 | `questions/bank.spec.ts` | M4 |
| QPLAY-01 | QPLAY-01-AC01~05 | `questions/practice.spec.ts` | M5 |
| QIMPORT-01 | QIMPORT-01-AC01~03 | `questions/import.spec.ts` | M4 |
| QGEN-01 | QGEN-01-AC01~08 | `questions/generation.spec.ts` | M6 |
| HISTORY-01 | HISTORY-01-AC01~03 | `history/history.spec.ts` | M7 |

각 문서의 요구사항 ID와 테스트 title은 `e2e:trace` 검사 스크립트가 대조한다. CI는 orphan AC(테스트 없음) 또는 orphan test(ID를 참조하는 요구사항 없음)를 릴리즈 게이트에서 차단한다. **시나리오 수와 범위는 구현 단계별로 점진적으로 확대**한다.

## 6. 핵심 테스트 설계 규칙

- Locator는 `getByRole`, `getByLabel`, `getByText` 우선. `data-testid`는 heatmap marker처럼 시각 형태 검증이나 목록 내부의 안정적인 특정 대상 조회에 한정.
- 정답 유출 금지: practice-session 제출 전 network response payload 안에 `correct_option_ids`나 `explanation`이 없어야 함을 API contract test와 browser interception으로 검증.
- Favorites shape: `role=button`, `aria-label`에 favorite 반영; 기본 square와 favorite rounded-star `data-shape` 또는 SVG snapshot 검증. **favorite의 기본 시각 크기는 동일**, hover/focus-visible에서만 scale 확대; cell layout shift 없이 유지.
- Marker hover는 status preview만 제공하며 `viewed` DB 상태를 기록하면 안 됨. 실제 practice panel open에서만 viewed.
- URL panel state `?question=`은 back/forward/reload 후 동일 상태로 복원. panel을 닫으면 trigger focus return.
- Multitenancy: 다른 사용자의 Workspace ID, document ID, question ID, signed upload/download, search job 조회는 모두 거절.
- Archiving: archive된 Workspace는 read-only; API 직접 PATCH/POST로 우회할 수 없음.
- Accessibility: color-only state 금지, favorite shape 외 screen reader label, icon button label, panel focus trap/return, reduced motion.
- 생성형 기능: LLM fake adapter로 결정론적인 valid/invalid 응답을 주입하여 승인 전 격리·validation warning/정답 조건 뒤집기 위험을 검증.

## 7. 실패 진단과 CI artifacts

- 실패 시 Playwright trace, 스크린샷, video on retry, API/job correlation ID 및 테스트 fixture ID를 묶는다. **JWT·메일 인증 링크·실제 원문·개인정보는 artifact에 남기지 않도록 마스킹/보존 기한 설정**.
- PR의 E2E log는 spec ID를 함께 기록한다. 예: `QOV-01-AC03 should render rounded star after favorite toggle`.
- 긴 파싱 job은 `await expect.poll(...)` 또는 UI polling으로 최종 상태를 기다리되 임의 sleep은 사용하지 않는다.
- CI는 seed fixture에만 작동하도록 test-only 데이터 리셋·계정 생성 endpoint를 production에서 빌드/등록하지 않는다.
- A11y visual baseline은 Light/Dark·Desktop/iPad에서 관리한다. 가짜 모델 결과는 test name에 구분하고 실제 모델 성능은 `eval/`에서 별도 수치화한다.

### 7.1 품질 게이트 (M7.2)

- 화면 AC와 별개로 `tests/e2e/quality/`가 전 화면 axe(WCAG 2.2 AA + best-practice, light/dark, 주요 상태: 빈·채워진·dialog/panel·오류), visual baseline(light/dark × desktop 1280·iPad 834 portrait), WebKit/모바일 smoke(iPad·iPhone WebKit, Pixel Chrome), 성능 측정을 담당한다. ID는 `A11Y-nn`/`VISUAL-nn`/`SMOKE-nn`/`PERF-nn`(AC 아님, `e2e:trace`가 이 디렉터리에만 허용).
- Visual baseline은 고정 Playwright Linux image 렌더가 기준이다(macOS·CI 동일, `pnpm e2e:visual`). 운영 방법은 `tests/e2e/README.md` "Visual baselines".
- 성능: 수치 목표가 문서에 없어 web.dev "good"(LCP ≤ 2.5s, CLS ≤ 0.1, TTFB ≤ 0.8s)과 API p95 예산(overview·문제은행 500ms, 검색 1s, 로컬 production build·fake adapter)을 회귀 기준으로 쓴다. 2026-10-18 측정(300문항 + book-ko): 화면 LCP 44–160ms, CLS 0, TTFB ≤ 43ms, JS 190–333KiB(문서 편집기 최대, pdf.js); API p95 overview 18ms · 목록 14ms · 검색(hybrid, fake) 25ms. 실모델 검색 지연은 `eval/`·nightly에서 별도 측정한다.

## 8. Example E2E contract (test-first)

실제 starter 파일은 `tests/e2e/`에 포함한다. 예시는 **UI 구현 전 작성되는 기대 명세**이므로 현재 당연히 RED이며 실행·성공했다고 주장하지 않는다.

```ts
import { test, expect } from '@playwright/test';

test('QOV-01-AC03 favorite switches square to rounded star', async ({ page }) => {
  await page.goto('/workspaces/e2e-ws/questions');
  const dot = page.getByRole('button', { name: /3장 12번 문제/ });
  await expect(dot.locator('[data-testid="question-marker"]')).toHaveAttribute('data-shape', 'square');
  await dot.click();
  await page.getByRole('button', { name: '즐겨찾기 추가' }).click();
  await page.getByRole('button', { name: '패널 닫기' }).click();
  await expect(dot.locator('[data-testid="question-marker"]')).toHaveAttribute('data-shape', 'star');
  await expect(dot).toHaveAttribute('aria-label', /즐겨찾기/);
});
```

### 공식 문서

- https://playwright.dev/docs/auth
- https://playwright.dev/docs/test-projects
- https://supabase.com/docs/guides/local-development/cli-workflows
- https://supabase.com/docs/guides/auth/passwords


## 공유·Fork 테스트 우선 개발 (v1.3 추가)
- 신설 Spec/Tests: `WS-SHARE-01` (owner 공유 관리 5 AC), `WS-VIEW-01` (비로그인 읽기 전용 6 AC), `WS-FORK-01` (독립 복제 6 AC).
- 화면 요구사항 문서부터 작성하고 동일한 AC ID를 쓰는 Playwright 시나리오를 먼저 작성한다. 미구현 상태 RED를 확인한 후 API와 UI를 구현한다.
- owner/guest/authenticated-recipient 별도 fixture, 유효/만료/철회 token, allow_fork ON/OFF를 고정 데이터로 제공한다.
- 반드시 검증: 일반 비인증 Workspace API 접근 차단, 정확한 shared scope, 다른 Workspace ID 차단, Viewer 쓰기 전부 거부, token 즉시 철회, Fork OFF/미로그인 거부, Fork 완료 후 소유·개인 데이터 격리, 진행 중 정책 철회.
- Mock E2E는 UI·API 계약을 검증할 뿐 실제 Storage/RLS/Worker 보안·복제 검증을 대체하지 않는다.

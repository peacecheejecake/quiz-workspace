// Harness self-tests (no AC): the web server, project settings and the unauthenticated context
// behave as the RED/GREEN specs assume. Every screen route — implemented or still a stub — carries
// its screen ID (`data-screen-id`); HARNESS-02 signs in. Screens whose route needs real data
// (DOC-02 needs a parsed document) are covered by their own specs; here only the route's
// existence check is asserted.
import { expect, LOGIN_SCREEN, notFoundHeading, submitLogin, test } from '../fixtures/test.ts';

// Public screen routes own their <main>; protected ones (A2.1) render inside the AppShell <main>
// and are reachable only with a session.
const PUBLIC_SCREEN_ROUTES = [
  { path: '/login', id: 'AUTH-01' },
  { path: '/signup', id: 'AUTH-02' },
  { path: '/auth/error', id: 'AUTH-07' },
  { path: '/share/e2e-share', id: 'WS-VIEW-01' },
] as const;

// `:ws` is replaced by a workspace the signed-in user owns: since M3.1b workspace routes check
// access server-side and answer 404 for unknown ids. Implemented screens (ACCOUNT-01, WS-01,
// DOC-01) and the remaining stubs alike.
const PROTECTED_SCREEN_ROUTES = [
  { path: '/settings/security', id: 'ACCOUNT-01' },
  { path: '/workspaces', id: 'WS-01' },
  { path: '/workspaces/:ws/documents', id: 'DOC-01' },
  { path: '/workspaces/:ws/history', id: 'HISTORY-01' },
] as const;
const PLACEHOLDER_WS = '00000000-0000-4000-8000-000000000000';
/** DOC-02 is a real viewer since M3.5: a document that does not exist is the 404 page. */
const UNKNOWN_DOCUMENT = '00000000-0000-4000-8000-0000000000d0';

test('HARNESS-01 screen routes render their screen ID', async ({ page }) => {
  for (const { path, id } of PUBLIC_SCREEN_ROUTES) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    await expect(page.getByRole('main'), path).toHaveAttribute('data-screen-id', id);
    await expect(page.getByRole('heading', { level: 1 }), path).toBeVisible();
  }
  // Without a session every protected screen sends the browser to /login.
  for (const path of [
    ...PROTECTED_SCREEN_ROUTES.map((r) => r.path),
    `/workspaces/:ws/documents/${UNKNOWN_DOCUMENT}`,
  ]) {
    await page.goto(path.replace(':ws', PLACEHOLDER_WS));
    await expect(page, path).toHaveURL(LOGIN_SCREEN);
  }
});

test(
  'HARNESS-02 protected and query-state screens render for a signed-in user',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const member = await workspaceFactory.member('harness02');
    const ws = await workspaceFactory.create(member);
    await submitLogin(page, member.user);
    await expect(page).toHaveURL((url) => url.pathname === '/workspaces');

    for (const { path: template, id } of PROTECTED_SCREEN_ROUTES) {
      const path = template.replace(':ws', ws.id);
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      await expect(page.getByRole('main').locator(`[data-screen-id="${id}"]`), path).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 }), path).toBeVisible();
    }
    // DOC-02 route exists and checks the document server-side (viewer: documents-editor spec).
    const missing = await page.goto(`/workspaces/${ws.id}/documents/${UNKNOWN_DOCUMENT}`);
    expect(missing?.status(), 'unknown document').toBe(404);
    await expect(notFoundHeading(page)).toBeVisible();
    // QOV-01 and its QPLAY-01 panel (`?question=`) are real screens since M5.4 (questions specs).
    await page.goto('/share/e2e-share?panel=fork');
    await expect(page.locator('section[data-screen-id="WS-FORK-01"]')).toBeVisible();
  },
);

test('HARNESS-03 share routes send no-store, no-referrer and noindex headers', async ({ page }) => {
  const res = await page.goto('/share/e2e-share');
  const headers = res?.headers() ?? {};
  expect(headers['cache-control']).toContain('no-store');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-robots-tag']).toContain('noindex');
});

test('HARNESS-04 unauthenticated context starts without cookies or storage', async ({
  page,
  context,
}) => {
  expect(await context.cookies()).toEqual([]);
  await page.goto('/login');
  expect(await context.cookies()).toEqual([]);
  const state = await context.storageState();
  expect(state.cookies).toEqual([]);
  expect(state.origins.every((o) => o.localStorage.length === 0)).toBe(true);
});

test('HARNESS-05 browser locale, timezone and reduced motion are pinned', async ({ page }) => {
  await page.goto('/login');
  const env = await page.evaluate(() => ({
    language: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }));
  expect(env).toEqual({ language: 'ko-KR', timeZone: 'Asia/Seoul', reducedMotion: true });
});

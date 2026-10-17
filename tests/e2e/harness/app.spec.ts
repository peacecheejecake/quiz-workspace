// Harness self-tests (no AC): the web server, project settings and the unauthenticated context
// behave as the RED/GREEN specs assume. They pass against today's stub routes (HARNESS-02 signs in).
import { expect, LOGIN_SCREEN, submitLogin, test } from '../fixtures/test.ts';

// Public stub routes own their <main>; protected stubs (A2.1) render inside the AppShell <main>
// and are reachable only with a session.
const PUBLIC_STUB_ROUTES = [
  { path: '/login', id: 'AUTH-01' },
  { path: '/signup', id: 'AUTH-02' },
  { path: '/auth/error', id: 'AUTH-07' },
  { path: '/share/e2e-share', id: 'WS-VIEW-01' },
] as const;

const PROTECTED_STUB_ROUTES = [
  { path: '/settings/security', id: 'ACCOUNT-01' },
  { path: '/workspaces', id: 'WS-01' },
  { path: '/workspaces/e2e-ws/documents/e2e-doc', id: 'DOC-02' },
  { path: '/workspaces/e2e-ws/questions', id: 'QOV-01' },
] as const;

test('HARNESS-01 stub routes render their screen ID', async ({ page }) => {
  for (const { path, id } of PUBLIC_STUB_ROUTES) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    await expect(page.getByRole('main'), path).toHaveAttribute('data-screen-id', id);
    await expect(page.getByRole('heading', { level: 1 }), path).toBeVisible();
  }
  // Without a session every protected stub sends the browser to /login.
  for (const { path } of PROTECTED_STUB_ROUTES) {
    await page.goto(path);
    await expect(page, path).toHaveURL(LOGIN_SCREEN);
  }
});

test(
  'HARNESS-02 protected and query-state stubs render for a signed-in user',
  { tag: '@infra' },
  async ({ page, userFactory }) => {
    const user = await userFactory.create({ label: 'harness02' });
    await submitLogin(page, user);
    await expect(page).toHaveURL((url) => url.pathname === '/workspaces');

    for (const { path, id } of PROTECTED_STUB_ROUTES) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      await expect(page.getByRole('main').locator(`[data-screen-id="${id}"]`), path).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 }), path).toBeVisible();
    }
    await page.goto('/workspaces/e2e-ws/questions?question=q12');
    await expect(page.locator('section[data-screen-id="QPLAY-01"]')).toBeVisible();
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

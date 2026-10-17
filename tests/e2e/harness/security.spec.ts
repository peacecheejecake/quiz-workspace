// Harness self-tests for A3 (docs/auth.md §5): the nonce-based CSP from `apps/web/src/proxy.ts`
// is enforced on real pages without breaking them, and cross-origin writes to Server Actions or
// route handlers are refused. Requests below go through Playwright's APIRequestContext (no
// tokens or credentials are involved: the sign-in attempt uses a non-existent synthetic address).
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/test.ts';

const PAGES = ['/login', '/signup', '/forgot-password', '/auth/error', '/share/e2e-share'] as const;

function cspDirectives(header: string | undefined): Map<string, string[]> {
  return new Map(
    (header ?? '').split(';').map((d) => {
      const [name = '', ...values] = d.trim().split(/\s+/);
      return [name, values] as const;
    }),
  );
}

/** Collects CSP violation reports raised in the page (inline scripts, eval, blocked fetches…). */
async function recordCspViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const store: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = store;
    document.addEventListener('securitypolicyviolation', (e) => {
      store.push(`${e.effectiveDirective} ${e.blockedURI}`);
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

test('HARNESS-10 pages enforce a per-request nonce CSP that Next scripts satisfy', async ({
  page,
}) => {
  const violations = await recordCspViolations(page);
  const nonces = new Set<string>();

  for (const path of PAGES) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    const csp = cspDirectives(res?.headers()['content-security-policy']);
    const scriptSrc = csp.get('script-src') ?? [];
    const nonce = /^'nonce-(.+)'$/.exec(scriptSrc.find((v) => v.startsWith("'nonce-")) ?? '')?.[1];
    expect(nonce, path).toBeTruthy();
    expect(scriptSrc, path).toContain("'strict-dynamic'");
    expect(scriptSrc, path).not.toContain("'unsafe-inline'");
    expect(scriptSrc, path).not.toContain("'unsafe-eval'");
    expect(csp.get('frame-ancestors'), path).toEqual(["'none'"]);
    expect(csp.get('object-src'), path).toEqual(["'none'"]);
    expect(csp.get('base-uri'), path).toEqual(["'self'"]);
    expect(csp.get('form-action'), path).toEqual(["'self'"]);
    nonces.add(nonce ?? '');

    // Every server-rendered <script> carries this response's nonce (the DOM hides the attribute
    // value, so read it from the HTML).
    const html = (await res?.text()) ?? '';
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length, path).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag, path).toContain(`nonce="${nonce}"`);

    await page.waitForLoadState('networkidle');
    expect(await violations(), path).toEqual([]);
  }
  expect(nonces.size).toBe(PAGES.length);
});

test('HARNESS-11 hydrated pages run under the CSP (client validation works)', async ({ page }) => {
  const violations = await recordCspViolations(page);
  await page.goto('/login');
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET') posts.push(r.url());
  });
  // noValidate form: only the hydrated client component can show field errors without a request
  // (unhydrated, the browser would post the form and the server would answer instead).
  await expect(async () => {
    await page.getByRole('button', { name: /로그인|sign in/i }).click();
    await expect(page.getByRole('textbox', { name: /이메일|email/i })).toHaveAttribute(
      'aria-invalid',
      'true',
      { timeout: 1_000 },
    );
  }).toPass();
  expect(posts).toEqual([]);
  expect(await violations()).toEqual([]);
});

test('HARNESS-12 cross-origin POSTs to a Server Action or route handler are rejected', async ({
  page,
  request,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? '').origin;
  await page.goto('/login');
  // The real sign-in action invocation, as the progressively enhanced form would submit it.
  const fields = await page
    .locator('form')
    .evaluate((form: HTMLFormElement) =>
      [...new FormData(form).entries()].map(([k, v]) => [k, String(v)] as const),
    );
  expect(fields.some(([name]) => name.startsWith('$ACTION_'))).toBe(true);
  const multipart = Object.fromEntries([
    ...fields,
    ['email', 'a3-csrf-probe@example.test'],
    ['password', 'not-the-password-0'],
  ]);

  const post = (from: string | null, path = '/login') =>
    request.post(path, {
      multipart,
      headers: from === null ? { 'Sec-Fetch-Site': 'cross-site' } : { Origin: from },
      maxRedirects: 0,
      failOnStatusCode: false,
    });

  // Positive control: the same request from our own origin reaches the action.
  const sameOrigin = await post(origin);
  expect(sameOrigin.status()).toBe(200);

  for (const from of ['https://evil.example', 'null', null]) {
    const res = await post(from);
    expect(res.status(), String(from)).toBe(403);
  }
  // Route handlers (GET-only today) are covered by the same guard.
  expect((await post('https://evil.example', '/auth/callback')).status()).toBe(403);
});

// S4 security harness (docs/auth.md §5, docs/workspace-sharing.md §2, docs/deployment.md §6.1):
// every state-changing route handler of the web app (the same-origin BFF relays, enumerated from
// apps/web/src/app/**/route.ts so a new relay cannot be missed) refuses cross-site writes before
// it runs — also when its last path segment ends in a static-file extension, which the proxy
// matcher would otherwise skip — and the share surfaces answer with the privacy headers. Requests
// go through Playwright's APIRequestContext without any session: no credentials are involved.
import { globSync, readFileSync } from 'node:fs';
import { expect, test } from '../fixtures/test.ts';

const APP_DIR = 'apps/web/src/app';
const WRITE = /export\s+(?:async\s+)?(?:function\s+|const\s+)(POST|PUT|PATCH|DELETE)\b/g;
const ID = '00000000-0000-4000-8000-000000000000';

interface Handler {
  readonly path: string;
  readonly method: string;
}

function writeHandlers(): Handler[] {
  const out: Handler[] = [];
  for (const file of globSync('**/route.ts', { cwd: APP_DIR })) {
    const route = `/${file.replace(/\/?route\.ts$/, '')}`;
    const path = route.replace(/\[[^\]]+\]/g, ID);
    for (const m of readFileSync(`${APP_DIR}/${file}`, 'utf8').matchAll(WRITE)) {
      out.push({ path, method: m[1] ?? 'POST' });
    }
  }
  return out.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

const HANDLERS = writeHandlers();

/** The same route with its last segment ending in `.png` (proxy matcher excludes such paths). */
function withExtension(path: string): string {
  return path.replace(/([^/]+)$/, '$1.png');
}

test('HARNESS-13 every state-changing route handler refuses cross-site writes', async ({
  request,
  baseURL,
}) => {
  expect(HANDLERS.length).toBeGreaterThanOrEqual(16);
  const own = new URL(baseURL ?? '').origin;
  const send = (h: Handler, path: string, headers: Record<string, string>) =>
    request.fetch(path, {
      method: h.method,
      headers: { 'content-type': 'application/json', ...headers },
      data: '{}',
      maxRedirects: 0,
      failOnStatusCode: false,
    });

  const leaks: string[] = [];
  for (const h of HANDLERS) {
    // Positive control: our own origin reaches the handler (it answers 400/401/404, never 403).
    const same = await send(h, h.path, { Origin: own });
    expect(same.status(), `${h.method} ${h.path} same-origin`).not.toBe(403);
    for (const path of [h.path, withExtension(h.path)]) {
      for (const headers of [
        { Origin: 'https://evil.example' } as Record<string, string>,
        { Origin: 'null' },
        { 'Sec-Fetch-Site': 'cross-site' },
        { Origin: `${own}.evil.example` },
      ]) {
        const res = await send(h, path, headers);
        if (res.status() !== 403) leaks.push(`${h.method} ${path} ${JSON.stringify(headers)}`);
      }
    }
  }
  expect(leaks).toEqual([]);
});

test('HARNESS-14 share page and share relay answer private, unindexed, without a Referer', async ({
  request,
}) => {
  const page = await request.get(`/share/${ID}`, { failOnStatusCode: false });
  const relays = await Promise.all([
    request.get(`/api/shared/${ID}`, { failOnStatusCode: false }),
    request.get(`/api/shared/${ID}/questions`, { failOnStatusCode: false }),
    request.get(`/api/shared/${ID}/documents/${ID}/pdf`, { failOnStatusCode: false }),
    request.post(`/api/shared/${ID}/sessions`, { data: '{}', failOnStatusCode: false }),
  ]);
  for (const res of [page, ...relays]) {
    const what = new URL(res.url()).pathname;
    const headers = res.headers();
    expect(headers['cache-control'], what).toContain('no-store');
    expect(headers['cache-control'], what).toContain('private');
    expect(headers['referrer-policy'], what).toBe('no-referrer');
    expect(headers['x-robots-tag'], what).toContain('noindex');
    expect(headers['x-robots-tag'], what).toContain('nofollow');
    expect(headers['set-cookie'] ?? '', what).not.toContain('quiz_share_session=v1');
  }
  // The page itself never carries a share secret (it only lives in the fragment) and its scripts
  // run under a nonce CSP.
  const html = await page.text();
  expect(html).not.toMatch(/#k=|%23k%3D/i);
  expect(page.headers()['content-security-policy']).toMatch(/script-src[^;]*'nonce-/);
});

test('HARNESS-15 the web app has no test-only, seed or reset endpoints', async ({ request }) => {
  const routes = globSync('**/{route,page}.{ts,tsx}', { cwd: APP_DIR });
  expect(routes.length).toBeGreaterThan(30);
  for (const file of routes) {
    expect(file, file).not.toMatch(/(^|\/)(_?test|e2e|seed|reset-db|debug|fixtures?)(\/|$)/i);
  }
  for (const path of [
    '/api/test/reset',
    '/api/e2e/seed',
    '/api/seed',
    '/api/reset',
    '/api/debug',
  ]) {
    const res = await request.post(path, { data: '{}', failOnStatusCode: false });
    expect([404, 405], path).toContain(res.status());
  }
});

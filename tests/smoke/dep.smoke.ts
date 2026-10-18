// DEP-01, DEP-02, DEP-05, DEP-07 against a running deployment (docs/deployment.md §9).
// Tests tagged @readonly change nothing (production runs only those). Checks that depend on the
// target are declared per target: `deployed` adds the HTTPS/HSTS/Qdrant checks, accounts add
// the signed-in ones. What stays manual is listed in docs/runbook-deploy.md "Staging smoke".
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  accessToken,
  Api,
  createMcq,
  createWorkspace,
  deleteWorkspace,
  raw,
  supabase,
  uploadFixturePdf,
  waitForJob,
  type Reply,
} from './client.ts';
import { accounts, hasAccounts, smokeEnv } from './env.ts';

const env = smokeEnv();
const READONLY = { tag: '@readonly' };
const PRIVATE_BUCKETS = ['source-pdfs', 'parsed-artifacts'];

function origin(url: string): string {
  return new URL(url).origin;
}

// --- DEP-01 HTTPS, origins, redirects, sign-in ---------------------------------------------------

if (env.deployed) {
  test('DEP-01 web and API answer over HTTPS only, with HSTS', READONLY, async () => {
    for (const base of [env.webUrl, env.apiUrl]) {
      const page = base === env.webUrl ? '/login' : '/health/live';
      const secure = await raw(`${base}${page}`);
      expect(secure.status, `${new URL(base).host} over https`).toBeLessThan(400);
      expect(secure.headers.get('strict-transport-security') ?? '').toMatch(/max-age=\d{7,}/);

      const plain = await raw(`${base.replace(/^https:/, 'http:')}${page}`).catch(() => null);
      // Either no plain-HTTP listener at all, or a redirect to https.
      if (plain) {
        expect([301, 302, 307, 308], `${new URL(base).host} over http`).toContain(plain.status);
        const location = plain.headers.get('location') ?? '';
        expect(location.startsWith('https://'), 'redirect target is https').toBe(true);
      }
    }
  });
}

test('DEP-01 API CORS allows exactly the web origin', READONLY, async () => {
  const preflight = (from: string) =>
    raw(`${env.apiUrl}/api/v1/me`, {
      method: 'OPTIONS',
      headers: {
        origin: from,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
  const allowed = await preflight(origin(env.webUrl));
  expect(allowed.status).toBeLessThan(300);
  expect(allowed.headers.get('access-control-allow-origin')).toBe(origin(env.webUrl));
  expect(allowed.headers.get('access-control-allow-credentials')).not.toBe('true');

  for (const foreign of ['https://evil.example', 'null']) {
    const denied = await preflight(foreign);
    expect(denied.status, `preflight from ${foreign}`).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  }
  const simple = await raw(`${env.apiUrl}/health/live`, {
    headers: { origin: 'https://evil.example' },
  });
  expect(simple.status).toBe(403);
});

test(
  'DEP-01 Auth requires email confirmation and offers email sign-in only',
  READONLY,
  async () => {
    const settings = await supabase<{
      mailer_autoconfirm: boolean;
      external: Record<string, boolean>;
    }>('/auth/v1/settings');
    expect(settings.status).toBe(200);
    expect(settings.body?.mailer_autoconfirm).toBe(false);
    const enabled = Object.entries(settings.body?.external ?? {})
      .filter(([, on]) => on)
      .map(([name]) => name);
    expect(enabled).toEqual(['email']);
  },
);

if (hasAccounts()) {
  test('DEP-01 sign-in works and an external next= stays on the web origin', async ({ page }) => {
    const { a } = accounts();
    await page.goto(`/login?next=${encodeURIComponent('https://evil.example/steal')}`);
    await page.getByRole('textbox', { name: /이메일|email/i }).fill(a.email);
    await page.getByLabel(/^\s*(비밀번호|password)\s*\*?\s*$/i).fill(a.password);
    await page.getByRole('button', { name: /^(로그인|sign in|log in)$/i }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/workspaces'));
    expect(new URL(page.url()).origin).toBe(origin(env.webUrl));
    // The session cookie is HttpOnly (never readable by page scripts).
    const cookies = await page.context().cookies();
    const auth = cookies.filter((c) => /^sb-.+-auth-token/.test(c.name));
    expect(auth.length).toBeGreaterThan(0);
    for (const cookie of auth) {
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.sameSite).toBe('Lax');
      if (env.deployed) expect(cookie.secure).toBe(true);
    }
  });
}

// --- DEP-02 private Storage --------------------------------------------------------------------

test(
  'DEP-02 private buckets refuse anonymous probes (random keys, read-only)',
  READONLY,
  async () => {
    for (const bucket of PRIVATE_BUCKETS) {
      const key = `workspaces/${randomUUID()}/documents/${randomUUID()}/source.pdf`;
      const publicUrl = await raw(`${env.supabaseUrl}/storage/v1/object/public/${bucket}/${key}`);
      expect(publicUrl.status, `${bucket} public URL`).toBeGreaterThanOrEqual(400);

      const direct = await supabase(`/storage/v1/object/${bucket}/${key}`);
      expect(direct.status, `${bucket} anonymous object`).toBeGreaterThanOrEqual(400);

      const listing = await supabase<unknown[]>(`/storage/v1/object/list/${bucket}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prefix: '', limit: 10 }),
      });
      if (listing.status === 200)
        expect(listing.body?.length ?? 0, `${bucket} listing size`).toBe(0);
      else expect(listing.status).toBeGreaterThanOrEqual(400);

      const upload = await supabase(`/storage/v1/object/${bucket}/smoke/${randomUUID()}.pdf`, {
        method: 'POST',
        headers: { 'content-type': 'application/pdf' },
        body: '%PDF-1.4 smoke',
      });
      expect(upload.status, `${bucket} anonymous upload`).toBeGreaterThanOrEqual(400);
    }
    const buckets = await supabase<{ name: string }[]>('/storage/v1/bucket');
    if (buckets.status === 200) {
      expect((buckets.body ?? []).map((b) => b.name)).not.toEqual(
        expect.arrayContaining(PRIVATE_BUCKETS),
      );
    }
    const signedRead = await raw(`${env.apiUrl}/api/v1/documents/${randomUUID()}/source-url`);
    expect(signedRead.status).toBe(401);
  },
);

if (hasAccounts()) {
  test('DEP-02 a signed-in user cannot bypass the API to reach Storage', async () => {
    const jwt = await accessToken(accounts().a);
    for (const bucket of PRIVATE_BUCKETS) {
      const listing = await supabase<unknown[]>(`/storage/v1/object/list/${bucket}`, {
        method: 'POST',
        token: jwt,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prefix: '', limit: 10 }),
      });
      if (listing.status === 200)
        expect(listing.body?.length ?? 0, `${bucket} listing size`).toBe(0);
      else expect(listing.status).toBeGreaterThanOrEqual(400);
      const upload = await supabase(`/storage/v1/object/${bucket}/smoke/${randomUUID()}.pdf`, {
        method: 'POST',
        token: jwt,
        headers: { 'content-type': 'application/pdf' },
        body: '%PDF-1.4 smoke',
      });
      expect(upload.status, `${bucket} upload with a user JWT`).toBeGreaterThanOrEqual(400);
    }
  });
}

if (hasAccounts()) {
  test('DEP-02 a real uploaded PDF is unreachable without a signature or the API', async () => {
    test.setTimeout(smokeEnv().jobTimeoutMs + 120_000);
    const owner = await Api.as('a');
    const ws = await createWorkspace(owner, 'dep02');
    try {
      // Known object through the authorized path (a random key would pass even if public).
      const pdf = await uploadFixturePdf(owner, ws.id);
      await waitForJob(owner, pdf.jobId);
      const object = `${encodeURIComponent(pdf.bucket)}/${pdf.key
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`;
      const jwt = await accessToken(accounts().a);
      const probes: [string, Promise<Reply>][] = [
        ['unsigned public URL', raw(`${env.supabaseUrl}/storage/v1/object/public/${object}`)],
        ['anonymous object', supabase(`/storage/v1/object/${object}`)],
        ['anonymous authenticated route', supabase(`/storage/v1/object/authenticated/${object}`)],
        ['owner JWT, bypassing the API', supabase(`/storage/v1/object/${object}`, { token: jwt })],
        [
          'owner JWT, authenticated route',
          supabase(`/storage/v1/object/authenticated/${object}`, { token: jwt }),
        ],
      ];
      for (const [what, probe] of probes) {
        expect((await probe).status, what).toBeGreaterThanOrEqual(400);
      }
      // The API's signed read URL works only with its signature: strip the query, it must fail.
      const signed = await owner.ok<{ url: string }>(
        'GET',
        `/documents/${pdf.documentId}/source-url`,
        undefined,
        [200],
      );
      const withToken = await raw(signed.url);
      expect(withToken.status, 'signed read URL').toBe(200);
      const unsigned = new URL(signed.url);
      unsigned.search = '';
      expect(
        (await raw(unsigned.toString())).status,
        'signed URL without its token',
      ).toBeGreaterThanOrEqual(400);
      await owner.ok('DELETE', `/documents/${pdf.documentId}`, undefined, [200, 204]);
    } finally {
      await deleteWorkspace(owner, ws.id);
    }
  });
}

// --- DEP-05 cross-user isolation ---------------------------------------------------------------

if (hasAccounts()) {
  test('DEP-05 another user cannot upload, read, query or answer in a workspace', async () => {
    const owner = await Api.as('a');
    const other = await Api.as('b');
    const ws = await createWorkspace(owner, 'dep05');
    try {
      const question = await createMcq(owner, ws.id);
      const session = await owner.ok<{ id: string }>(
        'POST',
        `/questions/${question.id}/practice-sessions`,
        {},
        [201],
      );
      const probes: [string, string, unknown?][] = [
        ['GET', `/workspaces/${ws.id}`],
        ['GET', `/workspaces/${ws.id}/documents`],
        [
          'POST',
          `/workspaces/${ws.id}/documents/upload-intent`,
          {
            filename: 'smoke.pdf',
            size_bytes: 1024,
            content_type: 'application/pdf',
            sha256: '0'.repeat(64),
          },
        ],
        ['POST', `/workspaces/${ws.id}/search`, { query: 'smoke', mode: 'keyword' }],
        ['GET', `/workspaces/${ws.id}/questions`],
        ['GET', `/workspaces/${ws.id}/attempts`],
        ['GET', `/workspaces/${ws.id}/jobs`],
        ['GET', `/questions/${question.id}`],
        ['POST', `/questions/${question.id}/practice-sessions`, {}],
        ['GET', `/questions/${question.id}/attempts`],
        ['GET', `/practice-sessions/${session.id}`],
        ['POST', `/practice-sessions/${session.id}/submit`, { selected_option_ids: ['opt-1'] }],
        ['DELETE', `/workspaces/${ws.id}`],
      ];
      for (const [method, path, body] of probes) {
        const res = await other.request(method, path, body);
        const route = path.replace(/[0-9a-f-]{36}/gi, '{id}');
        // Non-members get the same 404 as for a missing resource (implementation-plan §7).
        expect(res.status, `${method} ${route} as another user`).toBe(404);
      }
      const anonymous = await new Api().request('GET', `/workspaces/${ws.id}`);
      expect(anonymous.status).toBe(401);
      // The owner still sees everything.
      await owner.ok('GET', `/workspaces/${ws.id}`, undefined, [200]);
    } finally {
      await deleteWorkspace(owner, ws.id);
    }
  });
}

// --- DEP-07 exposure ---------------------------------------------------------------------------

test('DEP-07 the Supabase Data API exposes no application table', READONLY, async () => {
  for (const table of ['workspaces', 'documents', 'questions', 'attempts', 'async_jobs']) {
    const res = await supabase<unknown[]>(`/rest/v1/${table}?select=*&limit=1`);
    if (res.status === 200) expect(res.body?.length ?? 0, `${table} rows`).toBe(0);
    else expect(res.status, table).toBeGreaterThanOrEqual(400);
  }
});

if (hasAccounts()) {
  test('DEP-07 a user JWT does not open the Data API either', async () => {
    const jwt = await accessToken(accounts().a);
    for (const table of ['workspaces', 'workspace_memberships', 'questions', 'profiles']) {
      const res = await supabase<unknown[]>(`/rest/v1/${table}?select=*&limit=1`, { token: jwt });
      if (res.status === 200) expect(res.body?.length ?? 0, `${table} rows`).toBe(0);
      else expect(res.status, table).toBeGreaterThanOrEqual(400);
    }
  });
}

test('DEP-07 API security headers, no banner, no-store, guarded docs', READONLY, async () => {
  const live = await raw(`${env.apiUrl}/health/live`);
  expect(live.status).toBe(200);
  expect(live.headers.get('x-content-type-options')).toBe('nosniff');
  expect(live.headers.get('x-frame-options')).toBe('DENY');
  expect(live.headers.get('referrer-policy')).toBe('no-referrer');
  expect(live.headers.get('content-security-policy') ?? '').toContain("frame-ancestors 'none'");
  expect(live.headers.get('server') ?? '').not.toMatch(/uvicorn|python/i);

  const me = await raw(`${env.apiUrl}/api/v1/me`);
  expect(me.status).toBe(401);
  expect(me.headers.get('cache-control') ?? '').toContain('no-store');
  expect(me.headers.get('content-type') ?? '').toContain('application/problem+json');

  if (env.target === 'production') {
    expect((await raw(`${env.apiUrl}/api/v1/docs`)).status).toBe(404);
  }
});

test('DEP-07 readiness is green and names dependencies only', READONLY, async () => {
  const ready = await raw<{ status: string; checks: Record<string, { status: string }> }>(
    `${env.apiUrl}/health/ready`,
  );
  expect(ready.status).toBe(200);
  expect(ready.body?.status).toBe('ok');
  for (const [name, check] of Object.entries(ready.body?.checks ?? {})) {
    expect(check.status, name).toBe('ok');
  }
  // Boolean only: the body itself must not reach the failure output.
  expect(/:\/\/|@|password|secret/i.test(ready.text), 'readiness body names no endpoint').toBe(
    false,
  );
});

test('DEP-07 web security headers, CSP origins and share no-store', READONLY, async () => {
  const login = await raw(`${env.webUrl}/login`);
  expect(login.status).toBe(200);
  expect(login.headers.get('x-content-type-options')).toBe('nosniff');
  expect(login.headers.get('x-frame-options')).toBe('DENY');
  const csp = login.headers.get('content-security-policy') ?? '';
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  const connect = /connect-src ([^;]+)/.exec(csp)?.[1]?.split(/\s+/) ?? [];
  expect(connect).toContain(origin(env.apiUrl));
  expect(connect).toContain(origin(env.supabaseUrl));
  expect(login.headers.get('x-powered-by')).toBeNull();

  const share = await raw(`${env.webUrl}/share/${randomUUID()}`);
  expect(share.headers.get('cache-control') ?? '').toContain('no-store');
  expect(share.headers.get('x-robots-tag') ?? '').toContain('noindex');
  expect(share.headers.get('referrer-policy')).toBe('no-referrer');

  // Cross-site writes to the BFF are refused before any route runs.
  const csrf = await raw(`${env.webUrl}/api/workspaces`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{"name":"smoke"}',
  });
  expect(csrf.status).toBe(403);
});

// Patterns of server-only material that must never reach a browser bundle.
const BUNDLE_LEAKS: readonly (readonly [string, RegExp])[] = [
  ['Supabase secret key', /\bsb_secret_[\w-]{8,}/],
  ['database URL', /\bpostgres(?:ql)?:\/\/[^\s"'`]*@/],
  ['redis URL', /\brediss?:\/\/[^\s"'`]*@/],
  [
    'server-only variable name',
    /\b(?:SUPABASE_SECRET_KEY|AUTH_RECOVERY_MARKER_SECRET|RELAY_CLIENT_SECRET|SHARE_SESSION_SECRET|QDRANT_API_KEY|LLM_API_KEY|WORKER_DATABASE_URL)\b/,
  ],
];

function nonAnonJwts(text: string): number {
  let count = 0;
  for (const [, body = ''] of text.matchAll(/\beyJ[\w-]{8,}\.(eyJ[\w-]{8,})\.[\w-]{8,}/g)) {
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
        role?: string;
      };
      // A legacy anon key is public by design; anything else (service_role, a user) is not.
      if (payload.role !== 'anon') count++;
    } catch {
      count++;
    }
  }
  return count;
}

/** Leak categories in a response body; never the matched text (failure output reaches CI logs). */
function leaksIn(resource: string, text: string): string[] {
  const found = BUNDLE_LEAKS.filter(([, pattern]) => pattern.test(text)).map(
    ([kind]) => `${resource}: ${kind}`,
  );
  if (nonAnonJwts(text) > 0) found.push(`${resource}: non-anon JWT`);
  return found;
}

test('DEP-07 client bundles carry no server secrets', READONLY, async () => {
  const scripts = new Set<string>();
  const findings: string[] = [];
  for (const page of ['/login', '/signup', '/forgot-password', '/share/{id}']) {
    const res = await raw(`${env.webUrl}${page.replace('{id}', randomUUID())}`);
    findings.push(...leaksIn(`${page} HTML`, res.text));
    for (const [, src] of res.text.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)) {
      if (src) scripts.add(src);
    }
  }
  expect(scripts.size).toBeGreaterThan(0);
  for (const src of scripts) {
    const res = await raw(`${env.webUrl}${src}`);
    if (res.status !== 200) findings.push(`${src}: HTTP ${res.status}`);
    else findings.push(...leaksIn(src, res.text));
  }
  // Resource + category only.
  expect(findings).toEqual([]);
});

if (env.qdrantUrl) {
  const qdrant = env.qdrantUrl;
  test('DEP-07 Qdrant refuses requests without the API key', READONLY, async () => {
    for (const path of ['/collections', '/aliases']) {
      const res = await raw(`${qdrant}${path}`);
      expect([401, 403], `Qdrant ${path}`).toContain(res.status);
    }
  });
}

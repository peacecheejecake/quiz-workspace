import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseServerApiBaseUrl } from '../src/lib/api/base-url';

const PUBLIC = 'https://api.example.org';

describe('parseServerApiBaseUrl (PERF-1)', () => {
  it('falls back to the public API URL when API_INTERNAL_BASE_URL is unset or blank', () => {
    expect(parseServerApiBaseUrl({}, PUBLIC)).toBe(PUBLIC);
    expect(parseServerApiBaseUrl({ API_INTERNAL_BASE_URL: '  ' }, PUBLIC)).toBe(PUBLIC);
  });

  it('uses the private-network URL, trimmed and without trailing slashes', () => {
    expect(parseServerApiBaseUrl({ API_INTERNAL_BASE_URL: ' http://api:8000// ' }, PUBLIC)).toBe(
      'http://api:8000',
    );
    expect(
      parseServerApiBaseUrl({ API_INTERNAL_BASE_URL: 'https://api.internal/base/' }, PUBLIC),
    ).toBe('https://api.internal/base');
  });

  it.each([
    'api:8000',
    'ftp://api:8000',
    'not a url secretish',
    'http://user:secretish@api:8000',
    'http://api:8000/?secretish=1',
    'http://api:8000/#secretish',
  ])('rejects %j naming the variable, never the value', (value) => {
    const run = () => parseServerApiBaseUrl({ API_INTERNAL_BASE_URL: value }, PUBLIC);
    expect(run).toThrow(/API_INTERNAL_BASE_URL must be/);
    expect(run).not.toThrow(/secretish/);
  });
});

describe('server-side API callers (PERF-1)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.doUnmock('../src/env');
    vi.doUnmock('../src/lib/supabase/server');
    vi.doUnmock('../src/lib/supabase/session-guard');
  });

  function mockSession() {
    vi.doMock('../src/env', () => ({
      getPublicEnv: () => ({
        apiBaseUrl: PUBLIC,
        supabaseUrl: 'http://127.0.0.1:54321',
        supabasePublishableKey: 'pk',
      }),
    }));
    vi.doMock('../src/lib/supabase/server', () => ({
      createSupabaseServerClient: async () => ({
        auth: { getSession: async () => ({ data: { session: { access_token: 'h.p.s' } } }) },
      }),
    }));
    vi.doMock('../src/lib/supabase/session-guard', () => ({
      readVerifiedClaims: async () => ({ claims: { sub: 'u' }, corrupt: false }),
    }));
  }

  it('the BFF relay and the typed server client call the internal URL', async () => {
    vi.stubEnv('API_INTERNAL_BASE_URL', 'http://api:8000');
    mockSession();
    const upstream = vi.fn(async () => Response.json({ items: [] }));
    vi.stubGlobal('fetch', upstream);

    const { relayToApi } = await import('../src/lib/documents/bff');
    await relayToApi('/workspaces/w/documents', { method: 'GET' });
    expect(String((upstream.mock.calls[0] as unknown[])[0])).toBe(
      'http://api:8000/api/v1/workspaces/w/documents',
    );

    const { createServerApiClient } = await import('../src/lib/api/server');
    const api = await createServerApiClient();
    await api.GET('/api/v1/workspaces', { params: { query: { status: 'active' } } });
    const request = (upstream.mock.calls[1] as unknown[])[0];
    const url = request instanceof Request ? request.url : String(request);
    expect(url).toBe('http://api:8000/api/v1/workspaces?status=active');

    const { relayContext } = await import('../src/lib/shared/context');
    expect(relayContext(new Request('http://web/api/shared/x')).apiBaseUrl).toBe('http://api:8000');
  });

  it('without the override, server-side calls keep the public URL', async () => {
    mockSession();
    const upstream = vi.fn(async () => Response.json({ items: [] }));
    vi.stubGlobal('fetch', upstream);
    const { relayToApi } = await import('../src/lib/documents/bff');
    await relayToApi('/workspaces/w/documents', { method: 'GET' });
    expect(String((upstream.mock.calls[0] as unknown[])[0])).toBe(
      `${PUBLIC}/api/v1/workspaces/w/documents`,
    );
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_AFTER_SIGN_IN, safeNextPath } from '../src/lib/auth/safe-next';

describe('safeNextPath', () => {
  it.each([
    ['/workspaces', '/workspaces'],
    ['/workspaces?tab=archived', '/workspaces?tab=archived'],
    ['/workspaces/e2e-ws/documents?tab=all', '/workspaces/e2e-ws/documents?tab=all'],
    ['/settings/security', '/settings/security'],
    ['/documents/abc', '/documents/abc'],
    ['/questions', '/questions'],
    ['/reset-password', '/reset-password'],
    ['/share/abc', '/share/abc'],
    ['  /workspaces  ', '/workspaces'],
    ['/workspaces#frag', '/workspaces'],
  ])('keeps internal allowlisted path %j', (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected);
  });

  it.each([
    'https://evil.example/steal',
    'http://127.0.0.1:3000/workspaces',
    '//evil.example/steal',
    '///evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    '/%2F/evil.example',
    '%2F%2Fevil.example',
    '/%5Cevil.example',
    '/%255C%255Cevil.example',
    '%252F%252Fevil.example',
    'javascript:alert(1)',
    'data:text/html,hi',
    'workspaces',
    '?next=/workspaces',
    '/login',
    '/auth/callback?code=x',
    '/settingsx',
    '/workspacesevil',
    '/workspaces/../login',
    '/workspaces/%2e%2e/login',
    '/work\tspaces',
    '/workspaces\n',
    '/%0d%0aSet-Cookie:x',
    '',
    '   ',
    `/workspaces/${'a'.repeat(3000)}`,
  ])('rejects %j', (raw) => {
    expect(safeNextPath(raw)).toBe(DEFAULT_AFTER_SIGN_IN);
  });

  it('falls back for non-strings and honours a custom fallback', () => {
    expect(safeNextPath(undefined)).toBe('/workspaces');
    expect(safeNextPath(null)).toBe('/workspaces');
    expect(safeNextPath(['/workspaces'])).toBe('/workspaces');
    expect(safeNextPath('https://evil.example', '')).toBe('');
  });

  it('never returns anything but a single-slash relative path', () => {
    for (const raw of ['/workspaces/a/../b', '/settings/./security', '/workspaces?x=//evil']) {
      const out = safeNextPath(raw);
      expect(out.startsWith('/')).toBe(true);
      expect(out.startsWith('//')).toBe(false);
    }
  });
});

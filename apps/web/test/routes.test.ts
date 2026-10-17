import { describe, expect, it } from 'vitest';
import {
  decideAccess,
  isProtectedPath,
  isSignedOutOnlyPath,
  loginRedirectPath,
} from '../src/lib/auth/routes';

describe('isProtectedPath', () => {
  it.each([
    '/workspaces',
    '/workspaces/ws-1/questions',
    '/documents/x',
    '/questions',
    '/settings',
    '/settings/security',
  ])('protects %s', (path) => expect(isProtectedPath(path)).toBe(true));
  it.each([
    '/',
    '/login',
    '/signup',
    '/auth/callback',
    '/auth/error',
    '/reset-password',
    '/share/abc',
    '/workspacesx',
    '/settingsx',
  ])('leaves %s public', (path) => expect(isProtectedPath(path)).toBe(false));
});

describe('isSignedOutOnlyPath', () => {
  it('covers login, signup and forgot-password only', () => {
    expect(isSignedOutOnlyPath('/login')).toBe(true);
    expect(isSignedOutOnlyPath('/login/')).toBe(true);
    expect(isSignedOutOnlyPath('/signup')).toBe(true);
    expect(isSignedOutOnlyPath('/forgot-password')).toBe(true);
    expect(isSignedOutOnlyPath('/reset-password')).toBe(false);
    expect(isSignedOutOnlyPath('/auth/callback')).toBe(false);
    expect(isSignedOutOnlyPath('/auth/error')).toBe(false);
  });
});

describe('loginRedirectPath', () => {
  it('keeps a safe target as next and drops unsafe ones', () => {
    expect(loginRedirectPath('/workspaces?tab=all')).toBe('/login?next=%2Fworkspaces%3Ftab%3Dall');
    expect(loginRedirectPath('//evil.example')).toBe('/login');
    expect(loginRedirectPath()).toBe('/login');
  });
});

describe('decideAccess (proxy redirect logic)', () => {
  const nextOf = (location: string) =>
    new URL(location, 'http://app.test').searchParams.get('next');

  it('sends signed-out users on protected paths to /login with the path and query as next', () => {
    const decision = decideAccess({
      pathname: '/workspaces/e2e-ws/documents',
      search: '?tab=all',
      authenticated: false,
    });
    expect(decision.action).toBe('redirect');
    if (decision.action !== 'redirect') return;
    expect(new URL(decision.location, 'http://app.test').pathname).toBe('/login');
    expect(nextOf(decision.location)).toBe('/workspaces/e2e-ws/documents?tab=all');
  });

  it('lets signed-out users reach public pages', () => {
    for (const pathname of [
      '/login',
      '/signup',
      '/auth/callback',
      '/auth/error',
      '/share/x',
      '/reset-password',
    ]) {
      expect(decideAccess({ pathname, search: '', authenticated: false })).toEqual({
        action: 'continue',
      });
    }
  });

  it('lets signed-in users reach protected pages and the recovery screen', () => {
    for (const pathname of [
      '/workspaces',
      '/settings/security',
      '/reset-password',
      '/auth/callback',
    ]) {
      expect(decideAccess({ pathname, search: '', authenticated: true })).toEqual({
        action: 'continue',
      });
    }
  });

  it('bounces signed-in users away from auth pages to a validated next or the workspace list', () => {
    expect(decideAccess({ pathname: '/login', search: '', authenticated: true })).toEqual({
      action: 'redirect',
      location: '/workspaces',
    });
    expect(
      decideAccess({
        pathname: '/login',
        search: '?next=%2Fsettings%2Fsecurity',
        authenticated: true,
      }),
    ).toEqual({ action: 'redirect', location: '/settings/security' });
    for (const next of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      const search = `?${new URLSearchParams({ next }).toString()}`;
      expect(decideAccess({ pathname: '/signup', search, authenticated: true })).toEqual({
        action: 'redirect',
        location: '/workspaces',
      });
    }
  });
});

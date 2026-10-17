import { describe, expect, it } from 'vitest';
import {
  authErrorPath,
  callbackResultPath,
  classifyCallbackError,
  parseAuthErrorReason,
  planCallback,
} from '../src/lib/auth/callback';

const plan = (query: string) => planCallback(new URLSearchParams(query));

describe('planCallback', () => {
  it('redeems a token_hash with verifyOtp and the validated next', () => {
    expect(plan('token_hash=abc&type=email&next=/settings/security')).toEqual({
      kind: 'verify-otp',
      tokenHash: 'abc',
      type: 'email',
      successPath: '/settings/security',
    });
  });

  it('ignores external or protocol-relative next for the default landing', () => {
    for (const next of ['https://evil.example/steal', '//evil.example/steal', '/\\evil.example']) {
      const p = plan(`token_hash=abc&type=signup&${new URLSearchParams({ next }).toString()}`);
      expect(p).toMatchObject({ kind: 'verify-otp', successPath: '/workspaces' });
    }
  });

  it('always sends recovery links to /reset-password', () => {
    expect(plan('token_hash=abc&type=recovery&next=/workspaces')).toMatchObject({
      kind: 'verify-otp',
      type: 'recovery',
      successPath: '/reset-password',
    });
  });

  it('exchanges a PKCE/OAuth code', () => {
    expect(plan('code=xyz&next=/workspaces?tab=archived')).toEqual({
      kind: 'exchange-code',
      code: 'xyz',
      successPath: '/workspaces?tab=archived',
    });
  });

  it('fails without parameters, with an unknown type, or with a provider error', () => {
    expect(plan('')).toEqual({ kind: 'fail', reason: 'missing' });
    expect(plan('token_hash=abc&type=bogus')).toEqual({ kind: 'fail', reason: 'invalid' });
    expect(plan('token_hash=abc')).toEqual({ kind: 'fail', reason: 'invalid' });
    expect(plan('error=access_denied&error_code=otp_expired&type=signup')).toEqual({
      kind: 'fail',
      reason: 'expired',
      flow: 'signup',
    });
    expect(plan('error=server_error')).toEqual({ kind: 'fail', reason: 'invalid' });
  });
});

describe('callback failures', () => {
  it('classifies Auth errors into reason codes', () => {
    expect(classifyCallbackError({ code: 'otp_expired', status: 403 })).toBe('expired');
    expect(classifyCallbackError({ code: 'flow_state_expired', status: 400 })).toBe('expired');
    expect(classifyCallbackError({ code: 'bad_code_verifier', status: 400 })).toBe('invalid');
    expect(classifyCallbackError({ status: 503 })).toBe('unavailable');
    expect(classifyCallbackError({ name: 'AuthRetryableFetchError', status: 0 })).toBe(
      'unavailable',
    );
  });

  it('builds error URLs with reason (and flow) only — never the token', () => {
    const otp = planCallback(new URLSearchParams('token_hash=secret-hash&type=recovery'));
    if (otp.kind !== 'verify-otp') throw new Error('expected verify-otp');
    const path = callbackResultPath(otp, { code: 'otp_expired', status: 403 });
    expect(path).toBe('/auth/error?reason=expired&flow=recovery');
    expect(path).not.toContain('secret-hash');
    expect(callbackResultPath(otp, null)).toBe('/reset-password');

    const code = planCallback(new URLSearchParams('code=secret-code'));
    if (code.kind !== 'exchange-code') throw new Error('expected exchange-code');
    expect(callbackResultPath(code, { status: 400 })).toBe('/auth/error?reason=invalid');
    expect(authErrorPath('missing')).toBe('/auth/error?reason=missing');
  });

  it('only accepts known reason codes', () => {
    expect(parseAuthErrorReason('expired')).toBe('expired');
    expect(parseAuthErrorReason('otp_expired')).toBeUndefined();
    expect(parseAuthErrorReason(undefined)).toBeUndefined();
  });
});

// Unit tests for scripts/e2e-log-audit.ts (`node --test scripts/`; part of `make test`).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs, scanLog } from './e2e-log-audit.ts';

const JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVl';

describe('scanLog', () => {
  it('passes the lines our servers actually write', () => {
    const text = [
      '2026-10-17 20:30:46,576 INFO uvicorn.error [request_id=-] Uvicorn running on http://127.0.0.1:8160',
      '2026-10-17 20:30:47,039 INFO quiz_api.access [request_id=abc] GET /api/v1/me 401 3.0ms',
      '2026-10-17 20:30:47,039 INFO quiz_api.access [request_id=abc] GET /health/live 200 1.0ms',
      '   ▲ Next.js 16.3.8',
      ' ✓ Ready in 120ms',
      'Authorization header missing ([REDACTED])',
    ].join('\n');
    assert.deepEqual(scanLog('x.log', text), []);
  });

  it('flags tokens, session cookies and emails by line and kind without echoing them', () => {
    const text = [
      `token ${JWT}`,
      'Authorization: Bearer sb_secret_abcdefghijk',
      'body {"refresh_token":"v1.abcdefghijkl"}',
      'cookie sb-127-auth-token=base64-eyJhYmNkZWZnaA',
      'login failed for e2e-login-123@example.test',
    ].join('\n');
    const findings = scanLog('web.log', text);
    assert.deepEqual(
      findings.map((f) => [f.line, f.kind]),
      [
        [1, 'jwt'],
        [2, 'bearer token'],
        [3, 'token parameter'],
        [4, 'session cookie'],
        [5, 'email address'],
      ],
    );
    assert.ok(!JSON.stringify(findings).includes('example.test'));
  });
});

describe('parseArgs', () => {
  it('splits own options from Playwright arguments', () => {
    assert.deepEqual(
      parseArgs(['--web-port', '3170', '--no-build', '--', 'a.spec.ts', '--project', 'p']),
      {
        webPort: 3170,
        apiPort: 8160,
        build: false,
        playwrightArgs: ['a.spec.ts', '--project', 'p'],
      },
    );
  });
});

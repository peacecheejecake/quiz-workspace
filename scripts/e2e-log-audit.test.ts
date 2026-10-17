// Unit tests for scripts/e2e-log-audit.ts (`node --test scripts/`; part of `make test`).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseArgs, run, scanLog, startLogged, stop } from './e2e-log-audit.ts';

describe('server logging while Playwright runs', () => {
  it('never stalls a server that writes more than a pipe buffer (>1MB) of logs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-audit-test-'));
    const log = join(dir, 'server.log');
    // "Server": 2MB of log lines on stdout and stderr, then a marker, then stays alive.
    const server = startLogged(
      process.execPath,
      [
        '-e',
        `const line = 'x'.repeat(1023) + '\\n';
         for (let i = 0; i < 1024; i++) { process.stdout.write(line); process.stderr.write(line); }
         process.stdout.write('SERVER-DONE\\n');
         setInterval(() => {}, 1000);`,
      ],
      process.env,
      log,
    );
    try {
      // "Playwright": exits 0 only once the server got past its logging (10s budget).
      const status = await run(
        process.execPath,
        [
          '-e',
          `const fs = require('node:fs');
           const until = Date.now() + 10000;
           const t = setInterval(() => {
             if (fs.readFileSync(${JSON.stringify(log)}, 'utf8').includes('SERVER-DONE')) process.exit(0);
             if (Date.now() > until) process.exit(3);
           }, 50);`,
        ],
        process.env,
      );
      assert.equal(status, 0);
      assert.ok(statSync(log).size > 2 * 1024 * 1024);
      assert.ok(readFileSync(log, 'utf8').endsWith('SERVER-DONE\n'));
    } finally {
      stop(server);
    }
  });

  it('resolves the exit code of the command it runs', async () => {
    assert.equal(await run(process.execPath, ['-e', 'process.exit(7)'], process.env), 7);
  });
});

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

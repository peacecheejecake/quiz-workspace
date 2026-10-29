// `pnpm e2e:log-audit [--web-port 3160] [--api-port 8160] [--no-build] [--worker] -- <playwright args>`
//
// A3 (docs/auth.md §3/§5, AGENTS.md §5): runs Playwright specs against a web server and an API
// started here with their logs captured to files (API at LOG_LEVEL=INFO, `next start`), then fails
// if either log contains a JWT, a bearer/refresh/access token, a Supabase session cookie value, an
// email address, or (S4) a share session token, a share-link secret (`#k=` fragment or a `secret`
// JSON value), a signed Storage URL token or a password value. `--worker` also starts the Celery
// worker (`python -m quiz_worker.serve`, same environment, e.g. APP_ENV=test for the fork specs)
// and scans its log too. Example:
//
//   pnpm e2e:log-audit -- tests/e2e/auth/login.spec.ts tests/e2e/auth/callback.spec.ts \
//     --project unauthenticated-chromium
//
// `--scan <file>` (repeatable) audits log files that already exist instead, e.g. API/worker/web
// logs exported from Railway and Vercel after the staging smoke (DEP-07, docs/runbook-deploy.md);
// no server or Playwright is started then:
//
//   pnpm e2e:log-audit --scan api.log --scan worker.log --scan web.log
//
// Logs land in a fresh temp directory (Playwright wipes test-results/ when it starts); the path is
// printed at the end. Runs on plain Node (type stripping).
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
}

const PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['jwt', /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/],
  ['bearer token', /\bBearer\s+[\w.~+/-]{8,}/i],
  ['token parameter', /\b(?:access|refresh)_token["']?\s*[=:]\s*["']?[\w.~+/-]{8,}/i],
  ['session cookie', /\bsb-[\w-]+-auth-token(?:\.\d+)?=[^;\s]{8,}/],
  // Celery names its node `celery@<hostname>`; that is not an address.
  ['email address', /\b(?!celery@)[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/],
  // S4: the guest share capability and Storage credentials.
  ['share session token', /\bv1\.[0-9a-f]{32}\.\d{9,12}\.[\w-]{43}\b/],
  ['share link secret', /(?:#|%23)k(?:=|%3D)[\w-]{16,}/i],
  ['share link secret', /["']secret["']\s*:\s*["'][\w-]{16,}/],
  ['signed url token', /[?&](?:amp;)?token=[\w.~+/%-]{16,}/],
  ['password', /\bpassword["']?\s*[=:]\s*["']?[^\s"'&,;[\]{}]{6,}/i],
];

/** Sensitive values in a log text: line numbers and kinds only, never the value itself. */
export function scanLog(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((content, index) => {
    for (const [kind, pattern] of PATTERNS) {
      if (pattern.test(content)) findings.push({ file, line: index + 1, kind });
    }
  });
  return findings;
}

interface Options {
  webPort: number;
  apiPort: number;
  build: boolean;
  worker: boolean;
  scan: string[];
  playwrightArgs: string[];
}

export function parseArgs(argv: readonly string[]): Options {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const options: Options = {
    webPort: 3160,
    apiPort: 8160,
    build: true,
    worker: false,
    scan: [],
    playwrightArgs: split === -1 ? [] : argv.slice(split + 1),
  };
  for (let i = 0; i < own.length; i++) {
    const arg = own[i];
    if (arg === '--no-build') options.build = false;
    else if (arg === '--worker') options.worker = true;
    else if (arg === '--web-port') options.webPort = Number(own[++i]);
    else if (arg === '--api-port') options.apiPort = Number(own[++i]);
    else if (arg === '--scan') {
      const file = own[++i];
      if (!file) throw new Error('--scan needs a file');
      options.scan.push(file);
    } else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

async function waitFor(url: string, server: ChildProcess, name: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`${name} exited with ${server.exitCode}`);
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${name} did not come up at ${url}`);
}

/**
 * Starts a server (own process group) whose stdout+stderr go straight to `log` through a file
 * descriptor: nothing is piped through this process, so a chatty server can never block on a full
 * pipe while we wait for Playwright.
 */
export function startLogged(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  log: string,
): ChildProcess {
  const fd = openSync(log, 'a');
  try {
    return spawn(command, args, { env, stdio: ['ignore', fd, fd], detached: true });
  } finally {
    closeSync(fd); // the child holds its own copy
  }
}

/** Runs a command with inherited stdio without blocking the event loop; resolves its exit code. */
export function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export function stop(child: ChildProcess): void {
  if (child.pid !== undefined && child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGTERM'); // the whole group (pnpm/uv wrappers + server)
    } catch {
      child.kill('SIGTERM');
    }
  }
}

/** Audits existing log files; an empty file fails (an export that captured nothing). */
export function scanFiles(files: readonly string[]): { findings: Finding[]; empty: string[] } {
  const findings: Finding[] = [];
  const empty: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!text.trim()) empty.push(file);
    findings.push(...scanLog(file, text));
  }
  return { findings, empty };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.scan.length > 0) {
    const { findings, empty } = scanFiles(options.scan);
    for (const file of empty) console.error(`log-audit: ${file} is empty (nothing was exported)`);
    for (const f of findings) console.error(`log-audit: ${f.kind} in ${f.file}:${f.line}`);
    console.log(`log-audit: scanned ${options.scan.length} file(s): ${findings.length} finding(s)`);
    return findings.length > 0 || empty.length > 0 ? 1 : 0;
  }
  const webUrl = `http://127.0.0.1:${options.webPort}`;
  const apiUrl = `http://127.0.0.1:${options.apiPort}`;
  const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321').replace(
    /\/+$/,
    '',
  );
  const dir = mkdtempSync(join(tmpdir(), 'quiz-log-audit-'));
  const env = {
    ...process.env,
    NEXT_PUBLIC_API_BASE_URL: apiUrl,
    E2E_BASE_URL: webUrl,
    // Same as playwright.config.ts: the E2E web build has the auth CAPTCHA on with Cloudflare's
    // always-passes test sitekey; tests/e2e/fixtures/turnstile.ts answers the browser's requests.
    NEXT_PUBLIC_TURNSTILE_SITE_KEY:
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || '1x00000000000000000000AA',
    // CHNOTE-01: the API and worker of the main E2E stack create chapter notes (the scenario LLM
    // under APP_ENV=test); the feature-off stack overrides it (tests/e2e/fixtures/chapter-notes.ts
    // N9).
    WORKER_CHAPTER_NOTES: process.env.WORKER_CHAPTER_NOTES?.trim() || 'true',
    // DOCSUM-01: API and worker summarize (APP_ENV=test fake summarizer); DOCSUM-01-AC05 starts
    // its own WORKER_DOCUMENT_SUMMARY=false stack (tests/e2e/fixtures/summary.ts D8).
    WORKER_DOCUMENT_SUMMARY: process.env.WORKER_DOCUMENT_SUMMARY?.trim() || 'true',
  };

  if (options.build) {
    const build = await run('pnpm', ['--filter', '@quiz/web', 'build'], env);
    if (build !== 0) return build;
  }

  const apiLog = join(dir, 'api.log');
  const webLog = join(dir, 'web.log');
  const api = startLogged(
    'uv',
    ['run', 'python', '-m', 'quiz_api.serve', '--port', String(options.apiPort)],
    {
      ...env,
      LOG_LEVEL: 'INFO',
      PYTHONUNBUFFERED: '1',
      CORS_ALLOWED_ORIGINS: webUrl,
      SUPABASE_JWT_ISSUER: process.env.SUPABASE_JWT_ISSUER || `${supabaseUrl}/auth/v1`,
      SUPABASE_JWKS_URL:
        process.env.SUPABASE_JWKS_URL || `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
    },
    apiLog,
  );
  const web = startLogged(
    'pnpm',
    [
      '--filter',
      '@quiz/web',
      'exec',
      'next',
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(options.webPort),
    ],
    env,
    webLog,
  );

  const workerLog = join(dir, 'worker.log');
  const worker = options.worker
    ? startLogged(
        'uv',
        ['run', 'python', '-m', 'quiz_worker.serve'],
        { ...env, LOG_LEVEL: 'INFO', PYTHONUNBUFFERED: '1' },
        workerLog,
      )
    : null;

  let status: number;
  try {
    await waitFor(`${apiUrl}/health/live`, api, 'API');
    await waitFor(`${webUrl}/login`, web, 'web');
    status = await run('pnpm', ['exec', 'playwright', 'test', ...options.playwrightArgs], {
      ...env,
      E2E_REUSE_SERVERS: '1',
    });
  } finally {
    stop(api);
    stop(web);
    if (worker) stop(worker);
    await new Promise((r) => setTimeout(r, 500));
  }

  const apiText = readFileSync(apiLog, 'utf8');
  const webText = readFileSync(webLog, 'utf8');
  // Non-vacuous: both servers logged through the captured streams during the run.
  if (!/quiz_api\.access .* GET \/health\/live 200/.test(apiText) || !/Ready in/.test(webText)) {
    console.error('log-audit: server logs were not captured');
    return 1;
  }
  const findings = [...scanLog(apiLog, apiText), ...scanLog(webLog, webText)];
  if (worker) {
    const workerText = readFileSync(workerLog, 'utf8');
    if (!/celery@|ready\./i.test(workerText)) {
      console.error('log-audit: worker log was not captured');
      return 1;
    }
    findings.push(...scanLog(workerLog, workerText));
  }
  for (const f of findings) console.error(`log-audit: ${f.kind} in ${f.file}:${f.line}`);
  const apiLines = apiText.split('\n').filter((l) => l.includes(' INFO ')).length;
  console.log(
    `log-audit: scanned ${apiLog} (${apiLines} INFO lines) and ${webLog}: ${findings.length} finding(s)`,
  );
  return findings.length > 0 ? 1 : status;
}

if (import.meta.main) {
  process.exitCode = await main();
}

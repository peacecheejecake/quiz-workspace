import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WEB_DIR = resolve(import.meta.dirname, '..');
const LOADER = join(WEB_DIR, 'load-root-env.ts');

// Runs in a fresh Node process (fresh @next/env module cache), reproducing what happens under
// `next dev` / `next build`: Next loads apps/web/.env* first, then next.config runs the fallback.
const CHILD = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const [rootDir, appDir, loader, webDir, strategy] = process.argv.slice(1);
const { loadEnvConfig } = createRequire(webDir + '/')('@next/env');
loadEnvConfig(appDir, true, { info() {}, error() {} });
let filled = [];
if (strategy === 'next-env-reload') {
  loadEnvConfig(rootDir, true, { info() {}, error() {} });
} else {
  const { loadRootEnvFallback } = await import(pathToFileURL(loader).href);
  filled = loadRootEnvFallback(rootDir);
}
console.log(JSON.stringify({
  filled,
  rootOnly: process.env.QW_ROOT_ONLY,
  preset: process.env.QW_PRESET,
  appWins: process.env.QW_APP_WINS,
  rootLocal: process.env.QW_ROOT_LOCAL,
}));
`;

interface ChildResult {
  filled: string[];
  rootOnly?: string;
  preset?: string;
  appWins?: string;
  rootLocal?: string;
}

let rootDir: string;
let appDir: string;

function runChild(extraEnv: Record<string, string>, strategy = 'fallback'): ChildResult {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: 'development', ...extraEnv };
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', CHILD, rootDir, appDir, LOADER, WEB_DIR, strategy],
    { cwd: WEB_DIR, env, encoding: 'utf8' },
  );
  return JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as ChildResult;
}

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'qw-root-env-'));
  appDir = mkdtempSync(join(tmpdir(), 'qw-app-env-'));
  writeFileSync(
    join(rootDir, '.env'),
    'QW_ROOT_ONLY=from-root\nQW_PRESET=from-root\nQW_APP_WINS=from-root\nQW_ROOT_LOCAL=from-root-env\n',
  );
  writeFileSync(join(rootDir, '.env.local'), 'QW_ROOT_LOCAL=from-root-local\n');
  writeFileSync(join(appDir, '.env'), 'QW_APP_WINS=from-app\n');
});

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
  rmSync(appDir, { recursive: true, force: true });
});

describe('loadRootEnvFallback (fresh process)', () => {
  it('fills unset keys from the root .env, keeps env and app-local values', () => {
    const result = runChild({ QW_PRESET: 'from-process' });
    expect(result.rootOnly).toBe('from-root');
    expect(result.preset).toBe('from-process');
    expect(result.appWins).toBe('from-app');
    expect(result.rootLocal).toBe('from-root-local');
    expect(result.filled.sort()).toEqual(['QW_ROOT_LOCAL', 'QW_ROOT_ONLY']);
  });

  it('is needed because a second @next/env loadEnvConfig call returns its cache', () => {
    expect(runChild({}, 'next-env-reload').rootOnly).toBeUndefined();
  });
});

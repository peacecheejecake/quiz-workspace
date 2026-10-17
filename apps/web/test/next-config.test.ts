import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_DIR = resolve(import.meta.dirname, '..');

// Loads apps/web/next.config.ts through Next's real config loader in a fresh process, once via
// the legacy SWC transpile path (default) and once via Node's native TypeScript loading
// (`next build --experimental-next-config-strip-types`, and the path newer Node/Next pick
// natively). Native loading silently falls back to legacy on failure and records that by setting
// __NEXT_NODE_NATIVE_TS_LOADER_ENABLED=false, so the child reports the flag after loading.
const CHILD = `
import { createRequire } from 'node:module';
const [webDir] = process.argv.slice(1);
const require = createRequire(webDir + '/');
const { default: loadConfig } = require('next/dist/server/config');
const { PHASE_PRODUCTION_BUILD } = require('next/constants');
const config = await loadConfig(PHASE_PRODUCTION_BUILD, webDir);
const headers = await config.headers();
console.log(JSON.stringify({
  nativeFlag: process.env.__NEXT_NODE_NATIVE_TS_LOADER_ENABLED ?? null,
  nodeTypeScript: process.features.typescript ?? null,
  poweredByHeader: config.poweredByHeader,
  shareHeaders: headers.find((h) => h.source === '/share/:path*')?.headers ?? null,
}));
`;

interface ChildResult {
  nativeFlag: string | null;
  nodeTypeScript: string | null;
  poweredByHeader: boolean;
  shareHeaders: { key: string; value: string }[] | null;
}

function loadThroughNext(native: boolean): ChildResult {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    ...(native ? { __NEXT_NODE_NATIVE_TS_LOADER_ENABLED: 'true' } : {}),
  };
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', CHILD, WEB_DIR], {
    cwd: WEB_DIR,
    env,
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as ChildResult;
}

function expectAppConfig(result: ChildResult) {
  expect(result.poweredByHeader).toBe(false);
  expect(result.shareHeaders).toEqual(
    expect.arrayContaining([
      { key: 'Cache-Control', value: 'private, no-store' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
    ]),
  );
}

describe('next.config.ts through the Next.js config loader', () => {
  it('loads with the legacy transpiling loader', () => {
    const result = loadThroughNext(false);
    expect(result.nativeFlag).toBeNull();
    expectAppConfig(result);
  });

  it('loads with Node native TypeScript resolution without falling back', () => {
    const result = loadThroughNext(true);
    expect(result.nodeTypeScript).toBeTruthy();
    expect(result.nativeFlag).toBe('true');
    expectAppConfig(result);
  });
}, 60_000);

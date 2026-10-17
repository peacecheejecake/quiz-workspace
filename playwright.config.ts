// Playwright E2E harness (P0.10). Workflow and decisions: tests/e2e/README.md.
//
// - Specs live at the paths declared in docs/screens/*.md; titles start with the AC ID
//   (`pnpm e2e:trace` checks both). tests/e2e/_pending holds pre-harness starter specs and never runs.
// - The web app is a production build (`next build` + `next start`) so tests see production
//   behaviour (headers, no dev overlay/HMR); an already running server on the base URL is reused
//   locally (e.g. `make web-dev`).
// - Artifacts: traces/screenshots/videos only for failures. Browser traces record network
//   traffic, so fixtures talk to Supabase Auth/Mailpit via Node fetch (never `page`/`request`)
//   and only synthetic users on the local stack ever appear in a trace.
import { globSync } from 'node:fs';
import { defineConfig, devices, type PlaywrightTestOptions } from '@playwright/test';

const CI = !!process.env.CI;
const BASE_URL = (process.env.E2E_BASE_URL?.trim() || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const { hostname, port } = new URL(BASE_URL);
// FastAPI: the web app calls it server-side and the M3+ data fixtures create workspaces/documents
// through it (tests/e2e/fixtures/api.ts).
const API_URL = (process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || 'http://127.0.0.1:8000').replace(
  /\/+$/,
  '',
);
const api = new URL(API_URL);
// Local-stack defaults (.env.example) so CI, which has no .env, verifies tokens and reaches the DB.
const SUPABASE_URL = (
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || 'http://127.0.0.1:54321'
).replace(/\/+$/, '');
const apiEnv = {
  NEXT_PUBLIC_API_BASE_URL: API_URL,
  SUPABASE_JWT_ISSUER: process.env.SUPABASE_JWT_ISSUER || `${SUPABASE_URL}/auth/v1`,
  SUPABASE_JWKS_URL:
    process.env.SUPABASE_JWKS_URL || `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
  DATABASE_URL:
    process.env.DATABASE_URL || 'postgresql://quiz_api:change-me-local@127.0.0.1:54322/postgres',
  // The web origin under test is the browser origin the API must allow (A3 CORS allowlist).
  CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS || BASE_URL,
};

const TEST_DIR = 'tests/e2e';
const SPEC = /.*\.spec\.ts$/;
const PENDING = '**/_pending/**';

// Specs that must run without a session (cookie-less context). Everything else outside
// `harness/` is an authenticated spec. ACCOUNT-01 lives under auth/ but needs a session.
const UNAUTHENTICATED_SPECS = [
  /auth\/(?!account-security\.spec\.ts$)[^/]+\.spec\.ts$/,
  /workspaces\/share-public\.spec\.ts$/,
];
const HARNESS_SPECS = /harness\/[^/]+\.spec\.ts$/;
const AUTH_STATE = 'playwright/.auth/user.json';

// The authenticated projects (and their `setup`/`teardown`) exist only once a phase adds
// authenticated specs: setup signs in through the real /login, which is a stub until A2.
const hasAuthenticatedSpecs = globSync('**/*.spec.ts', { cwd: TEST_DIR, exclude: [PENDING] }).some(
  (file) => !HARNESS_SPECS.test(file) && !UNAUTHENTICATED_SPECS.some((re) => re.test(file)),
);

// Deterministic browser environment for every project (docs/e2e-strategy.md §3).
const pinned: Partial<PlaywrightTestOptions> = {
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  colorScheme: 'light',
  reducedMotion: 'reduce',
};
const noSession = { storageState: { cookies: [], origins: [] } };

const chromium = { ...devices['Desktop Chrome'], ...pinned };
const webkit = { ...devices['Desktop Safari'], ...pinned };

export default defineConfig({
  testDir: TEST_DIR,
  testIgnore: [PENDING],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  outputDir: 'test-results',
  reporter: CI
    ? [['list'], ['html', { open: 'never' }], ['junit', { outputFile: 'test-results/junit.xml' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    // Missing elements fail fast with a locator message instead of running into the test timeout.
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },
  webServer: [
    {
      command: `pnpm --filter @quiz/web build && pnpm --filter @quiz/web exec next start --hostname ${hostname} --port ${port || '3000'}`,
      url: `${BASE_URL}/login`,
      env: { NEXT_PUBLIC_API_BASE_URL: API_URL },
      reuseExistingServer: !CI,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // The only supported launcher (implementation-plan §7); never bare uvicorn.
      command: `uv run python -m quiz_api.serve --host ${api.hostname} --port ${api.port || '8000'}`,
      url: `${API_URL}/health/live`,
      env: apiEnv,
      reuseExistingServer: !CI,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
  projects: [
    { name: 'harness-chromium', testMatch: HARNESS_SPECS, use: { ...chromium, ...noSession } },
    { name: 'harness-webkit', testMatch: HARNESS_SPECS, use: { ...webkit, ...noSession } },
    {
      name: 'unauthenticated-chromium',
      testMatch: UNAUTHENTICATED_SPECS,
      use: { ...chromium, ...noSession },
    },
    {
      name: 'unauthenticated-webkit',
      testMatch: UNAUTHENTICATED_SPECS,
      use: { ...webkit, ...noSession },
    },
    ...(hasAuthenticatedSpecs
      ? [
          { name: 'setup', testMatch: /setup\/auth\.setup\.ts$/, teardown: 'teardown' },
          { name: 'teardown', testMatch: /setup\/auth\.teardown\.ts$/ },
          {
            name: 'authenticated-chromium',
            testMatch: SPEC,
            testIgnore: [PENDING, HARNESS_SPECS, ...UNAUTHENTICATED_SPECS],
            use: { ...chromium, storageState: AUTH_STATE },
            dependencies: ['setup'],
          },
          {
            name: 'authenticated-webkit',
            testMatch: SPEC,
            testIgnore: [PENDING, HARNESS_SPECS, ...UNAUTHENTICATED_SPECS],
            use: { ...webkit, storageState: AUTH_STATE },
            dependencies: ['setup'],
          },
        ]
      : []),
  ],
});

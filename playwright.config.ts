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
// `pnpm e2e:log-audit` (also in CI) starts the web/API/worker servers itself to capture their logs
// and sets this, so Playwright uses them instead of refusing an occupied port.
const REUSE_SERVERS = !CI || process.env.E2E_REUSE_SERVERS === '1';
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

// Mirrors TEST_SITE_KEY in tests/e2e/fixtures/turnstile.ts (the config does not import fixtures).
const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
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
// M7.2 cross-screen quality checks (tests/e2e/quality/, IDs A11Y/VISUAL/SMOKE/PERF-nn): every
// test signs in its own per-test user, so these projects start without a session.
const A11Y_SPECS = /quality\/a11y[^/]*\.spec\.ts$/;
const SMOKE_SPECS = /quality\/smoke\.spec\.ts$/;
const VISUAL_SPECS = /quality\/visual\.spec\.ts$/;
const PERF_SPECS = /quality\/perf\.spec\.ts$/;
const QUALITY_SPECS = /quality\/[^/]+\.spec\.ts$/;

// Visual baselines are Linux renders from the pinned Playwright image (fonts and rasterizer
// differ per OS; tests/e2e/README.md "Visual baselines"). The visual projects exist only where
// that renderer is available: `E2E_VISUAL_WS_ENDPOINT` (a `playwright run-server` in the image,
// started by `pnpm e2e:visual`; page traffic to loopback is tunnelled back to this host) or
// `E2E_VISUAL=1` (this runner *is* the image, e.g. a CI job container).
const VISUAL_WS = process.env.E2E_VISUAL_WS_ENDPOINT?.trim();
const VISUAL_ENABLED = !!VISUAL_WS || process.env.E2E_VISUAL === '1';
const visualBrowser = VISUAL_WS
  ? { connectOptions: { wsEndpoint: VISUAL_WS, exposeNetwork: '<loopback>' } }
  : {};
// Web Vitals and API latency are timing measurements: opt-in (`E2E_PERF=1`, `pnpm e2e:perf`) so a
// loaded parallel run never turns them into flaky failures.
const PERF_ENABLED = process.env.E2E_PERF === '1';
const AUTH_STATE = 'playwright/.auth/user.json';

// The authenticated projects (and their `setup`/`teardown`) exist only once a phase adds
// authenticated specs: setup signs in through the real /login, which is a stub until A2.
const hasAuthenticatedSpecs = globSync('**/*.spec.ts', { cwd: TEST_DIR, exclude: [PENDING] }).some(
  (file) =>
    !HARNESS_SPECS.test(file) &&
    !QUALITY_SPECS.test(file) &&
    !UNAUTHENTICATED_SPECS.some((re) => re.test(file)),
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
// Visual: Chromium for both form factors (one rasterizer per baseline); the iPad project keeps
// the iPad Pro 11 portrait viewport and touch but a 1× scale so baselines stay small.
const visualDesktop = { ...chromium, viewport: { width: 1280, height: 800 }, ...visualBrowser };
const visualIpad = {
  ...chromium,
  viewport: { width: 834, height: 1194 },
  hasTouch: true,
  ...visualBrowser,
};
const visualSnapshots = '{testDir}/{testFileDir}/__screenshots__/{arg}-{projectName}{ext}';

export default defineConfig({
  testDir: TEST_DIR,
  testIgnore: [PENDING],
  timeout: 45_000,
  expect: {
    timeout: 10_000,
    // Visual baselines (quality/visual.spec.ts): same renderer, so only antialiasing noise.
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.002,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
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
      env: {
        NEXT_PUBLIC_API_BASE_URL: API_URL,
        // CAPTCHA on (docs/auth.md §5.1): Cloudflare's always-passes test sitekey. The browser's
        // Turnstile requests are answered by tests/e2e/fixtures/turnstile.ts, never by Cloudflare.
        NEXT_PUBLIC_TURNSTILE_SITE_KEY:
          process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || TURNSTILE_TEST_SITE_KEY,
      },
      reuseExistingServer: REUSE_SERVERS,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // The only supported launcher (implementation-plan §7); never bare uvicorn.
      command: `uv run python -m quiz_api.serve --host ${api.hostname} --port ${api.port || '8000'}`,
      url: `${API_URL}/health/live`,
      env: apiEnv,
      reuseExistingServer: REUSE_SERVERS,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
  projects: [
    { name: 'harness-chromium', testMatch: HARNESS_SPECS, use: { ...chromium, ...noSession } },
    { name: 'harness-webkit', testMatch: HARNESS_SPECS, use: { ...webkit, ...noSession } },
    { name: 'a11y-chromium', testMatch: A11Y_SPECS, use: { ...chromium, ...noSession } },
    // WebKit/mobile smoke of the key flows (docs/e2e-strategy.md §3: WebKit/iPad + Mobile Chrome).
    {
      name: 'smoke-ipad-webkit',
      testMatch: SMOKE_SPECS,
      use: { ...devices['iPad Pro 11'], ...pinned, ...noSession },
    },
    {
      name: 'smoke-iphone-webkit',
      testMatch: SMOKE_SPECS,
      use: { ...devices['iPhone 14'], ...pinned, ...noSession },
    },
    {
      name: 'smoke-mobile-chrome',
      testMatch: SMOKE_SPECS,
      use: { ...devices['Pixel 7'], ...pinned, ...noSession },
    },
    ...(VISUAL_ENABLED
      ? [
          {
            name: 'visual-desktop',
            testMatch: VISUAL_SPECS,
            snapshotPathTemplate: visualSnapshots,
            use: { ...visualDesktop, ...noSession },
          },
          {
            name: 'visual-ipad',
            testMatch: VISUAL_SPECS,
            snapshotPathTemplate: visualSnapshots,
            use: { ...visualIpad, ...noSession },
          },
        ]
      : []),
    ...(PERF_ENABLED
      ? [{ name: 'perf-chromium', testMatch: PERF_SPECS, use: { ...chromium, ...noSession } }]
      : []),
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
            testIgnore: [PENDING, HARNESS_SPECS, QUALITY_SPECS, ...UNAUTHENTICATED_SPECS],
            use: { ...chromium, storageState: AUTH_STATE },
            dependencies: ['setup'],
          },
          {
            name: 'authenticated-webkit',
            testMatch: SPEC,
            testIgnore: [PENDING, HARNESS_SPECS, QUALITY_SPECS, ...UNAUTHENTICATED_SPECS],
            use: { ...webkit, storageState: AUTH_STATE },
            dependencies: ['setup'],
          },
        ]
      : []),
  ],
});

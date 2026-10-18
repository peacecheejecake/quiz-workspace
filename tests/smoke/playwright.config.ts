// Deployment smoke (M7.4a): DEP-01..07 checks against a running web/API/Supabase
// (docs/deployment.md §9, docs/runbook-deploy.md "Staging smoke").
//
//   make smoke-local                      local stack, servers + log audit via e2e:log-audit
//   make smoke-staging                    SMOKE_TARGET=staging + the SMOKE_* / E2E_BASE_URL env
//   SMOKE_TARGET=production … --grep @readonly
//
// No traces, screenshots or videos and no HTML report: a deployed target means real JWTs, smoke
// passwords and signed URLs, which must never land in an artifact. Serial (one worker) so the
// smoke accounts sign in once and stay below the hosted Auth rate limits.
import { defineConfig, devices } from '@playwright/test';

const target = process.env.SMOKE_TARGET?.trim() || 'local';
const baseURL = (
  process.env.E2E_BASE_URL?.trim() || (target === 'local' ? 'http://127.0.0.1:3000' : '')
).replace(/\/+$/, '');

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.smoke\.ts$/,
  outputDir: '../../test-results-smoke/output',
  globalSetup: './global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  use: {
    baseURL: baseURL || undefined,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    actionTimeout: 15_000,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  },
  projects: [{ name: 'smoke-chromium', use: { ...devices['Desktop Chrome'] } }],
});

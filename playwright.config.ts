/** Contract-first Playwright starter. Install @playwright/test and seed the app before running. */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'unauthenticated-chromium',
      testMatch: /auth\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: { cookies: [], origins: [] } },
    },
    {
      name: 'unauthenticated-share',
      testMatch: /workspaces\/share-public\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: { cookies: [], origins: [] } },
    },
    {
      name: 'authenticated-chromium',
      testIgnore: /auth\/.*\.spec\.ts|workspaces\/share-public\.spec\.ts|.*\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: 'playwright/.auth/user.json' },
      dependencies: ['setup'],
    },
    {
      name: 'authenticated-webkit',
      testIgnore: /auth\/.*\.spec\.ts|workspaces\/share-public\.spec\.ts|.*\.setup\.ts/,
      use: { ...devices['Desktop Safari'], storageState: 'playwright/.auth/user.json' },
      dependencies: ['setup'],
    },
  ],
});

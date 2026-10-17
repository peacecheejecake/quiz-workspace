// Visual regression of @quiz/ui stories (design-system.md §8: QuestionDot states, star shape).
// Runs against the static Storybook build; not part of `make test` (needs the build + Chromium):
//   pnpm --filter @quiz/ui test:visual            # build Storybook, compare
//   pnpm --filter @quiz/ui test:visual --update-snapshots   # after an intended change
// Baselines are per platform (font rasterization differs): only darwin baselines exist so far;
// another platform must record its own with --update-snapshots. M7.2 moves the baseline of
// record into the CI container (linux) and wires this into CI.
import { defineConfig, devices } from '@playwright/test';

const PORT = 6107;

export default defineConfig({
  testDir: 'visual',
  testMatch: /.*\.visual\.ts$/,
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}-{projectName}-{platform}{ext}',
  outputDir: 'test-results/visual',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled' } },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    colorScheme: 'light',
  },
  webServer: {
    command: `node visual/serve-static.ts storybook-static ${PORT}`,
    url: `http://127.0.0.1:${PORT}/iframe.html`,
    reuseExistingServer: false,
    stdout: 'ignore',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

// Visual regression of @quiz/ui stories (design-system.md §8: QuestionDot states, star shape).
// Runs against the static Storybook build; not part of `make test` (needs the build + Docker):
//   pnpm --filter @quiz/ui test:visual            # build Storybook, compare
//   pnpm --filter @quiz/ui test:visual --update-snapshots   # after an intended change
// Baselines are Linux renders from the pinned Playwright image, like the app's visual baselines
// (M7.2, tests/e2e/README.md "Visual baselines"): `test:visual` runs through
// scripts/visual-run.sh, which provides E2E_VISUAL_WS_ENDPOINT; inside the image set E2E_VISUAL=1.
import { defineConfig, devices } from '@playwright/test';

const PORT = 6107;
const WS = process.env.E2E_VISUAL_WS_ENDPOINT?.trim();
if (!WS && process.env.E2E_VISUAL !== '1') {
  throw new Error(
    'visual baselines are rendered in the pinned Playwright image: run `pnpm --filter @quiz/ui test:visual` (scripts/visual-run.sh) or set E2E_VISUAL=1 inside it',
  );
}

export default defineConfig({
  testDir: 'visual',
  testMatch: /.*\.visual\.ts$/,
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}-{projectName}{ext}',
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
    ...(WS ? { connectOptions: { wsEndpoint: WS, exposeNetwork: '<loopback>' } } : {}),
  },
  webServer: {
    command: `node visual/serve-static.ts storybook-static ${PORT}`,
    url: `http://127.0.0.1:${PORT}/iframe.html`,
    reuseExistingServer: false,
    stdout: 'ignore',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

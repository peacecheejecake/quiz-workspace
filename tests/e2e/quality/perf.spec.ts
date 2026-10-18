// M7.2 performance check (opt-in: `pnpm e2e:perf` = E2E_PERF=1, project perf-chromium, 1 worker).
// The docs set no numeric targets (architecture.md §9 lists "검색 p50/p95" as an operations metric),
// so the budgets below are the common Web Vitals "good" thresholds and loose API latency budgets
// for a local production build with the fake (APP_ENV=test) adapters; they catch regressions such
// as N+1 queries, missing indexes or oversized bundles, not absolute production numbers. Every
// measurement is attached to the test (`perf.json`) and printed for the run log.
import type { Page, TestInfo } from '@playwright/test';
import {
  bankPath,
  book,
  block,
  createNumberedQuestions,
  expect,
  JOB_TIMEOUT_MS,
  overviewPath,
  overviewUi,
  searchUi,
  runSearch,
  signInAs,
  snippet,
  test,
  uploadReadyBook,
  type Member,
} from '../fixtures/test.ts';

test.describe.configure({ mode: 'serial', timeout: 4 * JOB_TIMEOUT_MS });

/** Web Vitals "good" thresholds (web.dev) — local production build. */
const PAGE_BUDGET = { lcpMs: 2_500, cls: 0.1, ttfbMs: 800, jsKiB: 1_024 } as const;
/** p95 over SAMPLES sequential calls against the local API. */
const API_P95_BUDGET_MS = { overview: 500, bank: 500, search: 1_000 } as const;
const QUESTIONS = 300;
const SAMPLES = 15;

interface Vitals {
  readonly ttfbMs: number;
  readonly fcpMs: number;
  readonly lcpMs: number;
  readonly cls: number;
  readonly jsKiB: number;
}

async function vitals(page: Page): Promise<Vitals> {
  return page.evaluate(
    () =>
      new Promise<Vitals>((resolve) => {
        let lcp = 0;
        let cls = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) lcp = Math.max(lcp, e.startTime);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as (PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
          })[]) {
            if (!e.hadRecentInput) cls += e.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });
        // Let buffered entries arrive, then read.
        setTimeout(() => {
          const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
          const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0;
          const js = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
            .filter((r) => r.initiatorType === 'script' || r.name.endsWith('.js'))
            .reduce((n, r) => n + (r.encodedBodySize || r.transferSize || 0), 0);
          resolve({
            ttfbMs: Math.round(nav.responseStart - nav.startTime),
            fcpMs: Math.round(fcp),
            lcpMs: Math.round(lcp),
            cls: Number(cls.toFixed(3)),
            jsKiB: Math.round(js / 1024),
          });
        }, 500);
      }),
  );
}

function p(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0);
}

async function latency(
  member: Member,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ p50: number; p95: number; max: number }> {
  const samples: number[] = [];
  await member.api.ok(method, path, body, [200]); // warm-up
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    await member.api.ok(method, path, body, [200]);
    samples.push(performance.now() - t0);
  }
  return { p50: p(samples, 0.5), p95: p(samples, 0.95), max: Math.round(Math.max(...samples)) };
}

async function record(info: TestInfo, data: unknown): Promise<void> {
  const body = JSON.stringify(data, null, 2);
  console.log(`[perf] ${info.title}\n${body}`);
  await info.attach('perf.json', { body, contentType: 'application/json' });
}

test(
  'PERF-01 key pages meet Web Vitals budgets with a 300-question workspace',
  { tag: '@infra' },
  async ({ page, workspaceFactory }, info) => {
    const owner = await workspaceFactory.member('perf01');
    const ws = await workspaceFactory.create(owner);
    const documentId = await uploadReadyBook(owner, ws.id, 'book-ko');
    await createNumberedQuestions(owner, ws.id, 'perf01', QUESTIONS);
    await signInAs(page, owner.user);

    const pages: Record<string, Vitals> = {};
    const visit = async (name: string, path: string, ready: () => Promise<void>) => {
      await page.goto(path);
      await ready();
      pages[name] = await vitals(page);
    };
    await visit('login (signed out)', '/login', async () => undefined);
    await visit('workspaces', '/workspaces', async () => undefined);
    await visit('questions overview', overviewPath(ws.id), () =>
      expect(overviewUi.dots(page)).toHaveCount(QUESTIONS),
    );
    await visit('question bank', bankPath(ws.id), () =>
      expect(page.getByRole('main').getByRole('listitem').first()).toBeVisible(),
    );
    await visit('documents', `/workspaces/${ws.id}/documents`, async () => undefined);
    await visit('document editor', `/workspaces/${ws.id}/documents/${documentId}`, () =>
      expect(page.getByRole('tree').first()).toBeVisible(),
    );
    await visit('search', `/workspaces/${ws.id}/search`, async () => {
      await runSearch(page, snippet(block(book('book-ko'), 'ch1-s2-p1').text, 10), 'keyword');
      await expect(searchUi.resultItems(page).first()).toBeVisible();
    });
    await record(info, pages);

    for (const [name, v] of Object.entries(pages)) {
      expect.soft(v.lcpMs, `${name} LCP`).toBeLessThanOrEqual(PAGE_BUDGET.lcpMs);
      expect.soft(v.cls, `${name} CLS`).toBeLessThanOrEqual(PAGE_BUDGET.cls);
      expect.soft(v.ttfbMs, `${name} TTFB`).toBeLessThanOrEqual(PAGE_BUDGET.ttfbMs);
      expect.soft(v.jsKiB, `${name} JS (encoded KiB)`).toBeLessThanOrEqual(PAGE_BUDGET.jsKiB);
    }
  },
);

test(
  'PERF-02 heavy API endpoints stay within latency budgets (overview, bank list, search)',
  { tag: '@infra' },
  async ({ workspaceFactory }, info) => {
    const owner = await workspaceFactory.member('perf02');
    const ws = await workspaceFactory.create(owner);
    await uploadReadyBook(owner, ws.id, 'book-ko');
    await createNumberedQuestions(owner, ws.id, 'perf02', QUESTIONS);
    const query = snippet(block(book('book-ko'), 'ch1-s2-p1').text, 10);

    const results = {
      overview: await latency(owner, 'GET', `/workspaces/${ws.id}/questions/overview`),
      bank: await latency(owner, 'GET', `/workspaces/${ws.id}/questions?limit=100`),
      search: await latency(owner, 'POST', `/workspaces/${ws.id}/search`, {
        query,
        mode: 'hybrid',
      }),
    };
    await record(info, { questions: QUESTIONS, samples: SAMPLES, ...results });
    for (const [name, r] of Object.entries(results)) {
      const budget = API_P95_BUDGET_MS[name as keyof typeof API_P95_BUDGET_MS];
      expect.soft(r.p95, `${name} p95 (ms)`).toBeLessThanOrEqual(budget);
    }
  },
);

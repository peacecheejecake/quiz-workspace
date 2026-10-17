// Accessibility scan (M7.2, docs/e2e-strategy.md §4 "axe WCAG 2.2 AA", docs/design-system.md §2):
// axe-core through @axe-core/playwright on the live page, in the light and the dark theme (the app
// follows `prefers-color-scheme`, so the theme is switched with `page.emulateMedia`).
//
// Rules: every WCAG 2.0/2.1/2.2 A + AA rule plus axe's best practices. No rule is disabled and no
// region is excluded. The only exemption is `EXEMPTIONS` below: one (rule, container) pair with
// its reason, applied to the violating nodes after the scan so every other rule still runs on
// the same nodes.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const AXE_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22a',
  'wcag22aa',
  'best-practice',
] as const;

export type ColorScheme = 'light' | 'dark';
export const COLOR_SCHEMES: readonly ColorScheme[] = ['light', 'dark'];

interface Exemption {
  readonly rule: string;
  /** Violating nodes inside this container are exempt from `rule` (and only from it). */
  readonly within: string;
  readonly reason: string;
}

const EXEMPTIONS: readonly Exemption[] = [
  {
    // axe's best-practice `region` (not a WCAG criterion) wants every node inside a landmark.
    // Radix portals menus, popovers and tooltips to <body> so they float above the layout; they
    // are transient layers owned by a trigger that is itself inside a landmark (aria-controls /
    // aria-describedby), and a landmark role on a menu or tooltip would be wrong ARIA.
    rule: 'region',
    within: '[data-radix-popper-content-wrapper]',
    reason: 'portalled popper layer of a trigger inside a landmark',
  },
];

async function isExempt(page: Page, rule: string, target: string): Promise<boolean> {
  const containers = EXEMPTIONS.filter((e) => e.rule === rule).map((e) => e.within);
  if (containers.length === 0) return false;
  return page
    .locator(target)
    .first()
    .evaluate((el, sel) => sel.some((s) => el.closest(s) !== null), containers)
    .catch(() => false);
}

export interface ScanOptions {
  /** Limit the scan to these selectors (e.g. an open dialog); default: the whole page. */
  readonly include?: readonly string[];
  /** Themes to scan; default both. */
  readonly schemes?: readonly ColorScheme[];
}

interface Finding {
  readonly scheme: ColorScheme;
  readonly rule: string;
  readonly impact: string | null | undefined;
  readonly help: string;
  readonly targets: readonly string[];
  readonly summary: string | undefined;
}

/**
 * Runs axe on the current page state in each color scheme and fails with a readable list of
 * violations (rule, impact, first targets) labelled with `state`. Restores the light scheme.
 */
export async function expectAccessible(
  page: Page,
  state: string,
  options: ScanOptions = {},
): Promise<void> {
  const findings: Finding[] = [];
  for (const scheme of options.schemes ?? COLOR_SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    // Two frames so restyled colors (no transitions under reduced motion) are what axe reads.
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    let builder = new AxeBuilder({ page }).withTags([...AXE_TAGS]);
    for (const selector of options.include ?? []) builder = builder.include(selector);
    const result = await builder.analyze();
    for (const v of result.violations) {
      const nodes = [];
      for (const node of v.nodes) {
        if (!(await isExempt(page, v.id, node.target.join(' ')))) nodes.push(node);
      }
      if (nodes.length === 0) continue;
      findings.push({
        scheme,
        rule: v.id,
        impact: v.impact,
        help: v.help,
        targets: nodes.slice(0, 6).map((n) => n.target.join(' ')),
        summary: nodes[0]?.failureSummary?.split('\n').slice(0, 3).join(' '),
      });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  const report = findings
    .map(
      (f) =>
        `[${f.scheme}] ${f.rule} (${f.impact ?? 'n/a'}): ${f.help}\n    ${f.targets.join('\n    ')}` +
        (f.summary ? `\n    ${f.summary}` : ''),
    )
    .join('\n');
  expect(findings, `axe violations in "${state}":\n${report}`).toEqual([]);
}

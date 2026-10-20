import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CSS_PATH,
  TS_PATH,
  findStale,
  generate,
  loadTokenSource,
  parseTokenSource,
} from '../build-tokens.ts';
import {
  breakpoints,
  cssVar,
  mediaQueries,
  questionStatusVar,
  questionStatuses,
  staticTokens,
  themedTokens,
} from '../src/index.ts';

const DESIGN_DOC = resolve(import.meta.dirname, '../../../docs/design-system.md');
const STATUS_TOKENS = questionStatuses.map((s) => `--question-status-${s}`);
const EXPECTED_STATUSES = ['unseen', 'viewed', 'incorrect', 'correct', 'retry'];

type Decls = Record<string, string>;

/** Canonical form so `rgba(255,255,255,.78)` == `rgba(255, 255, 255, 0.78)` and #ABC == #abc. */
function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/'/g, '"')
    .replace(/\s+/g, '')
    .replace(/(^|[^\d])\.(\d)/g, '$10.$2');
}

function pairs(text: string, pattern: RegExp): Decls {
  const out: Decls = {};
  for (const [, name = '', value = ''] of text.matchAll(pattern)) out[name] = normalize(value);
  return out;
}

function declarations(block: string): Decls {
  return pairs(block, /(--[a-z0-9-]+|color-scheme)\s*:\s*([^;]+);/g);
}

function section(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  expect(start, `heading "${heading}" in design-system.md`).toBeGreaterThanOrEqual(0);
  const next = doc.indexOf('\n#', start + heading.length);
  return doc.slice(start, next === -1 ? undefined : next);
}

function cssBlock(css: string, selector: RegExp): string {
  const m = css.match(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`));
  expect(m, `block ${selector} present`).not.toBeNull();
  return m?.[1] ?? '';
}

function themedForTheme(theme: 'light' | 'dark'): Decls {
  return Object.fromEntries(
    Object.entries(themedTokens[theme]).map(([n, v]) => [`--${n}`, normalize(v)]),
  );
}

function pick(decls: Decls, keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((k) => [k, decls[k]]));
}

// Values straight from the spec, so the test fails if tokens.json and the doc drift apart.
const doc = readFileSync(DESIGN_DOC, 'utf8');
const docLight = pairs(section(doc, '### 3.1'), /^\|\s*`(--[a-z0-9-]+)`\s*\|\s*`([^`]+)`/gm);
const docDark = declarations(cssBlock(section(doc, '### 3.2'), /\[data-theme="dark"\]/));
const docRoot = declarations(cssBlock(section(doc, '### 3.3'), /:root/));

const css = readFileSync(CSS_PATH, 'utf8');
const genLight = declarations(cssBlock(css, /:root/));
const genDark = declarations(cssBlock(css, /\[data-theme=["']dark["']\]/));

describe('spec extraction (guards against a vacuous comparison)', () => {
  it('finds every color token of §3.1, §3.2 and the §3.3 :root example', () => {
    // 15 v1.1 colors + 6 v1.1.1 additions (border-strong, on-accent, danger/success/warning, scrim)
    // + 4 v1.2 additions (glass-solid, state-hover/pressed/selected)
    // + 3 v1.2.1 additions (accent-hover/pressed, state-selected-hover)
    // + 4 v1.2.2 switch track colors (track, track-hover, track-border, track-checked-border).
    expect(Object.keys(docLight)).toHaveLength(32);
    expect(Object.keys(docDark)).toHaveLength(32);
    // 32 colors + 25 font/space/radius/glass/shadow/control/layout/heatmap vars + 12 typography
    // + 2 breakpoints + color-scheme.
    expect(Object.keys(docRoot)).toHaveLength(72);
  });
});

describe('generated tokens.css', () => {
  it('light :root colors equal design-system.md §3.1', () => {
    expect(pick(genLight, Object.keys(docLight))).toEqual(docLight);
  });

  it('dark [data-theme="dark"] colors equal design-system.md §3.2', () => {
    expect(pick(genDark, Object.keys(docDark))).toEqual(docDark);
  });

  it(':root contains every declaration of the §3.3 example with the same value', () => {
    expect(pick(genLight, Object.keys(docRoot))).toEqual(docRoot);
  });

  it('themes define exactly the same color tokens (no theme-only gaps)', () => {
    const themedKeys = Object.keys(genDark).filter((k) => k !== 'color-scheme');
    expect(themedKeys.sort()).toEqual(Object.keys(docLight).sort());
    expect(genLight['color-scheme']).toBe('light');
    expect(genDark['color-scheme']).toBe('dark');
  });

  it('follows the OS dark preference unless a light scope is explicit', () => {
    const media = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    const followDark = declarations(cssBlock(media, /:root:not\(\[data-theme=["']light["']\]\)/));
    expect(followDark).toEqual(genDark);
    const explicitLight = declarations(cssBlock(css, /\n\[data-theme=["']light["']\]/));
    const themedLight = Object.fromEntries(
      Object.keys(followDark).map((k) => [k, genLight[k]] as const),
    );
    expect(explicitLight).toEqual(themedLight);
  });

  it.each(['light', 'dark'] as const)('every question status token exists in %s', (theme) => {
    const decls = theme === 'light' ? genLight : genDark;
    expect(questionStatuses).toEqual(EXPECTED_STATUSES);
    for (const token of STATUS_TOKENS) expect(decls[token], token).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('generated TS module', () => {
  it.each(['light', 'dark'] as const)('%s values equal the generated CSS', (theme) => {
    const decls = theme === 'light' ? genLight : genDark;
    const ts = themedForTheme(theme);
    expect(pick(decls, Object.keys(ts))).toEqual(ts);
    for (const token of STATUS_TOKENS) expect(ts[token], token).toBeDefined();
  });

  it('static values equal the generated CSS :root', () => {
    const ts = Object.fromEntries(
      Object.entries(staticTokens).map(([n, v]) => [`--${n}`, normalize(v)]),
    );
    expect(pick(genLight, Object.keys(ts))).toEqual(ts);
  });

  it('exposes typed var() helpers', () => {
    expect(cssVar('color-accent')).toBe('var(--color-accent)');
    expect(cssVar('heatmap-dot')).toBe('var(--heatmap-dot)');
    expect(questionStatusVar('retry')).toBe('var(--question-status-retry)');
  });

  it('exposes breakpoints and media queries derived from the breakpoint tokens', () => {
    expect(breakpoints).toEqual({ md: 768, lg: 1024 });
    expect(mediaQueries).toEqual({
      mobile: '(width < 768px)',
      tabletUp: '(width >= 768px)',
      desktop: '(width >= 1024px)',
    });
  });
});

describe('typography scale (design-system.md §4)', () => {
  const px = (name: keyof typeof staticTokens) => Number.parseFloat(staticTokens[name]);
  const num = (name: keyof typeof staticTokens) => Number(staticTokens[name]);

  it('sizes fall in the §4 ranges', () => {
    for (const name of ['font-size-label-sm', 'font-size-label'] as const) {
      expect(px(name), name).toBeGreaterThanOrEqual(12);
      expect(px(name), name).toBeLessThanOrEqual(13);
    }
    for (const name of ['font-size-body', 'font-size-body-lg'] as const) {
      expect(px(name), name).toBeGreaterThanOrEqual(14);
      expect(px(name), name).toBeLessThanOrEqual(16);
    }
    expect(px('font-size-section-title')).toBeGreaterThanOrEqual(16);
    expect(px('font-size-section-title')).toBeLessThanOrEqual(18);
    expect(px('font-size-page-title')).toBeGreaterThanOrEqual(24);
    expect(px('font-size-page-title')).toBeLessThanOrEqual(28);
  });

  it('long text is 16px/1.6, page title 1.2, titles 600', () => {
    expect(px('font-size-body-lg')).toBe(16);
    expect(num('line-height-relaxed')).toBeGreaterThanOrEqual(1.6);
    expect(num('line-height-tight')).toBe(1.2);
    expect(num('font-weight-semibold')).toBe(600);
  });
});

describe('density (design-system.md §4, v1.2.2)', () => {
  const px = (name: keyof typeof staticTokens) => Number.parseFloat(staticTokens[name]);

  it('control heights keep the WCAG 2.2 24px target size and step sm < md', () => {
    expect(px('control-height-sm')).toBeGreaterThanOrEqual(24);
    expect(px('control-height-md')).toBeGreaterThan(px('control-height-sm'));
    expect(px('app-header-height')).toBeGreaterThan(px('control-height-md'));
  });

  it('heatmap cells keep their spec sizes (not part of the density change)', () => {
    expect(staticTokens['heatmap-cell']).toBe('28px');
    expect(staticTokens['heatmap-cell-touch']).toBe('32px');
    expect(staticTokens['heatmap-dot']).toBe('16px');
    expect(staticTokens['heatmap-gap']).toBe('4px');
  });
});

describe('build-tokens', () => {
  it('committed generated files are reproducible from tokens.json', async () => {
    const files = await generate(loadTokenSource());
    expect(files.map((f) => f.path).sort()).toEqual([CSS_PATH, TS_PATH].sort());
    expect(findStale(files)).toEqual([]);
  });

  it('is deterministic', async () => {
    const source = loadTokenSource();
    expect(await generate(source)).toEqual(await generate(source));
  });

  it('rejects a themed token missing a theme', () => {
    expect(() =>
      parseTokenSource({ themed: { 'color-x': { light: '#000' } }, static: {} }),
    ).toThrow(/color-x\.dark/);
  });

  it('rejects invalid and duplicate names and unsafe values', () => {
    expect(() => parseTokenSource({ themed: {}, static: { Bad_Name: '1px' } })).toThrow(/invalid/);
    expect(() =>
      parseTokenSource({
        themed: { 'space-1': { light: '1px', dark: '1px' } },
        static: { 'space-1': '4px' },
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      parseTokenSource({ themed: {}, static: { 'space-1': '4px; color: red' } }),
    ).toThrow(/space-1/);
  });
});

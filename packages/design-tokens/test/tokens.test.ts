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
    // + 4 v1.2.2 switch track colors (track, track-hover, track-border, track-checked-border)
    // + PALETTE-UNIFY 5 fill tokens (danger/success/warning/neutral/neutral-subtle)
    // + UX9-HL-UI 3 highlight backgrounds and the search match background/border
    // + UX12 VIEW-2 2 option control borders + UX12 DESIGN-4 glass-gradient (themed, not a color).
    expect(Object.keys(docLight)).toHaveLength(45);
    expect(Object.keys(docDark)).toHaveLength(45);
    // 39 colors + 25 font/space/radius/glass/shadow/control/layout/heatmap vars + 13 typography
    // + 2 breakpoints + color-scheme + v1.2.7 outline-panel-width + UX12 DESIGN-4 glass-gradient.
    expect(Object.keys(docRoot)).toHaveLength(83);
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

  // HEATMAP-PALETTE (2026-11-04): the light palette is the user's exact choice.
  it('light question status tokens are the HEATMAP-PALETTE values', () => {
    expect(themedTokens.light['question-status-incorrect']).toBe('#FF6060');
    expect(themedTokens.light['question-status-correct']).toBe('#00AB7B');
    expect(themedTokens.light['question-status-retry']).toBe('#F6CF35');
    expect(themedTokens.light['question-status-viewed']).toBe('#ACB6C2');
    expect(themedTokens.light['question-status-unseen']).toBe('#E7ECF0');
  });

  it.each(['light', 'dark'] as const)(
    'PALETTE-UNIFY fill tokens equal the palette in %s',
    (theme) => {
      const t = themedTokens[theme];
      expect(t['color-danger-fill']).toBe(t['question-status-incorrect']);
      expect(t['color-success-fill']).toBe(t['question-status-correct']);
      expect(t['color-warning-fill']).toBe(t['question-status-retry']);
      expect(t['color-neutral-fill']).toBe(t['question-status-viewed']);
      expect(t['color-neutral-fill-subtle']).toBe(t['question-status-unseen']);
      // UX12 VIEW-2: aliases, because --question-status-* is marker-only.
      expect(t['color-option-control']).toBe(t['question-status-viewed']);
      expect(t['color-option-control-hover']).toBe(t['color-border-strong']);
    },
  );

  it.each(['light', 'dark'] as const)('every question status token exists in %s', (theme) => {
    const decls = theme === 'light' ? genLight : genDark;
    expect(questionStatuses).toEqual(EXPECTED_STATUSES);
    for (const token of STATUS_TOKENS) expect(decls[token], token).toMatch(/^#[0-9a-f]{6}$/);
  });
});

// UX12 DESIGN-4: Playwright cannot emulate prefers-reduced-transparency, so the rule is read here.
describe('glass-surface base styles', () => {
  const base = readFileSync(resolve(import.meta.dirname, '../src/base.css'), 'utf8');

  it('layers the gradient over the glass color', () => {
    const decls = base.slice(base.indexOf('.glass-surface {'));
    expect(decls.slice(0, decls.indexOf('}'))).toMatch(
      /background-color: var\(--color-glass\);\s+background-image: var\(--glass-gradient\);/,
    );
  });

  it.each(['@media (prefers-reduced-transparency: reduce)', '@supports not'])(
    '%s falls back to the flat solid color (the shorthand drops the gradient)',
    (rule) => {
      const block = base.slice(base.indexOf(rule));
      expect(block.slice(0, block.indexOf('}'))).toContain('background: var(--color-glass-solid);');
    },
  );
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
    expect(breakpoints).toEqual({ md: 768, lg: 1024, pairedPanel: 868 });
    expect(mediaQueries).toEqual({
      mobile: '(width < 768px)',
      tabletUp: '(width >= 768px)',
      desktop: '(width >= 1024px)',
      pairedSheet: '(width < 868px)',
    });
  });

  it('the paired-dialog breakpoint fits panel + gaps + dialog minimum (design-system §5.6)', () => {
    const px = (name: keyof typeof staticTokens) => Number.parseInt(staticTokens[name], 10);
    // panel + right margin 16 + gap 16 + dialog minimum + left margin 16
    expect(breakpoints.pairedPanel).toBe(
      px('floating-panel-width') + 3 * 16 + px('paired-dialog-min-width'),
    );
  });
});

describe('typography scale (design-system.md §4)', () => {
  const px = (name: keyof typeof staticTokens) => Number.parseFloat(staticTokens[name]);
  const num = (name: keyof typeof staticTokens) => Number(staticTokens[name]);

  it('sizes fall in the §4 ranges', () => {
    expect(px('font-size-label-xs')).toBe(11);
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

  it('button rows are compact (UX12-CONTROLS)', () => {
    expect(staticTokens['control-gap']).toBe('var(--space-1)');
    expect(px('space-1')).toBe(4);
  });

  it('heatmap cells keep their spec sizes (not part of the density change)', () => {
    expect(staticTokens['heatmap-cell']).toBe('28px'); // UX12-HOME-1: 24px → 28px (user request)
    expect(staticTokens['heatmap-cell-touch']).toBe('24px'); // UX9-STROKE: 32px → 24px (user request)
    expect(staticTokens['heatmap-dot']).toBe('16px');
    expect(staticTokens['heatmap-gap']).toBe('0px');
    expect(staticTokens['heatmap-marker-hover-scale']).toBe('1.3'); // UX12 D-12: was 1.18
  });

  it('heatmap markers sit at most 1/3 of their drawn width apart (UX5-UI)', () => {
    // A heatmap marker's SVG box is the cell; the drawn square is 18/24 of the viewBox.
    const drawn = (cell: number) => (cell * 18) / 24;
    for (const cell of [px('heatmap-cell'), px('heatmap-cell-touch')]) {
      const pitch = cell + px('heatmap-gap');
      expect(pitch - drawn(cell)).toBeLessThanOrEqual(drawn(cell) / 3);
      expect(cell).toBeGreaterThanOrEqual(24);
    }
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

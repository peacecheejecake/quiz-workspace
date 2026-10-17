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
  cssVar,
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
    expect(Object.keys(docLight)).toHaveLength(15);
    expect(Object.keys(docDark)).toHaveLength(15);
    // 15 colors + 23 font/space/radius/glass/shadow/layout/heatmap vars + color-scheme.
    expect(Object.keys(docRoot)).toHaveLength(39);
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

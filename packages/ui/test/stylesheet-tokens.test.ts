import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { breakpoints, staticTokens, themedTokens } from '@quiz/design-tokens';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../src');

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

const sheets = stylesheets(SRC).map((file) => ({
  name: relative(SRC, file),
  css: readFileSync(file, 'utf8'),
}));

const TOKENS = new Set([...Object.keys(themedTokens.light), ...Object.keys(staticTokens)]);
const KIT_VARS = new Set(
  sheets.flatMap(({ css }) => [...css.matchAll(/(--qz-[a-z0-9-]+)\s*:/g)].map((m) => m[1])),
);

describe('kit stylesheets use design tokens', () => {
  it('finds the stylesheets (guards against a vacuous scan)', () => {
    expect(sheets.map((s) => s.name)).toEqual(
      expect.arrayContaining(['styles/controls.css', 'styles/layout.css', 'styles/overlays.css']),
    );
  });

  it.each(sheets.map((s) => [s.name, s.css]))(
    '%s: width media queries use only the breakpoint tokens',
    (_name, css) => {
      const allowed = Object.values(breakpoints);
      for (const [query] of css.matchAll(/@media[^{]*/g)) {
        for (const [, px] of query.matchAll(/width\s*(?:[<>]=?|:)\s*(\d+(?:\.\d+)?)px/g)) {
          expect(allowed, query).toContain(Number(px));
        }
        // Range syntax only, so the literal is exactly the token value (no 767px off-by-one).
        expect(query, query).not.toMatch(/\b(?:min|max)-width\b/);
      }
    },
  );

  it.each(sheets.map((s) => [s.name, s.css]))(
    '%s: every var() is a design token, a --qz-* kit var or a Radix var',
    (_name, css) => {
      for (const [, name = ''] of css.matchAll(/var\(--([a-z0-9-]+)/g)) {
        const known = TOKENS.has(name) || KIT_VARS.has(`--${name}`) || name.startsWith('radix-');
        expect(known, `--${name}`).toBe(true);
      }
    },
  );

  it.each(sheets.map((s) => [s.name, s.css]))(
    '%s: no color aliases and no literal font sizes or weights',
    (_name, css) => {
      expect(css).not.toMatch(/--qz-(?:color|scrim)/);
      expect(css).not.toMatch(/font-size:\s*\d/);
      expect(css).not.toMatch(/font-weight:\s*\d/);
    },
  );
});

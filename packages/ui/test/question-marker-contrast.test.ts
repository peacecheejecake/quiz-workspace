// HEATMAP-PALETTE: markers have no border, so the status fill is the only visual cue. Light
// unseen/viewed/retry fills are under 3:1 against the surface by the user's palette choice; the
// meaning is always also given as text (label, filter, tooltip). This test pins that no outline
// comes back, and that fills stay distinguishable from each other and the surface.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { questionStatuses, staticTokens, themeNames, themedTokens } from '@quiz/design-tokens';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(resolve(import.meta.dirname, '../src/styles/questions.css'), 'utf8');
const TSX = readFileSync(
  resolve(import.meta.dirname, '../src/questions/QuestionMarker.tsx'),
  'utf8',
);

function channels(hex: string): number[] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`expected #RRGGBB, got ${hex}`);
  return m.slice(1).map((h) => Number.parseInt(h, 16));
}

function luminance(c: number[]): number {
  const [r = 0, g = 0, b = 0] = c.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: number[], b: number[]): number {
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('question marker has no border (HEATMAP-PALETTE)', () => {
  it('questions.css draws no stroke on the square or a mixed outline color', () => {
    expect(CSS).not.toMatch(/heatmap-marker-stroke-mix/);
    expect(CSS).not.toMatch(/color-mix\([^)]*currentColor/);
    // Only the star may set stroke properties, and then only its width (color stays currentColor).
    const rules = [...CSS.matchAll(/\.qz-question-marker[^{]*>\s*\.shape\s*\{([^}]*)\}/g)];
    for (const [, body = ''] of rules) expect(body).not.toMatch(/(^|[\s;])stroke:/);
    expect(CSS).toMatch(/\[data-shape='star'\]\s*>\s*\.shape/);
  });

  it('the square rect has no stroke and the star stroke is the fill color', () => {
    expect(/<rect[^>]*stroke/.test(TSX)).toBe(false);
    expect(TSX).toMatch(/stroke="currentColor"/);
    expect(staticTokens['heatmap-marker-stroke-width']).toBe('0.5px');
    expect(Object.keys(themedTokens.light)).not.toContain('heatmap-marker-stroke-mix');
  });

  it.each(themeNames)(
    '%s: every status fill differs from the surface and from the others',
    (theme) => {
      const t = themedTokens[theme] as Record<string, string>;
      const surface = channels(t['color-surface'] ?? '');
      const fills = questionStatuses.map((s) => channels(t[`question-status-${s}`] ?? ''));
      for (const fill of fills) expect(contrast(fill, surface)).toBeGreaterThanOrEqual(1.1);
      for (const [i, a] of fills.entries())
        for (const b of fills.slice(i + 1)) expect(contrast(a, b)).toBeGreaterThan(1);
    },
  );
});

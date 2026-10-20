// SC 1.4.11 for heatmap markers: the light unseen/retry fills are < 3:1 against the surface
// (P0.3b), so the marker outline must reach 3:1 on every background the heatmap sits on.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { questionStatuses, themeNames, themedTokens } from '@quiz/design-tokens';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(resolve(import.meta.dirname, '../src/styles/questions.css'), 'utf8');
const OUTLINE =
  /\.qz-question-marker > \.shape\s*\{[^}]*stroke:\s*color-mix\(in srgb, currentColor (\d+)%, var\(--(color-[a-z-]+)\)\)/;

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

/** `color-mix(in srgb, a p%, b)` on 8-bit channels. */
function mix(a: number[], b: number[], p: number): number[] {
  return a.map((v, i) => Math.round(v * p + (b[i] ?? 0) * (1 - p)));
}

const [, percent = '0', mixWith = ''] = OUTLINE.exec(CSS) ?? [];
const BACKGROUNDS = ['color-surface', 'color-canvas', 'color-surface-muted'] as const;

describe('question marker outline contrast', () => {
  it('questions.css declares the outline as a color-mix of the status color', () => {
    expect(mixWith).toBe('color-text-primary');
    expect(Number(percent)).toBeGreaterThan(0);
  });

  const cases = themeNames.flatMap((theme) =>
    questionStatuses.flatMap((status) => BACKGROUNDS.map((bg) => [theme, status, bg] as const)),
  );

  it.each(cases)('%s %s outline vs %s ≥ 3:1', (theme, status, bg) => {
    const t = themedTokens[theme] as Record<string, string>;
    const fill = channels(t[`question-status-${status}`] ?? '');
    const outline = mix(fill, channels(t[mixWith] ?? ''), Number(percent) / 100);
    expect(contrast(outline, channels(t[bg] ?? ''))).toBeGreaterThanOrEqual(3);
  });
});

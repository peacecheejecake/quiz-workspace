// WCAG 2.2 contrast checks computed from the token values (SC 1.4.3 text, SC 1.4.11 non-text).
import { describe, expect, it } from 'vitest';
import { themeNames, themedTokens, type ThemeName, type ThemedTokenName } from '../src/index.ts';

const TEXT_MIN = 4.5;
const NON_TEXT_MIN = 3;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an opaque #RRGGBB color. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`contrast needs an opaque #RRGGBB color, got "${hex}"`);
  const [r, g, b] = m.slice(1).map((h) => channel(Number.parseInt(h, 16)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const ratio = (theme: ThemeName, fg: ThemedTokenName, bg: ThemedTokenName) =>
  contrastRatio(themedTokens[theme][fg], themedTokens[theme][bg]);

type Pair = [fg: ThemedTokenName, bg: ThemedTokenName, min: number];

const BACKGROUNDS = ['color-surface', 'color-canvas'] as const;
const TEXT_TOKENS = [
  'color-text-primary',
  'color-text-secondary',
  'color-accent',
  'color-danger',
  'color-success',
  'color-warning',
] as const;
const NON_TEXT_TOKENS = ['color-border-strong', 'color-focus'] as const;

const REQUIRED: Pair[] = [
  ...TEXT_TOKENS.flatMap((fg) => BACKGROUNDS.map((bg): Pair => [fg, bg, TEXT_MIN])),
  ['color-on-accent', 'color-accent', TEXT_MIN],
  // Primary (accent-filled) buttons keep their label readable on hover and while pressed (UX2).
  ['color-on-accent', 'color-accent-hover', TEXT_MIN],
  ['color-on-accent', 'color-accent-pressed', TEXT_MIN],
  // Secondary text also labels current/selected rows and metadata on muted surfaces (M7.2 axe).
  ['color-text-secondary', 'color-surface-muted', TEXT_MIN],
  ['color-text-primary', 'color-surface-muted', TEXT_MIN],
  // Interaction state backgrounds (design-system.md §4.1): labels stay readable on every state;
  // secondary text (nav links, menu metadata) also sits on the hover background.
  ['color-text-primary', 'color-state-hover', TEXT_MIN],
  ['color-text-primary', 'color-state-pressed', TEXT_MIN],
  ['color-text-primary', 'color-state-selected', TEXT_MIN],
  ['color-text-secondary', 'color-state-hover', TEXT_MIN],
  ['color-text-primary', 'color-state-selected-hover', TEXT_MIN],
  // Glass fallback surface (reduced transparency) carries the same text as glass.
  ['color-text-primary', 'color-glass-solid', TEXT_MIN],
  ['color-text-secondary', 'color-glass-solid', TEXT_MIN],
  ['color-focus', 'color-state-selected', NON_TEXT_MIN],
  // Switch (v1.2.2): the unchecked fill is the control boundary on every surface it sits on;
  // the thumb (on-accent) stands out from the fill in both states and on hover.
  ...(['color-surface', 'color-canvas', 'color-surface-muted', 'color-glass-solid'] as const).map(
    (bg): Pair => ['color-switch-track', bg, NON_TEXT_MIN],
  ),
  ['color-on-accent', 'color-switch-track', NON_TEXT_MIN],
  ['color-on-accent', 'color-switch-track-hover', NON_TEXT_MIN],
  // Tooltip: inverted text.
  ['color-canvas', 'color-text-primary', TEXT_MIN],
  ...NON_TEXT_TOKENS.flatMap((fg) => BACKGROUNDS.map((bg): Pair => [fg, bg, NON_TEXT_MIN])),
];

// Reported, not enforced: status markers are non-text and rely on an outline + legend
// (design-system.md §3.1).
const REPORTED: Pair[] = [
  ...(['unseen', 'viewed', 'incorrect', 'correct', 'retry'] as const).flatMap((s) =>
    BACKGROUNDS.map((bg): Pair => [`question-status-${s}`, bg, NON_TEXT_MIN]),
  ),
];

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBe(1);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });

  it('rejects non-opaque values instead of guessing', () => {
    expect(() => luminance('rgba(0, 0, 0, 0.5)')).toThrow(/opaque/);
  });
});

describe.each(themeNames)('%s theme contrast', (theme) => {
  it.each(REQUIRED)('%s on %s ≥ %s:1', (fg, bg, min) => {
    expect(ratio(theme, fg, bg)).toBeGreaterThanOrEqual(min);
  });

  // Hover must read as a change from rest and stay distinct from pressed and selected
  // (design-system.md §4.1): the accent fill steps by a visible luminance ratio, and the four
  // neutral/selected state backgrounds are pairwise different.
  it('accent hover and pressed fills step visibly away from the accent and each other', () => {
    const MIN_STEP = 1.08;
    expect(ratio(theme, 'color-accent-hover', 'color-accent')).toBeGreaterThanOrEqual(MIN_STEP);
    expect(ratio(theme, 'color-accent-pressed', 'color-accent')).toBeGreaterThanOrEqual(MIN_STEP);
    expect(ratio(theme, 'color-accent-pressed', 'color-accent-hover')).toBeGreaterThanOrEqual(
      MIN_STEP,
    );
  });

  it('hover, pressed, selected and selected-hover backgrounds are all different', () => {
    const t = themedTokens[theme];
    const values = [
      t['color-state-hover'],
      t['color-state-pressed'],
      t['color-state-selected'],
      t['color-state-selected-hover'],
    ].map((v) => v.toLowerCase());
    expect(new Set(values).size).toBe(values.length);
  });

  // UX3b: the switch track border is a lighter rim than the fill it surrounds, unchecked
  // (rest and hover) and checked (accent rest and hover).
  it('switch track borders are lighter than the track fill in every state', () => {
    const t = themedTokens[theme];
    const lum = (name: ThemedTokenName) => luminance(t[name]);
    expect(lum('color-switch-track-border')).toBeGreaterThan(lum('color-switch-track'));
    expect(lum('color-switch-track-border')).toBeGreaterThan(lum('color-switch-track-hover'));
    expect(lum('color-switch-track-checked-border')).toBeGreaterThan(lum('color-accent'));
    expect(lum('color-switch-track-checked-border')).toBeGreaterThan(lum('color-accent-hover'));
    expect(ratio(theme, 'color-switch-track-hover', 'color-switch-track')).toBeGreaterThanOrEqual(
      1.08,
    );
  });

  it('feedback colors are distinct from question status colors', () => {
    const t = themedTokens[theme];
    const statuses = [
      t['question-status-incorrect'],
      t['question-status-correct'],
      t['question-status-retry'],
    ].map((v) => v.toLowerCase());
    for (const name of ['color-danger', 'color-success', 'color-warning'] as const) {
      expect(statuses, name).not.toContain(t[name].toLowerCase());
    }
  });

  it('reports advisory pairs (status markers, muted surface)', () => {
    const rows = REPORTED.map(([fg, bg, min]) => {
      const value = ratio(theme, fg, bg);
      return { fg, bg, ratio: Number(value.toFixed(2)), meets: value >= min ? 'yes' : 'NO' };
    });
    console.info(`[contrast:${theme}] advisory pairs (not enforced)`);
    console.table(rows);
    expect(rows).toHaveLength(REPORTED.length);
  });
});

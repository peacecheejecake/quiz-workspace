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

const toHex = (c: number[]) =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Source-over compositing of `top` at `alpha` on the opaque `bottom`. */
const over = (top: number[], alpha: number, bottom: number[]) =>
  top.map((c, i) => c * alpha + (bottom[i] ?? 0) * (1 - alpha));

const channels = (hex: string) =>
  [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));

/** The stops of `--glass-gradient` as `[r, g, b, alpha]`. */
function gradientStops(theme: ThemeName): [number, number, number, number][] {
  const value = themedTokens[theme]['glass-gradient'];
  return [...value.matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/g)].map(
    (m) => m.slice(1).map(Number) as [number, number, number, number],
  );
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
const HIGHLIGHT_BACKGROUNDS = [
  'color-highlight-yellow',
  'color-highlight-blue',
  'color-highlight-pink',
  'color-search-match-bg',
] as const;

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
  // UX7-QDISPLAY: graded MCQ option borders (QPLAY-01-AC12) — chosen correct success, wrong
  // choice border-strong, correct option danger — on every surface the practice panel sits on.
  ...(['color-success', 'color-border-strong', 'color-danger'] as const).flatMap((fg) =>
    (['color-surface', 'color-canvas', 'color-surface-muted', 'color-glass-solid'] as const).map(
      (bg): Pair => [fg, bg, NON_TEXT_MIN],
    ),
  ),
  // UX9-HL-UI (design-system §5.2): body text stays AA on every highlight color and on the search
  // match background (marks set the primary text color), and the search match border stands out
  // from every surface the note panel uses and from the highlight it may sit on.
  ...HIGHLIGHT_BACKGROUNDS.map((bg): Pair => ['color-text-primary', bg, TEXT_MIN]),
  ...(
    [
      'color-surface',
      'color-canvas',
      'color-surface-muted',
      'color-glass-solid',
      ...HIGHLIGHT_BACKGROUNDS,
    ] as const
  ).map((bg): Pair => ['color-search-match', bg, NON_TEXT_MIN]),
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

  // UX-GLASS (2026-11-01): floating glass is near-opaque so the layer below barely shows. The
  // glass tint matches its solid fallback, and text stays AA even over a pure black or white
  // backdrop (the translucent color composited over the worst case, blur ignored).
  it('glass is near-opaque, tinted like its solid fallback, and keeps text AA over any backdrop', () => {
    const t = themedTokens[theme];
    const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(t['color-glass']);
    if (!m) throw new Error(`color-glass must be rgba(), got "${t['color-glass']}"`);
    const [r, g, b, a] = m.slice(1).map(Number) as [number, number, number, number];
    expect(a).toBeGreaterThanOrEqual(0.97);
    const hex = (c: number[]) =>
      `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    expect(hex([r, g, b]).toLowerCase()).toBe(t['color-glass-solid'].toLowerCase());
    for (const backdrop of [0, 255]) {
      const composite = hex([r, g, b].map((c) => c * a + backdrop * (1 - a)));
      for (const fg of ['color-text-primary', 'color-text-secondary'] as const) {
        expect(contrastRatio(t[fg], composite), `${fg} over ${backdrop}`).toBeGreaterThanOrEqual(
          TEXT_MIN,
        );
      }
    }
  });

  // UX12 DESIGN-4 (D-3): a blue-to-lavender tint over the glass color. Every pair the plain glass
  // keeps also holds on both stops, rounded to 8 bits as the browser paints them.
  describe('glass gradient', () => {
    const t = themedTokens[theme];
    const solid = channels(t['color-glass-solid']);
    const painted = (backdrop: number[]) =>
      gradientStops(theme).map(([r, g, b, a]) => toHex(over([r, g, b], a, backdrop)));

    it('runs from a blue stop to a lavender stop at a capped alpha', () => {
      const stops = gradientStops(theme);
      expect(stops).toHaveLength(2);
      const [blue, lavender] = stops;
      if (!blue || !lavender) throw new Error('glass-gradient needs two stops');
      expect(blue[0], 'blue stop: green over red').toBeLessThan(blue[1]);
      expect(lavender[0], 'lavender stop: red over green').toBeGreaterThan(lavender[1]);
      for (const stop of stops) {
        expect(stop[2], 'cool: blue is the strongest channel').toBeGreaterThan(stop[1]);
        expect(stop[3]).toBeLessThanOrEqual(0.35);
      }
    });

    it.each(TEXT_TOKENS)('%s stays AA on both stops', (fg) => {
      for (const bg of painted(solid)) {
        expect(contrastRatio(t[fg], bg), bg).toBeGreaterThanOrEqual(TEXT_MIN);
      }
    });

    it('body text stays AA on both stops over any backdrop', () => {
      const m = /([\d.]+)\)$/.exec(t['color-glass']);
      const alpha = Number(m?.[1]);
      for (const backdrop of [0, 255]) {
        const glass = over(solid, alpha, [backdrop, backdrop, backdrop]);
        for (const bg of painted(glass)) {
          for (const fg of ['color-text-primary', 'color-text-secondary'] as const) {
            expect(contrastRatio(t[fg], bg), `${fg} over ${backdrop}`).toBeGreaterThanOrEqual(
              TEXT_MIN,
            );
          }
        }
      }
    });

    it.each([
      'color-switch-track',
      'color-border-strong',
      'color-success',
      'color-danger',
    ] as const)('%s keeps 3:1 on both stops', (fg) => {
      for (const bg of painted(solid)) {
        expect(contrastRatio(t[fg], bg), bg).toBeGreaterThanOrEqual(NON_TEXT_MIN);
      }
    });

    it('the hover background stands out from both stops', () => {
      for (const bg of painted(solid)) {
        expect(contrastRatio(t['color-state-hover'], bg), bg).toBeGreaterThanOrEqual(1.1);
      }
    });
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

  // UX12-CONTROLS: hover is the only affordance of a borderless button, also on glass panels.
  it('the hover background stands out from the glass surface', () => {
    expect(ratio(theme, 'color-state-hover', 'color-glass-solid')).toBeGreaterThanOrEqual(1.13);
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

  // design-system §5.2: highlight and search colors never reuse the question status colors, the
  // three highlight colors differ, and the search border is not the focus ring color.
  it('highlight and search colors are their own', () => {
    const t = themedTokens[theme];
    const own = [...HIGHLIGHT_BACKGROUNDS, 'color-search-match'] as const;
    const values = own.map((name) => t[name].toLowerCase());
    expect(new Set(values).size).toBe(values.length);
    const statuses = (['unseen', 'viewed', 'incorrect', 'correct', 'retry'] as const).map((s) =>
      t[`question-status-${s}`].toLowerCase(),
    );
    for (const value of values) expect(statuses).not.toContain(value);
    expect(t['color-search-match'].toLowerCase()).not.toBe(t['color-focus'].toLowerCase());
  });

  // PALETTE-UNIFY: dark text tokens are the palette dark values; only light text is a darker hue.
  it('light feedback text colors are darker than the palette fills', () => {
    if (theme !== 'light') return;
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

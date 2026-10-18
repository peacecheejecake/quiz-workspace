import { staticTokens, themedTokens } from '../generated/tokens.ts';

export { staticTokens, themedTokens };

export type ThemeName = keyof typeof themedTokens;
export const themeNames = Object.keys(themedTokens) as ThemeName[];

export type ThemedTokenName = keyof (typeof themedTokens)['light'];
export type StaticTokenName = keyof typeof staticTokens;
export type TokenName = ThemedTokenName | StaticTokenName;

/** `var(--name)` reference for a token; prefer this over raw values in feature code. */
export function cssVar<N extends TokenName>(name: N): `var(--${N})` {
  return `var(--${name})`;
}

/** Question learning states rendered by the heatmap (docs/design-system.md §6). */
export const questionStatuses = ['unseen', 'viewed', 'incorrect', 'correct', 'retry'] as const;
export type QuestionStatus = (typeof questionStatuses)[number];

export function questionStatusVar<S extends QuestionStatus>(
  status: S,
): `var(--question-status-${S})` {
  return cssVar(`question-status-${status}`);
}

/**
 * Layout breakpoints in px (docs/design-system.md §4): mobile < md, tablet md..lg-1, desktop ≥ lg.
 * CSS custom properties cannot be used inside media queries, so stylesheets write the same px
 * literal with range syntax (`@media (width >= 768px)`); a @quiz/ui test pins those literals to
 * these values. Use `mediaQueries` with `matchMedia` in TS.
 */
export const breakpoints = {
  md: Number.parseInt(staticTokens['breakpoint-md'], 10),
  lg: Number.parseInt(staticTokens['breakpoint-lg'], 10),
} as const;
export type BreakpointName = keyof typeof breakpoints;

export const mediaQueries = {
  mobile: `(width < ${breakpoints.md}px)`,
  tabletUp: `(width >= ${breakpoints.md}px)`,
  desktop: `(width >= ${breakpoints.lg}px)`,
} as const;

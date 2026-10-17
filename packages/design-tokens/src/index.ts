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

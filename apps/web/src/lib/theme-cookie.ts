// The `quiz-theme` cookie (UX12-SETTINGS-AC02, AC03). A plain module: RootLayout reads it on the
// server and AppThemeProvider writes it in the browser. No cookie means `system`.
import type { ThemePreference } from '@quiz/ui';

export const THEME_COOKIE = 'quiz-theme';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Anything but a known pick (a missing or tampered cookie) follows the system. */
export function parseThemePreference(value: string | undefined): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** The `document.cookie` assignment for a preference; `system` deletes the cookie. */
export function themeCookieString(theme: ThemePreference, secure: boolean): string {
  const value = theme === 'system' ? '' : theme;
  const maxAge = theme === 'system' ? 0 : ONE_YEAR_SECONDS;
  const flags = `Path=/; Max-Age=${maxAge}; SameSite=Lax${secure ? '; Secure' : ''}`;
  return `${THEME_COOKIE}=${value}; ${flags}`;
}

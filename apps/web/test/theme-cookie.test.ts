import { describe, expect, it } from 'vitest';
import { parseThemePreference, themeCookieString } from '../src/lib/theme-cookie';

describe('quiz-theme cookie', () => {
  it('accepts only the two picks and treats anything else as system', () => {
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('dark')).toBe('dark');
    for (const value of [undefined, '', 'system', 'neon', 'DARK', 'dark"><script>']) {
      expect(parseThemePreference(value)).toBe('system');
    }
  });

  it('writes a site-wide, SameSite=Lax cookie that is Secure on https', () => {
    expect(themeCookieString('dark', false)).toBe(
      'quiz-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax',
    );
    expect(themeCookieString('light', true)).toBe(
      'quiz-theme=light; Path=/; Max-Age=31536000; SameSite=Lax; Secure',
    );
  });

  it('deletes the cookie for system', () => {
    expect(themeCookieString('system', false)).toBe('quiz-theme=; Path=/; Max-Age=0; SameSite=Lax');
  });
});

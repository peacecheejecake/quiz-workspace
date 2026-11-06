'use client';

// ThemeProvider controlled by the `quiz-theme` cookie RootLayout read for this request.
import { ThemeProvider, type ThemePreference } from '@quiz/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { themeCookieString } from '@/lib/theme-cookie';

export function AppThemeProvider({
  initialTheme,
  children,
}: {
  initialTheme: ThemePreference;
  children: ReactNode;
}) {
  const [theme, setTheme] = useState(initialTheme);

  // Also runs on load: Safari caps script-written cookies at seven days, so each visit renews it.
  useEffect(() => {
    document.cookie = themeCookieString(theme, window.location.protocol === 'https:');
  }, [theme]);

  return (
    <ThemeProvider theme={theme} onThemeChange={setTheme} omitSystemAttribute>
      {children}
    </ThemeProvider>
  );
}

import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { AppThemeProvider } from '@/components/app-shell/app-theme-provider';
import { PracticeReturnProvider } from '@/components/practice-return/practice-return-provider';
import { getVerifiedUser } from '@/lib/supabase/server';
import { parseThemePreference, THEME_COOKIE } from '@/lib/theme-cookie';
import '@quiz/ui/styles.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Quiz Workspace', template: '%s · Quiz Workspace' },
  description: 'PDF 기반 학습 자료 검색과 문제 풀이 Workspace',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // Every page renders per request: the CSP nonce from `proxy.ts` must be stamped on Next's
  // scripts, which a build-time (static) page cannot carry.
  await connection();
  const user = await getVerifiedUser();
  const theme = parseThemePreference((await cookies()).get(THEME_COOKIE)?.value);
  // Stamped here, in the first byte of HTML: a picked theme never flashes, and no inline script
  // needs the CSP nonce. Without a pick the tokens' media query decides.
  return (
    <html lang="ko" data-theme={theme === 'system' ? undefined : theme}>
      <body>
        <AppThemeProvider initialTheme={theme}>
          <PracticeReturnProvider userId={user?.id ?? null}>{children}</PracticeReturnProvider>
        </AppThemeProvider>
      </body>
    </html>
  );
}

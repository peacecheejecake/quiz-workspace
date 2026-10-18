import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
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
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

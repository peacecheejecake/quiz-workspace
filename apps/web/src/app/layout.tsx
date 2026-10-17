import type { Metadata, Viewport } from 'next';
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

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

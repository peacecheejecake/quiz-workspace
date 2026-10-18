import '@quiz/ui/styles.css';

export const metadata = { title: '@quiz/ui RSC fixture' };

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

// Placeholder for the legal documents linked from the sign-up form (docs/auth.md §2: "약관·개인정보
// 처리방침 링크"). The documents themselves are not specified yet; the pages exist so the links
// never lead to a 404. `children` holds draft facts that must already be disclosed (e.g. the
// processors of /privacy, docs/deployment.md §6); the final legal text is the operator's.
import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './stub-screen.module.css';

export function LegalPlaceholder({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.notice}>
        {title} 전문은 정식 서비스 시작 전에 이 페이지에 게시됩니다.{' '}
        <Link href="/signup">회원가입으로 돌아가기</Link>
      </p>
      {children}
    </main>
  );
}

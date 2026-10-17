import type { Metadata } from 'next';
import Link from 'next/link';
import styles from '@/components/stub-screen.module.css';

export const metadata: Metadata = { title: '페이지를 찾을 수 없습니다' };

export default function NotFound() {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>페이지를 찾을 수 없습니다</h1>
      <p className={styles.notice}>
        주소가 올바른지 확인해 주세요. <Link href="/workspaces">Workspace 목록으로 이동</Link>
      </p>
    </main>
  );
}

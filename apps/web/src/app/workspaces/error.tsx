'use client';

// Unexpected failure under /workspaces (API unreachable while checking a workspace, ...). Not
// for missing/foreign workspaces: those render the not-found page with HTTP 404.
import { Button, EmptyState } from '@quiz/ui';
import Link from 'next/link';
import styles from '@/components/stub-screen.module.css';

export default function WorkspacesError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className={styles.main}>
      <div role="alert">
        <EmptyState
          headingLevel={2}
          title="화면을 불러오지 못했습니다"
          description="일시적인 오류일 수 있습니다. 다시 시도하거나 Workspace 홈으로 이동해 주세요."
          action={
            <>
              <Button variant="primary" onClick={reset}>
                다시 시도
              </Button>{' '}
              <Link href="/workspaces">Workspace 홈</Link>
            </>
          }
        />
      </div>
    </main>
  );
}

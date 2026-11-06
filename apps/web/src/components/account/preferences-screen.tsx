'use client';

// UX12-SETTINGS `/settings/preferences`: settings kept in this browser. Rendered inside the
// AppShell, which owns the page's <main>.
import { PageHeader, Surface, Switch } from '@quiz/ui';
import { useAutoCopyEnabled } from '@/components/app-shell/use-auto-copy-on-select';
import { writeAutoCopy } from '@/lib/auto-copy-preference';
import type { ScreenId } from '@/screens';
import styles from './account-security.module.css';

export function PreferencesScreen({ screenId }: { screenId: ScreenId }) {
  const autoCopy = useAutoCopyEnabled();
  return (
    <div className={styles.page} data-screen-id={screenId}>
      <PageHeader title="설정" description="이 브라우저에서 쓰는 기능을 정합니다." />

      <Surface asChild padding="lg">
        <section aria-labelledby="preferences-reading-title" className={styles.section}>
          <h2 id="preferences-reading-title" className={styles.sectionTitle}>
            읽기
          </h2>
          <Switch
            label="드래그하면 자동 복사"
            description="마우스로 글자를 끌어 고르면 바로 복사합니다. 입력란은 제외합니다. 데스크톱 우선 기능이라 터치 화면에서는 동작하지 않습니다. 이 브라우저에만 저장됩니다."
            checked={autoCopy}
            onCheckedChange={writeAutoCopy}
          />
        </section>
      </Surface>
    </div>
  );
}

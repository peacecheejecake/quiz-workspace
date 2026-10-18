'use client';

// WS-SHARE-01 `/workspaces/:workspaceId/settings/sharing` (docs/screens/workspace-sharing.md).
// The page header stays in the main landmark; the settings live in the non-modal
// WorkspaceSharingPanel, portalled into this screen (inside <main>) so it opens with the page.
import { Button, PageHeader } from '@quiz/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ShareLinksLoad } from '@/lib/sharing/data';
import { SHARE_FAILURE_MESSAGES, type ShareLink } from '@/lib/sharing/model';
import styles from './sharing.module.css';
import { WorkspaceSharingPanel } from './workspace-sharing-panel';

export interface SharingScreenProps {
  readonly workspace: { readonly id: string; readonly name: string; readonly archived: boolean };
  readonly load: ShareLinksLoad;
}

export function SharingScreen({ workspace, load }: SharingScreenProps) {
  const router = useRouter();

  return (
    <div className={styles.screen}>
      <PageHeader
        title="공유 설정"
        description={`‘${workspace.name}’ Workspace를 보기 전용 링크로 공유합니다.`}
      />
      {load.status === 'forbidden' ? (
        <p role="alert" className={styles.error}>
          {SHARE_FAILURE_MESSAGES.forbidden}
        </p>
      ) : load.status === 'unavailable' ? (
        <div role="alert" className={styles.error}>
          <p>{SHARE_FAILURE_MESSAGES.unavailable}</p>
          <Button size="sm" onClick={() => router.refresh()}>
            다시 시도
          </Button>
        </div>
      ) : (
        <SharingBody workspace={workspace} links={load.links} />
      )}
    </div>
  );
}

function SharingBody({
  workspace,
  links,
}: {
  readonly workspace: SharingScreenProps['workspace'];
  readonly links: readonly ShareLink[];
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(true);
  const [reopened, setReopened] = useState(false);
  return (
    <>
      <p className={styles.lead}>
        링크를 가진 사람만 로그인 없이 발행된 자료를 볼 수 있습니다. 링크 만들기·철회·재발급과 Fork
        허용, 만료일은 공유 관리 패널에서 바꿉니다.
      </p>
      {open ? null : (
        <div>
          <Button
            variant="primary"
            onClick={() => {
              setReopened(true);
              setOpen(true);
            }}
          >
            공유 관리 열기
          </Button>
        </div>
      )}
      <div ref={setHost} />
      {host ? (
        <WorkspaceSharingPanel
          workspaceId={workspace.id}
          archived={workspace.archived}
          initialLinks={links}
          open={open}
          onOpenChange={setOpen}
          container={host}
          focusOnOpen={reopened}
        />
      ) : null}
    </>
  );
}

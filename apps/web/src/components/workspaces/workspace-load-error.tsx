'use client';

import { Button, EmptyState } from '@quiz/ui';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

/** Shown in place of the list when the API could not be reached; retries in place. */
export function WorkspaceLoadError() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div role="alert">
      <EmptyState
        title="Workspace 목록을 불러오지 못했습니다"
        description="일시적인 오류일 수 있습니다. 잠시 후 다시 시도해 주세요."
        action={
          <Button loading={pending} onClick={() => startTransition(() => router.refresh())}>
            다시 시도
          </Button>
        }
      />
    </div>
  );
}

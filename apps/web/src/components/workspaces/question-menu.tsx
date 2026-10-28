'use client';

import {
  Button,
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@quiz/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * The header's `문제` menu (UX4): 전체 문제 (a link to the QBANK-01 bank, for every member — it
 * replaced the separate 문제은행 button, UX6-PROGRESS), 문제 PDF 관리 dialog, 직접 추가 (the
 * QBANK-01 문제 등록 editor) and 변형 출제 (the 문제 생성 dialog); the last two need edit rights. A dialog opens once the menu
 * has returned focus to its trigger, so closing the dialog brings focus back there.
 */
export function QuestionMenu({
  canEdit,
  bankHref,
  onPdfs,
  onCreate,
  onGenerate,
}: {
  readonly canEdit: boolean;
  /** The bank page (`/workspaces/:id/questions/bank`). */
  readonly bankHref: string;
  readonly onPdfs: () => void;
  readonly onCreate: () => void;
  readonly onGenerate: () => void;
}) {
  const router = useRouter();
  // The bank link sits in a closed menu, out of the viewport, so Link never prefetches it:
  // prefetch it here like the former visible 문제은행 button did, so the route's loading skeleton
  // shows at once (QOV-01-AC09).
  useEffect(() => {
    router.prefetch(bankHref);
  }, [router, bankHref]);
  const afterClose = (action: () => void) => () => window.setTimeout(action, 0);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button>
          문제
          <ChevronDownIcon width={16} height={16} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label="문제">
        <DropdownMenuItem asChild>
          <Link href={bankHref}>전체 문제</Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={afterClose(onPdfs)}>PDF 관리</DropdownMenuItem>
        {canEdit ? (
          <>
            <DropdownMenuItem onSelect={onCreate}>직접 추가</DropdownMenuItem>
            <DropdownMenuItem onSelect={afterClose(onGenerate)}>변형 출제</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

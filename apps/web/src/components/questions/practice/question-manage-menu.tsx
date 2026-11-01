'use client';

// UX7-BANK: the practice panel's `문제 관리` menu for editors of a non-archived workspace
// (docs/screens/questions-practice.md "문제 관리", QPLAY-01-AC07/AC08): 편집 (the 문제 편집 dialog),
// 변형 출제 (the question's review page) and 삭제 (a confirmation first). The API re-checks every
// one of them. Dialogs open once the menu has returned focus to its trigger, so closing them brings
// focus back there.
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  MoreIcon,
} from '@quiz/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { generatePath } from '@/lib/questions/generation-client';

export function QuestionManageMenu({
  workspaceId,
  questionId,
  busy = false,
  onEdit,
  onDelete,
}: {
  readonly workspaceId: string;
  readonly questionId: string;
  /** The question is being loaded for the editor or deleted. */
  readonly busy?: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const router = useRouter();
  const generateHref = generatePath(workspaceId, questionId);
  // The 변형 출제 link sits in a closed menu, so Link never prefetches it: prefetch it here so the
  // route's loading skeleton shows at once (QOV-01-AC09).
  useEffect(() => {
    router.prefetch(generateHref);
  }, [router, generateHref]);
  const afterClose = (action: () => void) => () => window.setTimeout(action, 0);
  return (
    // Non-modal: a modal menu that opens a dialog can leave the page inert.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton
          label="문제 관리"
          icon={<MoreIcon />}
          aria-busy={busy || undefined}
          disabled={busy}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="문제 관리">
        <DropdownMenuItem onSelect={afterClose(onEdit)}>편집</DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={generateHref}>변형 출제</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="danger" onSelect={afterClose(onDelete)}>
          삭제
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

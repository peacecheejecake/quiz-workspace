'use client';

// The practice panel's header menu (docs/screens/questions-practice.md "문제 관리" and "정답·해설·이력
// 보기"). Every member gets the read items 정답·해설 보기 and 수정 이력·출처 (UX7-BANK-2: the 문제
// 상세 dialog, QPLAY-01-AC09/AC10). Editors of a non-archived workspace get them in the `문제 관리`
// menu with 편집 (the 문제 편집 dialog), 변형 출제 (the question's review page), 보관 and 삭제 (both
// confirm first; QPLAY-01-AC07/AC08/AC11); everyone else gets a read-only `문제 정보` menu. The API
// re-checks every write. Dialogs open once the menu has returned focus to its trigger, so closing
// them brings focus back there.
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
import { useEffect, useRef } from 'react';
import { generatePath } from '@/lib/questions/generation-client';
import type { DetailFocus } from '../detail/question-detail-dialog';

export interface QuestionManageActions {
  readonly onEdit: () => void;
  readonly onArchive: () => void;
  readonly onDelete: () => void;
}

export function QuestionManageMenu({
  workspaceId,
  questionId,
  busy = false,
  onShowDetail,
  manage = null,
}: {
  readonly workspaceId: string;
  readonly questionId: string;
  /** The question is being loaded for the editor, archived or deleted. */
  readonly busy?: boolean;
  /** `trigger`: the menu button, where focus goes back when the dialog closes. */
  readonly onShowDetail: (focus: DetailFocus, trigger: HTMLElement | null) => void;
  /** Editors of a non-archived workspace: the write items (null = the read-only 문제 정보 menu). */
  readonly manage?: QuestionManageActions | null;
}) {
  const label = manage ? '문제 관리' : '문제 정보';
  const router = useRouter();
  const generateHref = manage ? generatePath(workspaceId, questionId) : null;
  // The 변형 출제 link sits in a closed menu, so Link never prefetches it: prefetch it here so the
  // route's loading skeleton shows at once (QOV-01-AC09).
  useEffect(() => {
    if (generateHref) router.prefetch(generateHref);
  }, [router, generateHref]);
  const afterClose = (action: () => void) => () => window.setTimeout(action, 0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    // Non-modal: a modal menu that opens a dialog can leave the page inert.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton
          ref={triggerRef}
          label={label}
          icon={<MoreIcon />}
          aria-busy={busy || undefined}
          disabled={busy}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={label}>
        <DropdownMenuItem onSelect={afterClose(() => onShowDetail('answers', triggerRef.current))}>
          정답·해설 보기
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={afterClose(() => onShowDetail('history', triggerRef.current))}>
          수정 이력·출처
        </DropdownMenuItem>
        {manage && generateHref ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={afterClose(manage.onEdit)}>편집</DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={generateHref}>변형 출제</Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={afterClose(manage.onArchive)}>보관</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem tone="danger" onSelect={afterClose(manage.onDelete)}>
              삭제
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

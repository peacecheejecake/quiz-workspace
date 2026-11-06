'use client';

import Link from 'next/link';
import { Fragment, useId, useRef } from 'react';
import { isPlainClick, markSearchEntryFromHome } from '@/components/search/search-entry';
import {
  Button,
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@quiz/ui';
import { DocumentsIcon } from './home-icons';
import styles from './workspace-home.module.css';

/** Why the workspace is read-only for this member, or null when they can edit. */
export type QuestionMenuReadOnly = 'viewer' | 'archived' | null;

const READ_ONLY_REASONS: Readonly<Record<Exclude<QuestionMenuReadOnly, null>, string>> = {
  viewer: '편집 권한이 있어야 사용할 수 있습니다',
  archived: '보관된 Workspace는 읽기 전용입니다',
};

interface QuestionMenuAction {
  readonly key: string;
  readonly label: string;
  /** Editor-only actions stay listed but disabled, with the reason, for everyone else. */
  readonly requiresEdit: boolean;
  /** Starts a new group (a separator above it). */
  readonly separated?: boolean;
  /** Its own reason to be disabled (shown as text under it and describing it), if any. */
  readonly ownReason?: string | null;
  readonly onSelect: () => void;
}

/**
 * The header's `문서 N` menu (UX12-HEADER, D-7): the one menu of the home, grouped 문서 관리 · 본문
 * 검색 | the 문제 items below | 보관·초안 문제. Its trigger is named after the book count, and so is
 * the menu (Radix labels it by its trigger). 문서 관리 and 본문 검색 are for every member; 본문 검색
 * is a real link (SEARCH-02), so a modified click opens a new tab. Before it was this menu, the
 * `문제` menu (UX4): 직접 추가 (the 문제 등록 editor on the home,
 * `?panel=question-create`, UX7-BANK). 변형 출제 and its 문제 생성 dialog were retired with QGEN-01
 * (QGEN-RM; 모의고사 replaces them, MOCK-01-AC01). The 전체 문제 link
 * (UX6-PROGRESS) went with its page (UX7-BANK) and PDF 관리 with the 문제 PDF 관리 dialog, merged
 * into 문서 관리 (UX7-DOCS, DOC-01-AC09). The button is shown to everyone (UX7-DOCS-2,
 * QOV-01-AC11): without edit rights the editor-only items are Radix-disabled (aria-disabled,
 * skipped by the arrow keys) and a text label says why, since a disabled item has no tooltip on
 * touch. A chosen action runs only once the menu has handed focus back to its trigger (in
 * onCloseAutoFocus, which Radix fires from a timer after the menu unmounts), so the dialog it
 * opens records the trigger as its opener and closing the dialog brings focus back there.
 * 중복 문제 정리 (UX7-DEDUP, QOV-01-AC16: `?panel=question-duplicates`) merges questions, so it is
 * editor-only like 직접 추가; so is 챕터 재분배 (CHREDIST-01: `?panel=chapter-redistribution`), which
 * moves questions between chapters, after it in the same group, and 챕터 관리 (CHMAN-01:
 * `?panel=chapter-management`), which edits the chapter tree, after that.
 * 보관·초안 문제 (UX7-BANK-2, QOV-01-AC15: the floating dialog of draft and archived questions,
 * `?panel=inactive-questions`) is readable by every member, so it stays enabled.

 */
export function QuestionMenu({
  readOnly,
  documentCount,
  searchHref,
  onDocuments,
  onCreate,
  onDuplicates,
  onRedistribute,
  onManageChapters,
  onInactive,
}: {
  readonly readOnly: QuestionMenuReadOnly;
  readonly documentCount: number;
  readonly searchHref: string;
  readonly onDocuments: () => void;
  readonly onCreate: () => void;
  readonly onDuplicates: () => void;
  readonly onRedistribute: () => void;
  readonly onManageChapters: () => void;
  readonly onInactive: () => void;
}) {
  const reasonId = useId();
  const ownReasonId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pending = useRef<(() => void) | null>(null);
  const actions: readonly QuestionMenuAction[] = [
    {
      key: 'create',
      label: '직접 추가',
      requiresEdit: true,
      separated: true,
      onSelect: onCreate,
    },
    { key: 'duplicates', label: '중복 문제 정리', requiresEdit: true, onSelect: onDuplicates },
    { key: 'redistribute', label: '챕터 재분배', requiresEdit: true, onSelect: onRedistribute },
    { key: 'chapters', label: '챕터 관리', requiresEdit: true, onSelect: onManageChapters },
    {
      key: 'inactive',
      label: '보관·초안 문제',
      requiresEdit: false,
      separated: true,
      onSelect: onInactive,
    },
  ];
  const reason = readOnly ? READ_ONLY_REASONS[readOnly] : null;
  const anyDisabled = reason !== null && actions.some((a) => a.requiresEdit);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button ref={triggerRef} className={styles.compactButton}>
          <DocumentsIcon width={16} height={16} className={styles.compactIcon} />
          <span className={styles.documentsLabel}>
            문서 <span className={styles.count}>{documentCount}</span>
          </span>
          <ChevronDownIcon
            width={16}
            height={16}
            aria-hidden="true"
            className={styles.documentsChevron}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        aria-label="문서"
        aria-describedby={anyDisabled ? reasonId : undefined}
        onCloseAutoFocus={(event) => {
          const action = pending.current;
          pending.current = null;
          if (!action) return;
          event.preventDefault();
          // The dialog it opens never moves the page (HOMEDLG-01-AC03), nor does this focus.
          triggerRef.current?.focus({ preventScroll: true });
          action();
        }}
      >
        {anyDisabled ? <DropdownMenuLabel id={reasonId}>{reason}</DropdownMenuLabel> : null}
        <DropdownMenuItem
          onSelect={() => {
            pending.current = onDocuments;
          }}
        >
          문서 관리
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link
            href={searchHref}
            onClick={(event) => {
              if (isPlainClick(event)) markSearchEntryFromHome();
            }}
          >
            본문 검색
          </Link>
        </DropdownMenuItem>
        {actions.map((action) => {
          const own = action.ownReason ?? null;
          const disabled = (action.requiresEdit && reason !== null) || own !== null;
          return (
            <Fragment key={action.key}>
              {action.separated ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                disabled={disabled}
                aria-describedby={own !== null ? ownReasonId : disabled ? reasonId : undefined}
                onSelect={() => {
                  pending.current = action.onSelect;
                }}
              >
                {action.label}
              </DropdownMenuItem>
              {own !== null ? <DropdownMenuLabel id={ownReasonId}>{own}</DropdownMenuLabel> : null}
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

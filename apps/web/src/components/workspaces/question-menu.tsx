'use client';

import { Fragment, useId, useRef } from 'react';
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
  readonly onSelect: () => void;
}

/**
 * The header's `문제` menu (UX4): 직접 추가 (the 문제 등록 editor on the home,
 * `?panel=question-create`, UX7-BANK) and 변형 출제 (the 문제 생성 dialog). The 전체 문제 link
 * (UX6-PROGRESS) went with its page (UX7-BANK) and PDF 관리 with the 문제 PDF 관리 dialog, merged
 * into 문서 관리 (UX7-DOCS, DOC-01-AC09). The button is shown to everyone (UX7-DOCS-2,
 * QOV-01-AC11): without edit rights the editor-only items are Radix-disabled (aria-disabled,
 * skipped by the arrow keys) and a text label says why, since a disabled item has no tooltip on
 * touch. A chosen action runs only once the menu has handed focus back to its trigger (in
 * onCloseAutoFocus, which Radix fires from a timer after the menu unmounts), so the dialog it
 * opens records the trigger as its opener and closing the dialog brings focus back there.
 * 중복 문제 정리 (UX7-DEDUP, QOV-01-AC16: `?panel=question-duplicates`) merges questions, so it is
 * editor-only like 직접 추가 and 변형 출제.
 * 보관·초안 문제 (UX7-BANK-2, QOV-01-AC15: the floating dialog of draft and archived questions,
 * `?panel=inactive-questions`) is readable by every member, so it stays enabled.
 */
export function QuestionMenu({
  readOnly,
  onCreate,
  onGenerate,
  onDuplicates,
  onInactive,
}: {
  readonly readOnly: QuestionMenuReadOnly;
  readonly onCreate: () => void;
  readonly onGenerate: () => void;
  readonly onDuplicates: () => void;
  readonly onInactive: () => void;
}) {
  const reasonId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pending = useRef<(() => void) | null>(null);
  const afterClose = (action: () => void) => () => {
    pending.current = action;
  };
  const actions: readonly QuestionMenuAction[] = [
    { key: 'create', label: '직접 추가', requiresEdit: true, onSelect: onCreate },
    { key: 'generate', label: '변형 출제', requiresEdit: true, onSelect: onGenerate },
    { key: 'duplicates', label: '중복 문제 정리', requiresEdit: true, onSelect: onDuplicates },
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
        <Button ref={triggerRef}>
          문제
          <ChevronDownIcon width={16} height={16} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        aria-label="문제"
        aria-describedby={anyDisabled ? reasonId : undefined}
        onCloseAutoFocus={(event) => {
          const action = pending.current;
          pending.current = null;
          if (!action) return;
          event.preventDefault();
          triggerRef.current?.focus();
          action();
        }}
      >
        {anyDisabled ? <DropdownMenuLabel id={reasonId}>{reason}</DropdownMenuLabel> : null}
        {actions.map((action) => {
          const disabled = action.requiresEdit && reason !== null;
          return (
            <Fragment key={action.key}>
              {action.separated ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                disabled={disabled}
                aria-describedby={disabled ? reasonId : undefined}
                onSelect={afterClose(action.onSelect)}
              >
                {action.label}
              </DropdownMenuItem>
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

'use client';

import { useId } from 'react';
import {
  Button,
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
  readonly onSelect: () => void;
}

/**
 * The header's `문제` menu (UX4): 직접 추가 (the 문제 등록 editor on the home,
 * `?panel=question-create`, UX7-BANK) and 변형 출제 (the 문제 생성 dialog). The 전체 문제 link
 * (UX6-PROGRESS) went with its page (UX7-BANK) and PDF 관리 with the 문제 PDF 관리 dialog, merged
 * into 문서 관리 (UX7-DOCS, DOC-01-AC09). The button is shown to everyone (UX7-DOCS-2,
 * QOV-01-AC11): without edit rights the editor-only items are Radix-disabled (aria-disabled,
 * skipped by the arrow keys) and a text label says why, since a disabled item has no tooltip on
 * touch. A dialog opens once the menu has returned focus to its trigger, so closing the dialog
 * brings focus back there.
 */
export function QuestionMenu({
  readOnly,
  onCreate,
  onGenerate,
}: {
  readonly readOnly: QuestionMenuReadOnly;
  readonly onCreate: () => void;
  readonly onGenerate: () => void;
}) {
  const reasonId = useId();
  const afterClose = (action: () => void) => () => window.setTimeout(action, 0);
  const actions: readonly QuestionMenuAction[] = [
    { key: 'create', label: '직접 추가', requiresEdit: true, onSelect: onCreate },
    { key: 'generate', label: '변형 출제', requiresEdit: true, onSelect: onGenerate },
  ];
  const reason = readOnly ? READ_ONLY_REASONS[readOnly] : null;
  const anyDisabled = reason !== null && actions.some((a) => a.requiresEdit);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button>
          문제
          <ChevronDownIcon width={16} height={16} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        aria-label="문제"
        aria-describedby={anyDisabled ? reasonId : undefined}
      >
        {anyDisabled ? <DropdownMenuLabel id={reasonId}>{reason}</DropdownMenuLabel> : null}
        {actions.map((action) => {
          const disabled = action.requiresEdit && reason !== null;
          return (
            <DropdownMenuItem
              key={action.key}
              disabled={disabled}
              aria-describedby={disabled ? reasonId : undefined}
              onSelect={afterClose(action.onSelect)}
            >
              {action.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

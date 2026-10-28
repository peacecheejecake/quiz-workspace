'use client';

// `종류 변경` (DOC-01-AC08, UX6-UPLOAD): a Radix menu on a ready row, for editors. Its items are the
// three kinds as radio items (role menuitemradio), the current one checked — with a check mark as
// well as aria-checked, never colour alone. Picking one saves it at once; the row shows a refusal.
// While the save runs the trigger is disabled (aria-disabled, so it keeps the focus the closing
// menu returns to it; it does not open) with a visible "저장 중" — no second choice can be made.
import {
  Button,
  CheckIcon,
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@quiz/ui';
import { useState } from 'react';
import type { DocumentKind } from '@/lib/documents/client-api';
import styles from './documents.module.css';
import { DOCUMENT_KIND_LABELS, DOCUMENT_KINDS } from './labels';

export interface DocumentKindMenuProps {
  readonly title: string;
  readonly kind: DocumentKind | null;
  readonly busy: boolean;
  readonly onChange: (kind: DocumentKind) => void;
}

export function DocumentKindMenu({ title, kind, busy, onChange }: DocumentKindMenuProps) {
  const name = `${title} 종류 변경`;
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu
      modal={false}
      open={open && !busy}
      onOpenChange={(next) => setOpen(next && !busy)}
    >
      {busy ? (
        <span className={styles.kindSaving} role="status">
          저장 중
        </span>
      ) : null}
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          aria-label={name}
          aria-busy={busy || undefined}
          aria-disabled={busy || undefined}
          data-busy={busy || undefined}
          className={styles.kindTrigger}
        >
          종류 변경
          <ChevronDownIcon width={16} height={16} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label={name}>
        {DOCUMENT_KINDS.map((option) => {
          const checked = option === kind;
          return (
            <DropdownMenuItem
              key={option}
              // A radio item (what Radix's RadioItem renders), without a RadioGroup wrapper.
              role="menuitemradio"
              aria-checked={checked}
              data-state={checked ? 'checked' : 'unchecked'}
              className={styles.kindItem}
              disabled={busy}
              onSelect={() => {
                if (!busy) onChange(option);
              }}
            >
              <CheckIcon
                width={16}
                height={16}
                aria-hidden="true"
                className={styles.kindCheck}
                data-checked={checked || undefined}
              />
              {DOCUMENT_KIND_LABELS[option]}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

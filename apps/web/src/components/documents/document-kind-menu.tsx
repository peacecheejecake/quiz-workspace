'use client';

// `종류 변경` (DOC-01-AC08, UX6-UPLOAD): a Radix menu on a ready row, for editors. Its items are the
// three kinds as radio items (role menuitemradio), the current one checked — with a check mark as
// well as aria-checked, never colour alone. Picking one saves it at once; the row shows a refusal.
import {
  Button,
  CheckIcon,
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@quiz/ui';
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
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" aria-label={name} aria-busy={busy || undefined}>
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
              onSelect={() => onChange(option)}
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

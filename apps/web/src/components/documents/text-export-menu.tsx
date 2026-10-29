'use client';

// `텍스트 내보내기` (DOC-03, docs/screens/documents-text-export.md): a Radix menu that saves the
// document's canonical text as `Markdown (.md)` or `텍스트 (.txt)`. Two places: the 문서 관리 row
// (icon button "<title> 텍스트 내보내기", every member, ready rows only) and the DOC-02 header (text
// button, plus `전체 복사` of the revision on screen). An editor whose document has an unpublished
// correction draft gets two groups, `발행본` and `교정 중 초안`. While a file is prepared the
// trigger shows "내보내는 중" and is aria-disabled (it keeps the focus the closing menu returns to
// it); failures are an alert, the copy result a status message. FastAPI decides what may be
// exported; the text itself never leaves memory except as the saved file or the clipboard.
import {
  Button,
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
} from '@quiz/ui';
import { useCallback, useEffect, useId, useRef, useState, type SVGProps } from 'react';
import {
  copyText,
  fetchDocumentText,
  saveExportedText,
  TEXT_EXPORT_MESSAGES,
  TextExportError,
  type TextExportFormat,
  type TextExportRevision,
} from '@/lib/documents/text-export';
import styles from './documents.module.css';

const LABEL = '텍스트 내보내기';
const FORMAT_LABELS: Readonly<Record<TextExportFormat, string>> = {
  md: 'Markdown (.md)',
  txt: '텍스트 (.txt)',
};
const FORMATS: readonly TextExportFormat[] = ['md', 'txt'];
const COPIED_VISIBLE_MS = 5000;

export interface TextExportMenuProps {
  readonly documentId: string;
  /** Document title (row button name, fallback file name). */
  readonly title: string;
  /** `row`: icon button in 문서 관리; `header`: text button in DOC-02. */
  readonly variant: 'row' | 'header';
  /** Offer the `교정 중 초안` group (an editor, and the document has an unpublished draft). */
  readonly draft?: boolean;
  /** `전체 복사` of this revision's Markdown (DOC-02: the revision on screen); absent = no item. */
  readonly copyRevision?: TextExportRevision;
}

type Status = { readonly kind: 'idle' } | { readonly kind: 'busy' } | { readonly kind: 'copied' };

export function TextExportMenu({
  documentId,
  title,
  variant,
  draft = false,
  copyRevision,
}: TextExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [failure, setFailure] = useState<string | null>(null);
  const busy = status.kind === 'busy';
  const copiedTimer = useRef<number | undefined>(undefined);
  const publishedId = useId();
  const draftId = useId();

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const exportFile = useCallback(
    async (format: TextExportFormat, revision: TextExportRevision) => {
      setFailure(null);
      // Closed explicitly: a controlled menu whose `open` prop already reads false would not
      // report Radix's close, and would reopen once the work is done.
      setOpen(false);
      setStatus({ kind: 'busy' });
      try {
        saveExportedText(await fetchDocumentText(documentId, title, format, revision));
      } catch (error) {
        setFailure(error instanceof TextExportError ? error.message : TEXT_EXPORT_MESSAGES.failed);
      } finally {
        setStatus({ kind: 'idle' });
      }
    },
    [documentId, title],
  );

  const copyAll = useCallback(
    async (revision: TextExportRevision) => {
      setFailure(null);
      // Closed explicitly: a controlled menu whose `open` prop already reads false would not
      // report Radix's close, and would reopen once the work is done.
      setOpen(false);
      setStatus({ kind: 'busy' });
      window.clearTimeout(copiedTimer.current);
      try {
        // Started inside the click so Safari keeps the user activation for the clipboard.
        await copyText(async () => {
          const file = await fetchDocumentText(documentId, title, 'md', revision);
          return file.blob.text();
        });
        setStatus({ kind: 'copied' });
        copiedTimer.current = window.setTimeout(
          () => setStatus((now) => (now.kind === 'copied' ? { kind: 'idle' } : now)),
          COPIED_VISIBLE_MS,
        );
      } catch (error) {
        setStatus({ kind: 'idle' });
        setFailure(
          error instanceof TextExportError && error.reason === 'notReady'
            ? error.message
            : TEXT_EXPORT_MESSAGES.copyFailed,
        );
      }
    },
    [documentId, title],
  );

  const items = (revision: TextExportRevision) =>
    FORMATS.map((format) => (
      <DropdownMenuItem
        key={`${revision}-${format}`}
        disabled={busy}
        onSelect={() => void exportFile(format, revision)}
      >
        {FORMAT_LABELS[format]}
      </DropdownMenuItem>
    ));

  const name = variant === 'row' ? `${title} ${LABEL}` : LABEL;
  const triggerProps = {
    'aria-busy': busy || undefined,
    'aria-disabled': busy || undefined,
    'data-busy': busy || undefined,
    className: styles.exportTrigger,
  };

  return (
    <span className={styles.exportMenu}>
      <DropdownMenu modal={false} open={open} onOpenChange={(next) => setOpen(next && !busy)}>
        <DropdownMenuTrigger asChild>
          {variant === 'row' ? (
            <IconButton
              size="sm"
              label={name}
              title={LABEL}
              icon={<ExportIcon />}
              {...triggerProps}
            />
          ) : (
            <Button size="sm" {...triggerProps}>
              {LABEL}
              <ChevronDownIcon width={16} height={16} aria-hidden="true" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent aria-label={name}>
          {draft ? (
            <>
              <DropdownMenuGroup aria-labelledby={publishedId}>
                <DropdownMenuLabel id={publishedId}>발행본</DropdownMenuLabel>
                {items('published')}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup aria-labelledby={draftId}>
                <DropdownMenuLabel id={draftId}>교정 중 초안</DropdownMenuLabel>
                {items('draft')}
              </DropdownMenuGroup>
            </>
          ) : (
            items('published')
          )}
          {copyRevision ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={busy} onSelect={() => void copyAll(copyRevision)}>
                전체 복사
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Only while there is something to say: DOC-02 has its own revision status region. */}
      {status.kind !== 'idle' ? (
        <span role="status" className={styles.exportStatus}>
          {busy ? '내보내는 중' : TEXT_EXPORT_MESSAGES.copied}
        </span>
      ) : null}
      {failure ? (
        <span role="alert" className={styles.exportAlert}>
          {failure}
        </span>
      ) : null}
    </span>
  );
}

/** A page with an outgoing arrow (export a file). */
function ExportIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7z" />
      <path d="M14 3v4h4M12 11v6M9.5 14.5 12 17l2.5-2.5" />
    </svg>
  );
}

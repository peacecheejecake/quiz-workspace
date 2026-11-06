'use client';

// "원본 비교" for QIMPORT-01: the draft next to its source page of the uploaded PDF, in the shared
// FloatingSidePanel (wide, ≥ 600px comparison drawer, design-system §5.1). Modal since UX9
// (HOMEDLG-01, user decision 2026-11-02): the draft list behind it is inert, so the panel shows
// the draft's extracted content read-only (stem, options with the answer marked as text, accepted
// answers or rubric, explanation) and moves along the page's drafts with `이전 초안`/`다음 초안`
// (Alt+↑/Alt+↓); to edit, close it (focus returns to the draft last shown). The PDF comes through
// the source-url relay (short-lived signed URL, never logged or put into a page URL) and the
// extracted question area is highlighted from the draft's evidence bbox.
import { CheckIcon, FloatingSidePanel } from '@quiz/ui';
import { useMemo, useState } from 'react';
import { PdfViewer } from '@/components/documents/editor/pdf-viewer';
import { createEditorClient } from '@/lib/documents/editor-api';
import { loadPdfBytes, SignedUrlCache } from '@/lib/documents/pdf-source';
import { draftNumber, type ReviewDraft } from '@/lib/questions/drafts';
import styles from './question-import.module.css';
import { OptionCells, OptionGridHead } from '@/components/questions/stem/option-grid';
import { StemText } from '@/components/questions/stem/stem-text';
import { optionGrid } from '@/lib/questions/stem-table';

export interface SourceComparePanelProps {
  /** Null while closed. */
  readonly draft: ReviewDraft | null;
  /** The drafts of the page in list order; those with source pages are stepped through. */
  readonly drafts?: readonly ReviewDraft[];
  /** Shows another draft (이전 초안 / 다음 초안). */
  readonly onSelect?: (draft: ReviewDraft) => void;
  readonly onClose: () => void;
}

/** `data-compare-draft` on a draft's `원본 비교` button: focus returns there on close. */
const COMPARE_DRAFT_ATTRIBUTE = 'data-compare-draft';

export function SourceComparePanel({
  draft,
  drafts = [],
  onSelect,
  onClose,
}: SourceComparePanelProps) {
  // The draft last shown: focus returns to its button once the panel has closed.
  const [shown, setShown] = useState<string | null>(null);
  if (draft && draft.id !== shown) setShown(draft.id);
  const comparable = drafts.filter((d) => d.pages.length > 0);
  const at = draft ? comparable.findIndex((d) => d.id === draft.id) : -1;
  const previous = at > 0 ? comparable[at - 1] : undefined;
  const next = at >= 0 ? comparable[at + 1] : undefined;

  return (
    <FloatingSidePanel
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="wide"
      mobileLayout="full"
      title="원본 PDF"
      description={draft ? `${draftNumber(draft)}번 문제와 원본 페이지를 비교합니다.` : undefined}
      closeLabel="원본 닫기"
      steps={
        onSelect
          ? {
              previousLabel: '이전 초안',
              nextLabel: '다음 초안',
              onPrevious: previous ? () => onSelect(previous) : undefined,
              onNext: next ? () => onSelect(next) : undefined,
            }
          : undefined
      }
      onCloseAutoFocus={(event) => {
        if (!shown) return;
        const button = document.querySelector<HTMLElement>(
          `button[${COMPARE_DRAFT_ATTRIBUTE}="${CSS.escape(shown)}"]`,
        );
        if (!button) return;
        event.preventDefault();
        button.focus();
      }}
    >
      {draft?.sourceDocumentId ? (
        <ComparePages key={draft.id} draft={draft} documentId={draft.sourceDocumentId} />
      ) : draft ? (
        <>
          <DraftContent draft={draft} />
          <p>이 초안에는 연결된 원본 PDF가 없습니다.</p>
        </>
      ) : null}
    </FloatingSidePanel>
  );
}

function ComparePages({ draft, documentId }: { draft: ReviewDraft; documentId: string }) {
  const pdfSource = useMemo(() => {
    const client = createEditorClient();
    const urls = new SignedUrlCache((signal) => client.getSourceUrl(documentId, signal));
    return (signal: AbortSignal) => loadPdfBytes(urls, { signal });
  }, [documentId]);
  const [page, setPage] = useState(draft.pages[0] ?? 1);
  const highlights = draft.locations.filter((l) => l.page === page);

  return (
    <div className={styles.compare}>
      <DraftContent draft={draft} page={page} />
      <PdfViewer
        source={pdfSource}
        page={page}
        onPageChange={setPage}
        highlights={highlights}
        highlightKey={`${draft.id}-${page}`}
        className={styles.compareViewer}
      />
    </div>
  );
}

/** The draft's extracted content, read-only (edit it from the list after closing the panel). */
function DraftContent({ draft, page }: { draft: ReviewDraft; page?: number }) {
  const grid = draft.type === 'MCQ' ? optionGrid(draft.stem, draft.options) : null;
  return (
    <section className={styles.compareDraft} aria-label={`${draftNumber(draft)}번 초안`}>
      {draft.pages.length > 0 ? (
        <p className={styles.comparePage}>
          원본 {draft.pages.map((p) => `${p}쪽`).join(', ')}
          {page !== undefined ? ` · 지금 보는 쪽: ${page}쪽` : null}
        </p>
      ) : null}
      <StemText stem={grid?.stem ?? draft.stem} className={styles.compareStem} />
      {grid ? <OptionGridHead grid={grid} trailing className={styles.compareGridHead} /> : null}
      {draft.options.length > 0 ? (
        <ol className={styles.compareOptions}>
          {draft.options.map((o, index) => {
            const mark = o.correct ? (
              <span className={styles.compareCorrect}>
                <CheckIcon width={14} height={14} aria-hidden="true" />
                정답
              </span>
            ) : null;
            return (
              <li key={o.id}>
                {grid ? (
                  <OptionCells grid={grid} index={index} trailing={mark} reserveTrailing />
                ) : (
                  <>
                    {o.text}
                    {mark}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      ) : null}
      {draft.type === 'SHORT_ANSWER' &&
      draft.acceptedAnswers &&
      draft.acceptedAnswers.length > 0 ? (
        <p className={styles.compareNote}>
          <span className={styles.compareLabel}>허용 답안</span> {draft.acceptedAnswers.join(', ')}
        </p>
      ) : null}
      {draft.type === 'ESSAY' && draft.rubric ? (
        <p className={styles.compareNote}>
          <span className={styles.compareLabel}>채점 기준</span> {draft.rubric}
        </p>
      ) : null}
      {draft.answerMissing ? <p className={styles.compareNote}>정답 없음</p> : null}
      {draft.explanation ? (
        <p className={styles.compareNote}>
          <span className={styles.compareLabel}>해설</span> {draft.explanation}
        </p>
      ) : null}
    </section>
  );
}

'use client';

// "원본 비교" for QIMPORT-01: the draft next to its source page of the uploaded PDF, in the shared
// FloatingSidePanel (wide, ≥ 600px comparison drawer, design-system §5.1). Modal since UX9
// (HOMEDLG-01, user decision 2026-11-02): the draft list behind it is inert, so the panel shows
// the draft's extracted content read-only (stem, options with the answer marked as text, accepted
// answers or rubric, explanation) and moves along the page's drafts with `이전 초안`/`다음 초안`
// (Alt+↑/Alt+↓); to edit, close it (focus returns to the draft last shown). The PDF comes through
// the source-url relay (short-lived signed URL, never logged or put into a page URL) and the
// extracted question area is highlighted from the draft's evidence bbox. UX12-SOURCE: a draft's
// page link opens it at that page (focus returns to the link), and `전체 문서 보기` leaves for DOC-02.
import { Button, CheckIcon, FloatingSidePanel } from '@quiz/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useDocumentPdfSource } from '@/components/documents/editor/pdf-page-dialog';
import { FULL_DOCUMENT_LABEL } from '@/components/documents/editor/pdf-page-label';
import { PdfViewer } from '@/components/documents/editor/pdf-viewer';
import { draftNumber, type ReviewDraft } from '@/lib/questions/drafts';
import styles from './question-import.module.css';
import { OptionCells, OptionGridHead } from '@/components/questions/stem/option-grid';
import { StemText } from '@/components/questions/stem/stem-text';
import { optionGrid } from '@/lib/questions/stem-table';

export interface SourceComparePanelProps {
  /** Null while closed. */
  readonly draft: ReviewDraft | null;
  /** The page a page link asked for; without it the draft's first page. */
  readonly initialPage?: number | undefined;
  /** The document of a draft without its own, from the import run. */
  readonly sourceDocumentId?: string | null;
  readonly workspaceId: string;
  /** The drafts of the page in list order; those with source pages are stepped through. */
  readonly drafts?: readonly ReviewDraft[];
  /** Shows another draft (이전 초안 / 다음 초안). */
  readonly onSelect?: (draft: ReviewDraft) => void;
  readonly onClose: () => void;
}

/** `data-compare-draft` on a draft's `원본 비교` button: focus returns there on close. */
const COMPARE_DRAFT_ATTRIBUTE = 'data-compare-draft';
/** `data-compare-page` (`<draft>:<page>`) on a draft's page link, when it opened the panel. */
const COMPARE_PAGE_ATTRIBUTE = 'data-compare-page';

interface Shown {
  readonly draftId: string;
  readonly page: number | undefined;
}

export function SourceComparePanel({
  draft,
  initialPage,
  sourceDocumentId,
  workspaceId,
  drafts = [],
  onSelect,
  onClose,
}: SourceComparePanelProps) {
  // What was shown last: focus returns to the control that opened it once the panel has closed.
  const [shown, setShown] = useState<Shown | null>(null);
  if (draft && (draft.id !== shown?.draftId || initialPage !== shown.page)) {
    setShown({ draftId: draft.id, page: initialPage });
  }
  const documentId = draft ? (draft.sourceDocumentId ?? sourceDocumentId) : null;
  const firstPage = initialPage ?? draft?.pages[0] ?? 1;
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
      footer={
        documentId ? (
          <Button asChild>
            <Link href={`/workspaces/${workspaceId}/documents/${documentId}?page=${firstPage}`}>
              {FULL_DOCUMENT_LABEL}
            </Link>
          </Button>
        ) : undefined
      }
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
        const pageLink = `button[${COMPARE_PAGE_ATTRIBUTE}="${CSS.escape(`${shown.draftId}:${shown.page}`)}"]`;
        const button =
          (shown.page !== undefined ? document.querySelector<HTMLElement>(pageLink) : null) ??
          document.querySelector<HTMLElement>(
            `button[${COMPARE_DRAFT_ATTRIBUTE}="${CSS.escape(shown.draftId)}"]`,
          );
        if (!button) return;
        event.preventDefault();
        button.focus();
      }}
    >
      {draft && documentId ? (
        <ComparePages
          key={`${draft.id}:${initialPage ?? ''}`}
          draft={draft}
          documentId={documentId}
          firstPage={firstPage}
        />
      ) : draft ? (
        <>
          <DraftContent draft={draft} />
          <p>이 초안에는 연결된 원본 PDF가 없습니다.</p>
        </>
      ) : null}
    </FloatingSidePanel>
  );
}

function ComparePages({
  draft,
  documentId,
  firstPage,
}: {
  draft: ReviewDraft;
  documentId: string;
  firstPage: number;
}) {
  const pdfSource = useDocumentPdfSource(documentId);
  const [page, setPage] = useState(firstPage);
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

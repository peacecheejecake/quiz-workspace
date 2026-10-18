'use client';

// "원본 비교" for QIMPORT-01: the draft next to its source page of the uploaded PDF, in the shared
// FloatingSidePanel (wide, ≥ 600px comparison drawer, design-system §5.1). Non-modal, so the
// draft list stays usable while the page is open. The PDF comes through the source-url relay
// (short-lived signed URL, never logged or put into a page URL) and the extracted question area
// is highlighted from the draft's evidence bbox.
import { FloatingSidePanel } from '@quiz/ui';
import { useMemo, useState } from 'react';
import { PdfViewer } from '@/components/documents/editor/pdf-viewer';
import { createEditorClient } from '@/lib/documents/editor-api';
import { loadPdfBytes, SignedUrlCache } from '@/lib/documents/pdf-source';
import { draftNumber, type ReviewDraft } from '@/lib/questions/drafts';
import styles from './question-import.module.css';

export interface SourceComparePanelProps {
  /** Null while closed. */
  readonly draft: ReviewDraft | null;
  readonly onClose: () => void;
}

export function SourceComparePanel({ draft, onClose }: SourceComparePanelProps) {
  return (
    <FloatingSidePanel
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      modal={false}
      size="wide"
      mobileLayout="full"
      title="원본 PDF"
      description={draft ? `${draftNumber(draft)}번 문제와 원본 페이지를 비교합니다.` : undefined}
      closeLabel="원본 닫기"
    >
      {draft?.sourceDocumentId ? (
        <ComparePages key={draft.id} draft={draft} documentId={draft.sourceDocumentId} />
      ) : draft ? (
        <p>이 초안에는 연결된 원본 PDF가 없습니다.</p>
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
      <section className={styles.compareDraft} aria-label={`${draftNumber(draft)}번 초안`}>
        <p className={styles.comparePage}>
          원본 {draft.pages.map((p) => `${p}쪽`).join(', ')} · 지금 보는 쪽: {page}쪽
        </p>
        <p className={styles.compareStem}>{draft.stem}</p>
        {draft.options.length > 0 ? (
          <ol className={styles.compareOptions}>
            {draft.options.map((o) => (
              <li key={o.id}>{o.text}</li>
            ))}
          </ol>
        ) : null}
      </section>
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

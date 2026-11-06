'use client';

// UX12-SOURCE: one page of a document's original PDF in a floating dialog, so a source link keeps
// the reader on the screen they came from (the URL does not change, focus returns to the link).
// Paired with the panel it was opened from, like QSRC-01's 문제 원문 dialog. The whole PDF is
// reachable here, so a practice surface may only mount this once the position was submitted
// (QSRC-01: the PDF can hold the answers). The PDF comes through the source-url relay; a signed URL
// is never logged or put into a page URL.
import { Button, FloatingSidePanel, usePairedSheet } from '@quiz/ui';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createEditorClient } from '@/lib/documents/editor-api';
import { loadPdfBytes, SignedUrlCache, type PdfBytesSource } from '@/lib/documents/pdf-source';
import styles from './editor.module.css';
import { FULL_DOCUMENT_LABEL } from './pdf-page-label';
import { PdfViewer } from './pdf-viewer';

export interface PdfPageTarget {
  readonly documentId: string;
  readonly page: number;
  /** DOC-02 at this place: the `전체 문서 보기` link. */
  readonly documentHref: string;
  readonly documentTitle?: string;
}

export interface PdfPageDialogProps {
  /** Null while closed. */
  readonly target: PdfPageTarget | null;
  readonly onClose: () => void;
}

/** The original PDF of a document through the source-url relay. */
export function useDocumentPdfSource(documentId: string): PdfBytesSource {
  return useMemo(() => {
    const client = createEditorClient();
    const urls = new SignedUrlCache((signal) => client.getSourceUrl(documentId, signal));
    return (signal: AbortSignal) => loadPdfBytes(urls, { signal });
  }, [documentId]);
}

export function PdfPageDialog({ target, onClose }: PdfPageDialogProps) {
  const open = target !== null;
  const sheet = usePairedSheet();
  // The history entry a full-screen sheet owns: Back closes only the sheet (design-system §5.6).
  const pushed = useRef(false);
  useEffect(() => {
    if (!open || !sheet || pushed.current) return;
    window.history.pushState(window.history.state, '', window.location.href);
    pushed.current = true;
  }, [open, sheet]);
  // Through a ref: the router renders inside the same popstate event, and a listener replaced
  // then would miss it.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!open) return undefined;
    const onPopState = () => {
      if (!pushed.current) return;
      pushed.current = false;
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [open]);

  return (
    <FloatingSidePanel
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        onClose();
        if (pushed.current) {
          pushed.current = false;
          window.history.back();
        }
      }}
      paired
      title="원본 PDF"
      description={target?.documentTitle}
      closeLabel="원본 닫기"
      footer={
        target ? (
          <Button asChild>
            {/* In a sheet it takes over the sheet's history entry: one Back returns from DOC-02. */}
            <Link href={target.documentHref} replace={sheet}>
              {FULL_DOCUMENT_LABEL}
            </Link>
          </Button>
        ) : undefined
      }
    >
      {target ? (
        <PdfPage
          key={`${target.documentId}:${target.page}`}
          documentId={target.documentId}
          initialPage={target.page}
        />
      ) : null}
    </FloatingSidePanel>
  );
}

function PdfPage({ documentId, initialPage }: { documentId: string; initialPage: number }) {
  const source = useDocumentPdfSource(documentId);
  const [page, setPage] = useState(initialPage);
  return (
    <div className={styles.pageDialogBody}>
      <PdfViewer source={source} page={page} onPageChange={setPage} highlights={[]} />
    </div>
  );
}

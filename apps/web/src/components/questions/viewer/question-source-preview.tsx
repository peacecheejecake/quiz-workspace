'use client';

// QSRC-01 `문제 원문 보기` (docs/screens/question-source-preview.md, design-system §5.6): a text
// button in the question body that shows the question's own region of its imported PDF. The
// region (document id, page, bbox — no text) is requested when the question is shown; a 404 or an
// error renders nothing (no placeholder). The PDF itself is requested only when a preview or the
// dialog is first used (source-url relay + SignedUrlCache + loadPdfBytes, as in 원본 비교).
// hover / :focus-visible / touch long-press open a tooltip preview, click opens a paired
// FloatingSidePanel named "문제 원문" (left of the question panel from 868px, else a full-screen
// sheet that owns one history entry so Back closes only the sheet). Viewing is not practice: no
// attempt, no heatmap state, no URL change.
import { Button, FloatingSidePanel, PreviewTooltip, usePairedSheet } from '@quiz/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createEditorClient } from '@/lib/documents/editor-api';
import { loadPdfBytes, SignedUrlCache } from '@/lib/documents/pdf-source';
import { loadPdfjs, openPdf, type PdfDocument, type PdfLoadingTask } from '@/lib/documents/pdfjs';
import {
  fetchSourceRegions,
  type SourceRegion,
  type SourceRegionTarget,
} from '@/lib/questions/source-region';
import { PdfRegions } from './pdf-region';
import styles from './question-source-preview.module.css';

export const SOURCE_BUTTON_LABEL = '문제 원문 보기';
const LOADING_TEXT = '원문을 불러오는 중입니다';
const FAILURE_TEXT = '원문을 불러오지 못했습니다';

export interface QuestionSourcePreviewProps {
  /** The bank question (practice, sequence(bank), manage) or mock exam question. */
  readonly target: SourceRegionTarget;
  /** The host is a centered modal dialog (문제 상세): the 원문 dialog stacks above it. */
  readonly aboveModals?: boolean;
}

/** Shown in the question body header of every mode that has a region; nothing without one. */
export function QuestionSourcePreview(props: QuestionSourcePreviewProps) {
  // A new question starts over (region, PDF, open dialog): changing the position closes it.
  return <Preview key={`${props.target.kind}:${props.target.id}`} {...props} />;
}

type PdfState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly documents: ReadonlyMap<string, PdfDocument> }
  | { readonly status: 'error' };

const IDLE: PdfState = { status: 'idle' };

/** Opens the PDF(s) of the regions on demand; shared by the tooltip and the dialog. */
function useRegionPdf(regions: readonly SourceRegion[] | null) {
  const [state, setState] = useState<PdfState>(IDLE);
  const status = useRef<PdfState['status']>('idle');
  const run = useRef<{ controller: AbortController; tasks: PdfLoadingTask[] } | null>(null);

  const release = useCallback(() => {
    run.current?.controller.abort();
    for (const task of run.current?.tasks ?? []) void task.destroy();
    run.current = null;
  }, []);

  const update = useCallback((next: PdfState) => {
    status.current = next.status;
    setState(next);
  }, []);

  const start = useCallback(() => {
    if (!regions || status.current === 'loading' || status.current === 'ready') return;
    release();
    const current = { controller: new AbortController(), tasks: [] as PdfLoadingTask[] };
    run.current = current;
    const { signal } = current.controller;
    update({ status: 'loading' });
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const client = createEditorClient();
        const documents = new Map<string, PdfDocument>();
        for (const id of new Set(regions.map((r) => r.document_id))) {
          const urls = new SignedUrlCache((s) => client.getSourceUrl(id, s));
          const bytes = await loadPdfBytes(urls, { signal });
          const task = openPdf(pdfjs, bytes);
          current.tasks.push(task);
          documents.set(id, await task.promise);
        }
        if (!signal.aborted) update({ status: 'ready', documents });
      } catch {
        if (!signal.aborted) update({ status: 'error' });
      }
    })();
  }, [regions, release, update]);

  const fail = useCallback(() => {
    release();
    update({ status: 'error' });
  }, [release, update]);

  useEffect(() => release, [release]);
  return { state, start, fail };
}

function Preview({ target, aboveModals = false }: QuestionSourcePreviewProps) {
  const { kind, id } = target;
  const [regions, setRegions] = useState<readonly SourceRegion[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchSourceRegions({ kind, id }, controller.signal).then(
      (found) => {
        if (!controller.signal.aborted) setRegions(found);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [kind, id]);

  const pdf = useRegionPdf(regions);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sheet = usePairedSheet();
  // The history entry a full-screen sheet owns (AC04: Back closes the sheet, the URL is kept).
  const pushed = useRef(false);

  const openDialog = () => {
    if (sheet && !pushed.current) {
      window.history.pushState(window.history.state, '', window.location.href);
      pushed.current = true;
    }
    pdf.start();
    setOpen(true);
  };
  const closeDialog = () => {
    setOpen(false);
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    }
  };
  useEffect(() => {
    if (!open) return undefined;
    const onPopState = () => {
      if (!pushed.current) return;
      pushed.current = false;
      setOpen(false);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [open]);

  // Escape closes only this dialog (design-system §5.5, 맨 위부터 닫기). The key is taken before
  // any other layer sees it: the dialog is React-wise a child of the question panel, whose own
  // Escape handling would otherwise close it in the same key press.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      closeDialog();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  // While the dialog is open the host panel (the question panel, 문제 상세) stays visible but
  // inert (design-system §5.6); Radix only hides it from assistive technology.
  useEffect(() => {
    if (!open) return undefined;
    const host = buttonRef.current?.closest<HTMLElement>('[role="dialog"]');
    if (!host) return undefined;
    host.setAttribute('inert', '');
    return () => host.removeAttribute('inert');
  }, [open]);

  if (!regions) return null;
  const retry = () => pdf.start();
  return (
    <>
      <div className={styles.row}>
        <PreviewTooltip
          disabled={open}
          onOpenChange={(opened) => {
            if (opened) pdf.start();
          }}
          content={<TooltipContent regions={regions} pdf={pdf} />}
        >
          <Button
            ref={buttonRef}
            type="button"
            variant="ghost"
            size="sm"
            aria-label={SOURCE_BUTTON_LABEL}
            onClick={openDialog}
          >
            {SOURCE_BUTTON_LABEL}
          </Button>
        </PreviewTooltip>
      </div>
      <FloatingSidePanel
        open={open}
        onOpenChange={(next) => {
          if (!next) closeDialog();
        }}
        paired
        aboveModals={aboveModals}
        title="문제 원문"
        closeLabel="닫기"
        onCloseAutoFocus={(event) => {
          const button = buttonRef.current;
          if (!button?.isConnected) return;
          event.preventDefault();
          button.focus();
        }}
      >
        <div className={styles.dialogBody}>
          {pdf.state.status === 'error' ? (
            <div role="alert" className={styles.failure}>
              <p>{FAILURE_TEXT}</p>
              <Button onClick={retry}>다시 시도</Button>
            </div>
          ) : pdf.state.status === 'ready' ? (
            <PdfRegions
              regions={regions}
              documents={pdf.state.documents}
              fit="container"
              onFailed={pdf.fail}
            />
          ) : (
            <p role="status" className={styles.message}>
              {LOADING_TEXT}
            </p>
          )}
        </div>
      </FloatingSidePanel>
    </>
  );
}

/** Tooltip body: the same figures at tooltip size (width min(360px, 100vw - 32px), height 320px). */
function TooltipContent({
  regions,
  pdf,
}: {
  readonly regions: readonly SourceRegion[];
  readonly pdf: ReturnType<typeof useRegionPdf>;
}) {
  const fit = useMemo(() => {
    // The preview shell pads its content; one figure per page must fit the 320px height together.
    const width = Math.min(360, window.innerWidth - 32) - 32;
    const height = Math.min(320, window.innerHeight - 32) - 32;
    const labels = 24 * regions.length;
    return {
      maxWidth: Math.max(width, 80),
      maxHeight: Math.max((height - labels) / regions.length, 60),
    };
  }, [regions.length]);
  if (pdf.state.status === 'error') return <p className={styles.message}>{FAILURE_TEXT}</p>;
  if (pdf.state.status !== 'ready') {
    return (
      <p role="status" className={styles.message}>
        {LOADING_TEXT}
      </p>
    );
  }
  return (
    <PdfRegions regions={regions} documents={pdf.state.documents} fit={fit} onFailed={pdf.fail} />
  );
}

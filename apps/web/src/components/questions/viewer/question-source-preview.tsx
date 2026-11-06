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
// UX12-SRCMENU: every viewer holds `useQuestionSource` itself, so the menu's `원문 보기`, the body
// button and the figures share one region and one opened PDF.
// UX12-REEXTRACT: `QuestionFigures` draws the question's images above its options and asks for the
// PDF when they enter the viewport; a question without figures still fetches none.
import { Button, FloatingSidePanel, PreviewTooltip, usePairedSheet } from '@quiz/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createEditorClient } from '@/lib/documents/editor-api';
import { loadPdfBytes, SignedUrlCache } from '@/lib/documents/pdf-source';
import { loadPdfjs, openPdf, type PdfDocument, type PdfLoadingTask } from '@/lib/documents/pdfjs';
import {
  fetchSourceRegions,
  tooltipFit,
  type QuestionRegions,
  type SourceRegion,
  type SourceRegionTarget,
} from '@/lib/questions/source-region';
import { PdfRegions } from './pdf-region';
import styles from './question-source-preview.module.css';

export const SOURCE_BUTTON_LABEL = '문제 원문 보기';
const LOADING_TEXT = '원문을 불러오는 중입니다';
const FAILURE_TEXT = '원문을 불러오지 못했습니다';
const FIGURE_FAILURE_TEXT = '그림을 불러오지 못했습니다';

/** Handed to a viewer's `headerExtra`: null while the question has no region to show. */
export interface QuestionSourceControls {
  /** `trigger`: where focus goes back when the dialog closes (it also finds the host panel). */
  readonly onShowSource: ((trigger: HTMLElement | null) => void) | null;
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

  useEffect(
    () => () => {
      release();
      update(IDLE);
    },
    [regions, release, update],
  );
  return { state, start, fail };
}

export type QuestionSource = ReturnType<typeof useQuestionSource>;

const NO_FIGURES: readonly SourceRegion[] = [];

/**
 * The region, PDF and dialog state of the question shown. A new target starts over and closes the
 * dialog. `null` (the host panel is animating out) closes it but keeps the region, so the panel's
 * body does not jump; opening the question again reads the region again.
 */
export function useQuestionSource(target: SourceRegionTarget | null) {
  const kind = target?.kind;
  const id = target?.id;
  const key = target ? `${target.kind}:${target.id}` : null;
  const [found, setFound] = useState<QuestionRegions | null>(null);
  const regions = found?.regions ?? null;
  const [open, setOpen] = useState(false);
  const [shownKey, setShownKey] = useState(key);
  if (key !== shownKey) {
    setShownKey(key);
    setOpen(false);
    if (key !== null) setFound(null);
  }

  useEffect(() => {
    if (!kind || !id) return undefined;
    const controller = new AbortController();
    fetchSourceRegions({ kind, id }, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setFound(result);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [kind, id]);

  const pdf = useRegionPdf(regions);
  // The button or menu trigger that opened the dialog: focus returns to it, and the panel around it
  // is the host.
  const anchor = useRef<HTMLElement | null>(null);
  const sheet = usePairedSheet();
  // The history entry a full-screen sheet owns (AC04: Back closes the sheet, the URL is kept).
  const pushed = useRef(false);
  useEffect(() => {
    pushed.current = false;
  }, [key]);

  const show = (trigger: HTMLElement | null) => {
    anchor.current = trigger;
    pdf.start();
    setOpen(true);
  };
  // Entering sheet mode while open (a wide viewport that narrows, e.g. a rotated tablet) pushes the
  // entry too. Leaving sheet mode keeps it: a later close still calls history.back() once.
  useEffect(() => {
    if (!open || !sheet || pushed.current) return;
    window.history.pushState(window.history.state, '', window.location.href);
    pushed.current = true;
  }, [open, sheet]);
  const close = useCallback(() => {
    setOpen(false);
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    }
  }, []);
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
      close();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, close]);

  // While the dialog is open the host panel (the question panel, 문제 상세) stays visible but
  // inert (design-system §5.6); Radix only hides it from assistive technology.
  useEffect(() => {
    if (!open) return undefined;
    const host = anchor.current?.closest<HTMLElement>('[role="dialog"]');
    if (!host) return undefined;
    host.setAttribute('inert', '');
    return () => host.removeAttribute('inert');
  }, [open]);

  return {
    regions,
    figures: found?.figures ?? NO_FIGURES,
    open,
    pdf,
    anchor,
    show,
    close,
    onShowSource: regions ? show : null,
  };
}

/** The body header's text button; nothing without a region. */
export function QuestionSourceButton({ source }: { readonly source: QuestionSource }) {
  const { regions, open, pdf, show } = source;
  const buttonRef = useRef<HTMLButtonElement>(null);
  if (!regions) return null;
  return (
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
          onClick={() => show(buttonRef.current)}
        >
          {SOURCE_BUTTON_LABEL}
        </Button>
      </PreviewTooltip>
    </div>
  );
}

/** The question's images (UX12-REEXTRACT-AC04): nothing without any, no PDF until in view. */
export function QuestionFigures({ source }: { readonly source: QuestionSource }): ReactNode {
  const { figures, pdf } = source;
  const { start, state, fail } = pdf;
  const rootRef = useRef<HTMLDivElement>(null);
  const hasFigures = figures.length > 0;
  useEffect(() => {
    const element = rootRef.current;
    if (!hasFigures || !element) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      start();
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      start();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasFigures, start]);
  if (!hasFigures) return null;
  return (
    <div ref={rootRef} role="group" aria-label="문제 그림" className={styles.questionFigures}>
      {state.status === 'ready' ? (
        <PdfRegions
          regions={figures}
          documents={state.documents}
          fit="container"
          onFailed={fail}
          variant="figure"
        />
      ) : state.status === 'error' ? (
        <div role="alert" className={styles.failure}>
          <p>{FIGURE_FAILURE_TEXT}</p>
          <Button type="button" onClick={start}>
            다시 시도
          </Button>
        </div>
      ) : (
        <>
          {figures.map(({ document_id, page, bbox }) => (
            <div
              key={`${document_id}:${page}:${bbox.x0}:${bbox.y0}`}
              className={styles.figurePlaceholder}
              style={{ aspectRatio: `${bbox.x1 - bbox.x0} / ${bbox.y1 - bbox.y0}` }}
            />
          ))}
          <span role="status" className="qz-visually-hidden">
            그림을 불러오는 중입니다
          </span>
        </>
      )}
    </div>
  );
}

/** The paired "문제 원문" panel; rendered once for both entry points. */
export function QuestionSourceDialog({
  source,
  aboveModals = false,
}: {
  readonly source: QuestionSource;
  /** The host is a centered modal dialog (문제 상세): the 원문 dialog stacks above it. */
  readonly aboveModals?: boolean;
}) {
  const { regions, open, pdf, anchor, close } = source;
  if (!regions) return null;
  return (
    <FloatingSidePanel
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      paired
      aboveModals={aboveModals}
      title="문제 원문"
      closeLabel="닫기"
      onCloseAutoFocus={(event) => {
        const trigger = anchor.current;
        if (!trigger?.isConnected) return;
        event.preventDefault();
        trigger.focus();
      }}
    >
      <div className={styles.dialogBody}>
        {pdf.state.status === 'error' ? (
          <div role="alert" className={styles.failure}>
            <p>{FAILURE_TEXT}</p>
            <Button onClick={pdf.start}>다시 시도</Button>
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
  const fit = useMemo(
    () => tooltipFit(regions.length, window.innerWidth, window.innerHeight),
    [regions.length],
  );
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

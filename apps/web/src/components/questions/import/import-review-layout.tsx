'use client';

// QIMPORT-02 문제 PDF 가져오기 in two panes (docs/screens/questions-import-layout.md): the page header
// (h1 "문제 PDF 가져오기", breadcrumb), the left `nav` "검토할 PDF" list — 문서 관리's row part with
// each PDF's title, kind and state as text, the in-progress rows re-read like 문서 관리 — and the
// right `region` named by its h2 (the chosen PDF's title) holding QIMPORT-01's review of it.
// Below 768px the list is a bottom sheet behind a "검토할 PDF" button.
//
// The choice is `?document=<id>`: a row pushes one history entry (the server renders the new
// PDF's review; the page without `?document=` was already written in place by the server). The
// review pane is keyed by the PDF, so switching unmounts the previous one and aborts its reads —
// a late draft page of the old PDF never lands on the new one. While drafts are checked (and no
// registration runs) a switch asks first. Only the chosen PDF's drafts are read.
import {
  Button,
  ConfirmDialog,
  EmptyState,
  FloatingSidePanel,
  PageHeader,
  ProgressBar,
  type BadgeTone,
} from '@quiz/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type MouseEvent,
} from 'react';
import { DocumentRowItem } from '@/components/documents/document-row';
import { WorkspaceBackLink, WorkspaceBreadcrumb } from '@/components/workspaces/sub-page-nav';
import { loginRedirectPath } from '@/lib/auth/routes';
import { createDocumentsClient, type DocumentSummary } from '@/lib/documents/client-api';
import { buildRows, type DocumentRow } from '@/lib/documents/upload-machine';
import {
  isRegistrationActive,
  type BookChapterOption,
  type DraftSummary,
  type ImportRegistration,
  type ImportRun,
  type ReviewDraft,
} from '@/lib/questions/drafts';
import { createImportClient, ImportApiError, importPath } from '@/lib/questions/import-client';
import {
  REVIEW_RUNS,
  reviewPdfs,
  reviewPdfsInProgress,
  reviewPdfState,
  reviewPdfStateText,
  type ReviewPdf,
  type ReviewPdfLive,
  type ReviewPdfState,
} from '@/lib/questions/review-pdfs';
import { workspaceHomePath } from '@/lib/workspaces/home';
import { QuestionImport, READ_ONLY_TEXT, type ImportReadOnly } from './question-import';
import styles from './import-review-layout.module.css';
import importStyles from './question-import.module.css';

/** The chosen PDF's review as the server read it (QIMPORT-01 first render). */
export interface ImportReviewData {
  readonly run: ImportRun | null;
  readonly drafts: readonly ReviewDraft[];
  readonly summaries: readonly DraftSummary[];
  readonly chapters: readonly BookChapterOption[];
  readonly loadedAt: string;
  readonly loadFailed: boolean;
}

export interface ImportReviewLayoutProps {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly readOnly: ImportReadOnly;
  readonly documents: readonly DocumentSummary[];
  readonly runs: readonly ImportRun[];
  /** The documents could not be read (the list offers a reload; the review still shows). */
  readonly listFailed: boolean;
  /** `?document=` (null without one: only when the list is empty or could not be read). */
  readonly documentId: string | null;
  /** The page was opened without `?document=`: write `documentId`'s in place (no history entry). */
  readonly writeDocumentParam?: boolean;
  /** `?document=` is not on the list (another workspace's, deleted, malformed): nothing was read. */
  readonly notFound?: boolean;
  /** The chosen PDF's review; null when it has no extraction or is not on the list. */
  readonly review: ImportReviewData | null;
  /** How often in-progress rows are re-read (ms); tests shorten it. */
  readonly pollMs?: number;
}

const REVIEW_TITLE_ID = 'qimport-review-title';
const ReviewPane = memo(QuestionImport);

function stateBadge(state: ReviewPdfState): { label: string; tone: BadgeTone } {
  const label = reviewPdfStateText(state);
  switch (state.kind) {
    case 'processingFailed':
    case 'extractFailed':
      return { label, tone: 'danger' };
    case 'extracting':
    case 'registering':
    case 'processing':
      return { label, tone: 'accent' };
    case 'notExtracted':
      return { label, tone: 'warning' };
    default:
      return { label, tone: 'success' };
  }
}

/** The row's state for DocumentRowItem: processing rows keep 문서 관리's own steps. */
function rowState(state: ReviewPdfState) {
  if (state.kind === 'processing') return undefined;
  const badge = stateBadge(state);
  if (state.kind === 'extracting' || state.kind === 'registering') {
    const value =
      state.kind === 'registering'
        ? state.total > 0
          ? Math.round((state.processed / state.total) * 100)
          : 0
        : state.value;
    return {
      ...badge,
      detail: (
        <ProgressBar
          className={styles.rowProgress}
          label="진행률"
          value={value}
          valueText={badge.label}
        />
      ),
    };
  }
  return badge;
}

function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function jobPercent(progress: unknown): number | undefined {
  return typeof progress === 'number' && Number.isFinite(progress)
    ? Math.max(0, Math.min(100, Math.round(progress)))
    : undefined;
}

export function ImportReviewLayout({
  workspaceId,
  workspaceName,
  readOnly,
  documents: initialDocuments,
  runs: initialRuns,
  listFailed: initialListFailed,
  documentId,
  notFound = false,
  writeDocumentParam = false,
  review,
  pollMs = 3000,
}: ImportReviewLayoutProps) {
  const router = useRouter();
  const canEdit = readOnly === null;
  const importClient = useMemo(() => createImportClient(), []);
  const documentsClient = useMemo(() => createDocumentsClient(), []);

  const [documents, setDocuments] = useState(initialDocuments);
  const [runs, setRuns] = useState(initialRuns);
  const [listFailed, setListFailed] = useState(initialListFailed);
  // A newer server render (a switch, router.refresh) brings a fresher list.
  const [seen, setSeen] = useState({ initialDocuments, initialRuns, initialListFailed });
  if (
    seen.initialDocuments !== initialDocuments ||
    seen.initialRuns !== initialRuns ||
    seen.initialListFailed !== initialListFailed
  ) {
    setSeen({ initialDocuments, initialRuns, initialListFailed });
    setDocuments(initialDocuments);
    setRuns(initialRuns);
    setListFailed(initialListFailed);
  }

  const [extraction, setExtraction] = useState<ReadonlyMap<string, number | undefined>>(
    () => new Map(),
  );
  const [registrations, setRegistrations] = useState<ReadonlyMap<string, ImportRegistration>>(
    () => new Map(),
  );
  const [starting, setStarting] = useState<string | null>(null);
  const [startFailure, setStartFailure] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<{
    readonly documentId: string;
    readonly count: number;
  } | null>(null);
  const [switching, startSwitch] = useTransition();
  const heading = useRef<HTMLHeadingElement | null>(null);

  const pdfs = useMemo(() => reviewPdfs(runs, documents), [runs, documents]);
  const rows = useMemo(
    () =>
      buildRows(
        pdfs.map((pdf) => pdf.document),
        [],
      ),
    [pdfs],
  );
  const live = useMemo<ReviewPdfLive>(
    () => ({ extraction, registrations }),
    [extraction, registrations],
  );
  const selected = documentId ? (pdfs.find((pdf) => pdf.documentId === documentId) ?? null) : null;
  const paneRunId = review?.run?.id ?? null;

  const onUnauthenticated = useCallback(
    (error: unknown) => {
      const kind = (error as { kind?: string } | null)?.kind;
      if (kind !== 'unauthenticated') return false;
      router.replace(loginRedirectPath(importPath(workspaceId, documentId ?? undefined)));
      return true;
    },
    [documentId, router, workspaceId],
  );

  /** Re-reads the documents and the newest runs (and the running extractions' progress). */
  const refreshList = useCallback(async () => {
    try {
      const [docs, latest] = await Promise.all([
        documentsClient.listDocuments(workspaceId),
        importClient.listRuns(workspaceId, REVIEW_RUNS).catch(() => null),
      ]);
      setDocuments(docs);
      if (latest) setRuns(latest);
      setListFailed(false);
      const working = (latest ?? []).filter(
        (run) => run.job_id && (run.status === 'queued' || run.status === 'running'),
      );
      if (working.length === 0) return;
      const percents = await Promise.all(
        working.map(async (run) => {
          try {
            const job = await documentsClient.getJob(run.job_id ?? '');
            return [run.id, jobPercent(job.progress)] as const;
          } catch {
            return [run.id, undefined] as const;
          }
        }),
      );
      setExtraction(new Map(percents));
    } catch (error) {
      onUnauthenticated(error);
    }
  }, [documentsClient, importClient, onUnauthenticated, workspaceId]);

  // The review pane reports its checked drafts here, off the render path (UX6-SELECT).
  const reviewState = useRef({ selected: 0, registering: false });
  const onSelectionChange = useCallback((count: number, registering: boolean) => {
    reviewState.current = { selected: count, registering };
  }, []);
  const onRegistration = useCallback(
    (registration: ImportRegistration) => {
      setRegistrations((current) => {
        const next = new Map(current);
        if (isRegistrationActive(registration)) next.set(registration.import_id, registration);
        else next.delete(registration.import_id);
        return next;
      });
      // Its counts changed: the row shows the server's.
      if (!isRegistrationActive(registration)) void refreshList();
    },
    [refreshList],
  );

  // The pane's run (e.g. a failed extraction retried there): the row and the phone button follow
  // it, and a running one is polled like any other.
  const onRunChange = useCallback((changed: ImportRun) => {
    setRuns((current) => {
      const index = current.findIndex((r) => r.id === changed.id);
      if (index < 0) return [changed, ...current];
      if (current[index] === changed) return current;
      return current.map((r, i) => (i === index ? changed : r));
    });
  }, []);

  // Registrations of PDFs no longer on screen continue on the server: follow them for the row.
  const followed = useMemo(
    () => [...registrations.values()].filter((r) => r.import_id !== paneRunId),
    [paneRunId, registrations],
  );
  const needsPolling = reviewPdfsInProgress(pdfs) || followed.length > 0;
  useEffect(() => {
    if (!needsPolling) return;
    const timer = setInterval(() => {
      void refreshList();
      for (const registration of followed) {
        void importClient
          .getRegistration(registration.import_id, registration.job_id)
          .then(onRegistration)
          .catch(() => undefined);
      }
    }, pollMs);
    return () => clearInterval(timer);
  }, [followed, importClient, needsPolling, onRegistration, pollMs, refreshList]);

  // The chosen PDF got its first extraction (processed, or 문제 추출): render its review.
  const refreshedFor = useRef<string | null>(null);
  const selectedRunId = selected?.run?.id ?? null;
  useEffect(() => {
    if (review?.run || !selectedRunId || refreshedFor.current === selectedRunId) return;
    refreshedFor.current = selectedRunId;
    router.refresh();
  }, [review, router, selectedRunId]);

  // Opened without `?document=`: the address names the PDF shown, replacing the entry (Next syncs
  // its router with a native replaceState).
  useEffect(() => {
    if (!writeDocumentParam || !documentId) return;
    window.history.replaceState(null, '', importPath(workspaceId, documentId));
  }, [documentId, workspaceId, writeDocumentParam]);

  // After a switch (a row, Back or Forward) focus goes to the new review's title; not on load.
  const shownId = useRef(documentId);
  useEffect(() => {
    if (shownId.current === documentId) return;
    shownId.current = documentId;
    heading.current?.focus();
  }, [documentId]);

  const go = useCallback(
    (next: string) => {
      setSheetOpen(false);
      startSwitch(() => router.push(importPath(workspaceId, next), { scroll: false }));
    },
    [router, workspaceId],
  );

  const choose = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, next: string) => {
      if (!isPlainClick(event)) return;
      event.preventDefault();
      if (next === documentId) {
        setSheetOpen(false);
        return;
      }
      const { selected: count, registering } = reviewState.current;
      // A running registration continues on the server (QIMPORT-01-AC07): no question.
      if (count > 0 && !registering) {
        setPendingSwitch({ documentId: next, count });
        return;
      }
      go(next);
    },
    [documentId, go],
  );

  async function extract(pdf: ReviewPdf) {
    if (starting) return;
    setStarting(pdf.documentId);
    setStartFailure(null);
    try {
      await importClient.startImport(workspaceId, pdf.documentId, crypto.randomUUID());
      // The list then shows its run; the chosen PDF's review follows (effect above).
      await refreshList();
    } catch (error) {
      if (onUnauthenticated(error)) return;
      const message = error instanceof ImportApiError ? error.message : String(error);
      setStartFailure(`‘${pdf.title}’ 문제 추출을 시작하지 못했습니다. ${message}`);
      void refreshList();
    } finally {
      setStarting(null);
    }
  }

  async function reload() {
    setReloading(true);
    try {
      await refreshList();
    } finally {
      setReloading(false);
    }
  }

  const header = (
    <PageHeader
      back={<WorkspaceBackLink workspaceId={workspaceId} />}
      breadcrumb={
        <WorkspaceBreadcrumb
          workspace={{ id: workspaceId, name: workspaceName }}
          trail={[{ label: '문제 PDF 가져오기' }]}
        />
      }
      title="문제 PDF 가져오기"
      description="문서 관리에서 올린 PDF에서 추출한 문제를 검토합니다. 원본과 비교해 승인한 문제만 문제은행에 등록됩니다. 정답지에 없는 정답은 만들지 않습니다."
    />
  );
  const readOnlyNote = readOnly ? (
    <p className={importStyles.readOnly}>{READ_ONLY_TEXT[readOnly]}</p>
  ) : null;

  // No PDF to review: the empty state across the page (no list).
  if (pdfs.length === 0 && !listFailed && review?.run == null) {
    return (
      <div className={styles.screen}>
        {header}
        {readOnlyNote}
        <EmptyState
          title="추출된 문제가 없습니다"
          description={
            canEdit
              ? '문서 관리에서 PDF를 올리면 문제가 있는 PDF는 자동으로 추출됩니다.'
              : '이 Workspace에서 추출된 문제 PDF가 아직 없습니다.'
          }
          action={
            canEdit ? (
              <Button variant="primary" asChild>
                <Link href={workspaceHomePath(workspaceId, 'panel=documents')}>문서 관리 열기</Link>
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const selectedState = selected ? reviewPdfState(selected, live) : null;
  const reviewTitle = notFound
    ? 'PDF를 찾을 수 없습니다.'
    : (selected?.title ?? review?.run?.document_title ?? '검토');

  const list = (
    <ReviewPdfRows
      pdfs={pdfs}
      rows={rows}
      live={live}
      workspaceId={workspaceId}
      currentId={documentId}
      canEdit={canEdit}
      starting={starting}
      onChoose={choose}
      onExtract={(pdf) => void extract(pdf)}
    />
  );
  const listAlerts = (
    <>
      {listFailed ? (
        <div role="alert" className={styles.listAlert}>
          <p>검토할 PDF 목록을 불러오지 못했습니다.</p>
          <Button size="sm" onClick={() => void reload()} loading={reloading}>
            목록 새로고침
          </Button>
        </div>
      ) : null}
      {startFailure ? (
        <p role="alert" className={styles.listAlert}>
          {startFailure}
        </p>
      ) : null}
    </>
  );

  return (
    <div className={styles.screen}>
      {header}
      {readOnlyNote}
      <div className={styles.columns}>
        <nav aria-label="검토할 PDF" className={styles.listColumn}>
          <h2 className={styles.listTitle}>검토할 PDF ({pdfs.length})</h2>
          {listAlerts}
          {list}
        </nav>
        <div className={styles.reviewColumn}>
          <FloatingSidePanel
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            title="검토할 PDF"
            mobileLayout="sheet"
            size="narrow"
            trigger={
              <button type="button" className={styles.sheetButton}>
                <span className={styles.sheetLabel}>검토할 PDF</span>
                <span className={styles.sheetTitle}>
                  {selected?.title ?? (notFound ? 'PDF를 고르세요' : reviewTitle)}
                </span>
                {selectedState ? (
                  <span className={styles.sheetState}>{reviewPdfStateText(selectedState)}</span>
                ) : null}
              </button>
            }
          >
            {listAlerts}
            {list}
          </FloatingSidePanel>
          <section
            className={styles.review}
            aria-labelledby={REVIEW_TITLE_ID}
            aria-busy={switching || undefined}
          >
            <h2 id={REVIEW_TITLE_ID} ref={heading} tabIndex={-1} className={styles.reviewTitle}>
              {reviewTitle}
            </h2>
            {notFound ? (
              <p className={styles.note}>
                이 Workspace의 검토할 PDF가 아닙니다. 목록에서 PDF를 고르세요.
              </p>
            ) : review ? (
              <ReviewPane
                key={`${documentId ?? ''}:${review.run?.id ?? ''}`}
                workspaceId={workspaceId}
                readOnly={readOnly}
                initialRun={review.run}
                initialDrafts={review.drafts}
                initialSummaries={review.summaries}
                initialChapters={review.chapters}
                loadedAt={review.loadedAt}
                documentId={documentId ?? undefined}
                loadFailed={review.loadFailed}
                onSelectionChange={onSelectionChange}
                onRegistration={onRegistration}
                onRunChange={onRunChange}
              />
            ) : selected && selectedState ? (
              <NotExtracted
                pdf={selected}
                row={rows[pdfs.indexOf(selected)]}
                state={selectedState}
                canEdit={canEdit}
                starting={starting === selected.documentId}
                onExtract={() => void extract(selected)}
              />
            ) : null}
          </section>
        </div>
      </div>
      <ConfirmDialog
        open={pendingSwitch !== null}
        onOpenChange={(open) => {
          if (!open) setPendingSwitch(null);
        }}
        title="검토할 PDF 바꾸기"
        description={`선택한 초안 ${pendingSwitch?.count ?? 0}개의 선택이 사라집니다. 다른 PDF로 바꿀까요?`}
        confirmLabel="바꾸기"
        onConfirm={() => {
          const next = pendingSwitch?.documentId;
          setPendingSwitch(null);
          if (next) go(next);
        }}
      />
    </div>
  );
}

interface ReviewPdfRowsProps {
  readonly pdfs: readonly ReviewPdf[];
  readonly rows: readonly DocumentRow[];
  readonly live: ReviewPdfLive;
  readonly workspaceId: string;
  readonly currentId: string | null;
  readonly canEdit: boolean;
  readonly starting: string | null;
  readonly onChoose: (event: MouseEvent<HTMLAnchorElement>, documentId: string) => void;
  readonly onExtract: (pdf: ReviewPdf) => void;
}

/** The `검토할 PDF` rows: 문서 관리's row part, linking to each PDF's review. */
function ReviewPdfRows({
  pdfs,
  rows,
  live,
  workspaceId,
  currentId,
  canEdit,
  starting,
  onChoose,
  onExtract,
}: ReviewPdfRowsProps) {
  return (
    <ul className={styles.list}>
      {pdfs.map((pdf, index) => {
        const row = rows[index];
        if (!row) return null;
        const state = reviewPdfState(pdf, live);
        const extractable =
          canEdit && state.kind === 'notExtracted' && pdf.document.status === 'ready';
        return (
          <DocumentRowItem
            key={pdf.documentId}
            row={row}
            workspaceId={workspaceId}
            canEdit={canEdit}
            compact
            titleLink={{
              href: importPath(workspaceId, pdf.documentId),
              current: pdf.documentId === currentId,
              onClick: (event) => onChoose(event, pdf.documentId),
            }}
            state={rowState(state)}
            actions={
              extractable ? (
                <Button
                  size="sm"
                  variant="primary"
                  aria-label={`${pdf.title} 문제 추출`}
                  loading={starting === pdf.documentId}
                  disabled={starting !== null && starting !== pdf.documentId}
                  onClick={() => onExtract(pdf)}
                >
                  문제 추출
                </Button>
              ) : undefined
            }
          />
        );
      })}
    </ul>
  );
}

/** The chosen PDF has no extraction yet: why, and `문제 추출` for editors. */
function NotExtracted({
  pdf,
  row,
  state,
  canEdit,
  starting,
  onExtract,
}: {
  readonly pdf: ReviewPdf;
  readonly row: DocumentRow | undefined;
  readonly state: ReviewPdfState;
  readonly canEdit: boolean;
  readonly starting: boolean;
  readonly onExtract: () => void;
}) {
  if (state.kind === 'processing') {
    return (
      <p className={styles.note}>
        아직 추출하지 않았습니다. PDF를 처리하는 중이며, 처리가 끝나면 문제가 있는 PDF는 자동으로
        추출됩니다.
      </p>
    );
  }
  if (state.kind === 'processingFailed') {
    return (
      <p className={styles.note}>
        아직 추출하지 않았습니다. PDF를 처리하지 못했습니다.{row?.error ? ` ${row.error}` : ''}
      </p>
    );
  }
  return (
    <div className={styles.notExtracted}>
      <p className={styles.note}>아직 추출하지 않았습니다.</p>
      {canEdit && pdf.document.status === 'ready' ? (
        <Button
          variant="primary"
          aria-label={`${pdf.title} 문제 추출`}
          loading={starting}
          onClick={onExtract}
        >
          문제 추출
        </Button>
      ) : null}
    </div>
  );
}

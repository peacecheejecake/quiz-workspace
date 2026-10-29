'use client';

// `DocumentSummaryPanel` (DOCSUM-01, docs/screens/documents-summary.md): the non-modal
// FloatingSidePanel "문서 요약" over the workspace home (`?panel=document-summary&document=<id>`).
// It opens at once (an `aria-busy` skeleton while the state loads) and polls the summary state
// while open — quickly while a run is queued/running, slowly otherwise, so a run started by a
// publish elsewhere shows up without a reload. States are text, never colour alone:
//   - no summary: "아직 요약이 없습니다." (+ for editors the AI-service notice and `요약 만들기`,
//     aria-disabled with its reason when this environment has no summaries);
//   - queued/running: "요약 대기 중" / "요약을 만드는 중 · 장별 요약 k/n" with a progress bar;
//   - failed: an alert with the reason (+ `다시 시도` for editors);
//   - an older revision's summary: a `role=status` notice "이전 발행본 기준 요약입니다." (+ running /
//     failed suffix) above it;
//   - the auto-refresh line (켜짐 / 꺼짐) under a summary, with `자동 갱신 끄기` (ConfirmDialog) or
//     `요약 만들기` (turn it back on) for editors of an active workspace.
// Action buttons sit in the footer, after the summary (Tab: header → 전체 요약 → 장 → 동작).
import { Badge, Button, ConfirmDialog, FloatingSidePanel, ProgressBar, Skeleton } from '@quiz/ui';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type Ref } from 'react';
import {
  createSummaryClient,
  isActiveRun,
  newIdempotencyKey,
  SUMMARY_ACTION_MESSAGES,
  SUMMARY_UNAVAILABLE_REASON,
  SummaryApiError,
  summaryPanelModel,
  summaryPollMs,
  type SummaryClient,
  type SummaryState,
} from '@/lib/documents/summary';
import { SummaryContentView } from './summary-content';
import styles from './summary.module.css';

export interface DocumentSummaryPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly workspaceId: string;
  /** The document of the panel (`?document=`); null shows "문서를 찾을 수 없습니다.". */
  readonly documentId: string | null;
  /** Its title from the document list (subtitle), when known. */
  readonly documentTitle?: string | null;
  /** A 문제지 (never summarized). */
  readonly questionPaper?: boolean;
  /** Owner/editor of an active workspace. */
  readonly canEdit: boolean;
  readonly container?: HTMLElement | null;
  readonly raiseKey?: number;
  readonly screenId?: string;
  /** Element that gets focus back when the panel closes (the row's `요약` button). */
  readonly returnFocusTo?: () => HTMLElement | null;
  /** Reports whether the document has a queued/running run (the row's "요약 중"). */
  readonly onActivity?: (documentId: string, active: boolean) => void;
  readonly client?: SummaryClient;
}

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'notFound' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly state: SummaryState };

const LOADING: Load = { status: 'loading' };
const RETRY_AFTER_ERROR_MS = 5000;

/** The summary state of `documentId`, polled while mounted with a document. */
function useSummaryState(documentId: string | null, client: SummaryClient) {
  const [load, setLoad] = useState<{ readonly id: string | null; readonly value: Load }>({
    id: documentId,
    value: LOADING,
  });
  const [generation, setGeneration] = useState(0);
  let current = load;
  if (load.id !== documentId) {
    current = { id: documentId, value: LOADING };
    setLoad(current);
  }

  useEffect(() => {
    if (!documentId) return;
    let live = true;
    let timer: number | undefined;
    const controller = new AbortController();
    const poll = async () => {
      let next: number;
      try {
        const state = await client.get(documentId, controller.signal);
        if (!live) return;
        setLoad({ id: documentId, value: { status: 'ready', state } });
        next = summaryPollMs(state);
      } catch (error) {
        if (!live) return;
        if (error instanceof SummaryApiError && error.kind === 'notFound') {
          setLoad({ id: documentId, value: { status: 'notFound' } });
          return;
        }
        // Keep what is shown; a first load that fails shows the error with a reload button.
        setLoad((prev) =>
          prev.id === documentId && prev.value.status === 'ready'
            ? prev
            : { id: documentId, value: { status: 'error' } },
        );
        next = RETRY_AFTER_ERROR_MS;
      }
      timer = window.setTimeout(() => void poll(), next);
    };
    void poll();
    return () => {
      live = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [client, documentId, generation]);

  const replace = useCallback(
    (state: SummaryState) => {
      setLoad({ id: documentId, value: { status: 'ready', state } });
      // Restart polling at once (a new run polls quickly).
      setGeneration((g) => g + 1);
    },
    [documentId],
  );
  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  return { load: documentId ? current.value : ({ status: 'notFound' } as Load), replace, reload };
}

export function DocumentSummaryPanel({
  open,
  onOpenChange,
  workspaceId,
  documentId,
  documentTitle,
  questionPaper = false,
  canEdit,
  container,
  raiseKey,
  screenId,
  returnFocusTo,
  onActivity,
  client: injectedClient,
}: DocumentSummaryPanelProps) {
  const client = useMemo(() => injectedClient ?? createSummaryClient(), [injectedClient]);
  const summary = useSummaryState(open ? documentId : null, client);
  const shown = summary.load.status === 'ready' && summary.load.state.summary !== null;
  return (
    <FloatingSidePanel
      open={open}
      onOpenChange={onOpenChange}
      modal={false}
      container={container}
      raiseKey={raiseKey}
      title="문서 요약"
      description={documentTitle ?? undefined}
      closeLabel="문서 요약 닫기"
      headerActions={shown ? <Badge tone="accent">AI 생성</Badge> : undefined}
      mobileLayout="full"
      onCloseAutoFocus={(event) => {
        const target = returnFocusTo?.();
        if (!target?.isConnected) return;
        event.preventDefault();
        target.focus();
      }}
    >
      {open ? (
        <SummaryPanelBody
          key={documentId ?? ''}
          workspaceId={workspaceId}
          documentId={documentId}
          questionPaper={questionPaper}
          canEdit={canEdit}
          screenId={screenId}
          onActivity={onActivity}
          client={client}
          {...summary}
        />
      ) : null}
    </FloatingSidePanel>
  );
}

type Pending = 'create' | 'retry' | 'disable' | null;

function SummaryPanelBody({
  workspaceId,
  documentId,
  questionPaper,
  canEdit,
  screenId,
  onActivity,
  client,
  load,
  replace,
  reload,
}: ReturnType<typeof useSummaryState> & {
  readonly workspaceId: string;
  readonly documentId: string | null;
  readonly questionPaper: boolean;
  readonly canEdit: boolean;
  readonly screenId?: string;
  readonly onActivity?: (documentId: string, active: boolean) => void;
  readonly client: SummaryClient;
}) {
  const [pending, setPending] = useState<Pending>(null);
  const pendingRef = useRef<Pending>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** The auto-refresh line's button (끄기, or 요약 만들기 once off): focus target after the dialog. */
  const autoButtonRef = useRef<HTMLButtonElement>(null);
  const reasonId = useId();

  const state = load.status === 'ready' ? load.state : null;
  const active = state ? isActiveRun(state.run) : false;
  useEffect(() => {
    if (documentId && state) onActivity?.(documentId, active);
  }, [active, documentId, onActivity, state]);

  const act = useCallback(
    async (kind: Exclude<Pending, null>, run: () => Promise<SummaryState | null>) => {
      if (pendingRef.current || !documentId) return false;
      pendingRef.current = kind;
      setPending(kind);
      setActionError(null);
      try {
        const next = await run();
        if (next) replace(next);
        else reload();
        return true;
      } catch (error) {
        const failure = error instanceof SummaryApiError ? error.kind : 'failed';
        setActionError(SUMMARY_ACTION_MESSAGES[failure]);
        reload();
        return false;
      } finally {
        pendingRef.current = null;
        setPending(null);
      }
    },
    [documentId, reload, replace],
  );

  const create = () => {
    if (!documentId || !state?.available) return;
    void act('create', () => client.create(documentId, newIdempotencyKey()));
  };
  const retry = () => {
    if (!documentId) return;
    void act('retry', () => client.retry(documentId, newIdempotencyKey()));
  };
  const disable = async () => {
    if (!documentId) return;
    const done = await act('disable', async () => {
      await client.disableAuto(documentId);
      return null;
    });
    if (done && state) replace({ ...state, enabled: false });
    setConfirmOpen(false);
  };

  const pageHref = (page: number) =>
    `/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(
      documentId ?? '',
    )}?page=${page}`;

  if (load.status === 'loading') {
    return (
      <div className={styles.body} aria-busy="true" data-screen-id={screenId}>
        <p role="status" className={styles.note}>
          요약을 불러오는 중입니다.
        </p>
        <Skeleton shape="rect" height="1.25rem" width="60%" />
        <Skeleton shape="rect" height="5rem" />
        <Skeleton shape="rect" height="2.5rem" />
      </div>
    );
  }
  if (load.status === 'notFound') {
    return (
      <div className={styles.body} data-screen-id={screenId}>
        <p role="status" className={styles.note}>
          문서를 찾을 수 없습니다. 삭제되었거나 이 Workspace의 문서가 아닙니다.
        </p>
      </div>
    );
  }
  if (load.status === 'error' || !state) {
    return (
      <div className={styles.body} data-screen-id={screenId}>
        <div role="alert" className={styles.alert}>
          <p>요약을 불러오지 못했습니다.</p>
          <Button size="sm" onClick={reload}>
            다시 불러오기
          </Button>
        </div>
      </div>
    );
  }

  const model = summaryPanelModel(state, { canEdit, questionPaper });
  const summary = state.summary;
  const createButton = (ref?: Ref<HTMLButtonElement>) => (
    <Button
      ref={ref}
      variant="primary"
      loading={pending === 'create'}
      aria-disabled={model.unavailable || undefined}
      aria-describedby={model.unavailable ? reasonId : undefined}
      data-unavailable={model.unavailable || undefined}
      className={styles.action}
      onClick={create}
    >
      요약 만들기
    </Button>
  );
  const reason = model.unavailable ? (
    <p id={reasonId} className={styles.hint}>
      {SUMMARY_UNAVAILABLE_REASON}
    </p>
  ) : null;

  return (
    <div className={styles.body} data-screen-id={screenId}>
      {model.notice ? <p className={styles.note}>{model.notice}</p> : null}
      {model.stale ? (
        <p role="status" className={styles.stale}>
          {model.stale}
        </p>
      ) : null}
      {model.progress ? (
        <div className={styles.progress}>
          <p role="status" className={styles.statusText}>
            {model.progress.text}
          </p>
          <ProgressBar label="요약 진행률" value={model.progress.value} />
        </div>
      ) : null}
      {model.failure ? (
        <div role="alert" className={styles.alert}>
          <p className={styles.alertTitle}>요약을 만들지 못했습니다</p>
          <p>{model.failure}</p>
        </div>
      ) : null}
      {model.empty && !model.notice ? (
        <div className={styles.empty}>
          <p className={styles.statusText}>아직 요약이 없습니다.</p>
          {model.createInEmpty ? (
            <p className={styles.note}>
              요약을 만들면 이후 교정본을 발행할 때마다 요약이 자동으로 다시 만들어집니다. 본문이 AI
              서비스로 전송됩니다.
            </p>
          ) : null}
        </div>
      ) : null}
      {actionError ? (
        <p role="alert" className={styles.actionError}>
          {actionError}
        </p>
      ) : null}

      {summary ? <SummaryContentView content={summary} pageHref={pageHref} /> : null}

      {model.retry || model.createInEmpty || model.auto ? (
        <div className={styles.actions}>
          {model.retry ? (
            <Button variant="primary" loading={pending === 'retry'} onClick={retry}>
              다시 시도
            </Button>
          ) : null}
          {model.createInEmpty ? (
            <div className={styles.actionRow}>
              {createButton()}
              {reason}
            </div>
          ) : null}
          {model.auto ? (
            <div className={styles.auto}>
              {model.auto.on ? (
                <p className={styles.autoText}>
                  자동 갱신 켜짐 — 교정본을 발행하면 요약을 다시 만듭니다.
                </p>
              ) : (
                <p className={styles.autoText}>자동 갱신 꺼짐</p>
              )}
              {model.auto.action === 'disable' ? (
                <Button
                  ref={autoButtonRef}
                  size="sm"
                  disabled={pending !== null && pending !== 'disable'}
                  onClick={() => setConfirmOpen(true)}
                >
                  자동 갱신 끄기
                </Button>
              ) : model.auto.action === 'enable' ? (
                <>
                  <p className={styles.hint}>
                    다시 켜면 현재 발행본을 요약하고 이후 발행마다 다시 만듭니다.
                  </p>
                  <div className={styles.actionRow}>
                    {createButton(autoButtonRef)}
                    {reason}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="자동 갱신을 끌까요?"
        description="이후 교정본을 발행해도 요약을 다시 만들지 않고 본문을 AI 서비스로 보내지 않습니다. 지금까지 만든 요약은 그대로 남습니다."
        confirmLabel="끄기"
        onConfirm={() => void disable()}
        loading={pending === 'disable'}
        returnFocusRef={autoButtonRef}
      />
    </div>
  );
}

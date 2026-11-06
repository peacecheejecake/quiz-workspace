'use client';

// QIMPORT-01 문제 PDF 가져오기 (docs/screens/questions-import.md, docs/questions.md §6).
//
//   PDF 업로드 in 문서 관리 (UX6-UPLOAD: the one upload place; the server classifies the PDF) →
//   PDF 분석 job → import run started by the server for a PDF with questions (or 문제 추출) →
//   문제 추출 job → drafts → review on this page (편집 / 원본 비교 /
//   선택) → "선택한 문제 승인 및 등록" hands exactly the selected drafts at the versions on screen
//   to the server (POST /registrations, QIMP-JOB), whose job approves and registers them even if
//   the page is left; the screen follows its progress and reattaches on return. Checking a draft
//   or "전체 선택" is screen state only; nothing is sent until the button. With hundreds of drafts
//   it must stay instant (UX6-SELECT, QIMPORT-01-AC09): the list's callbacks are stable so a
//   selection change re-renders only the checkboxes, not every draft. The list is shown a page
//   of 100 drafts at a time (QIMP-REVIEW-SCALE: a 316-page paper yields ~750 drafts); only the
//   rendering is paged — the selection, `전체 선택`, the counts and the registration cover every
//   draft. They work on a summary of every draft (QIMP-PAGING: no question text or answers); the
//   content is read a page at a time (the first page comes with the page, the next and previous
//   ones are read ahead) and a page not read yet shows a loading state.
//
// The server starts the import itself once the PDF is processed (QIMPORT-01-AC06): a visit (or
// `?document=<id>` from a row's 문제 검토) shows the run's progress and drafts. One review per PDF
// (its newest run); since UX9 this is the right pane of the import page, whose left `검토할 PDF`
// list switches between them (QIMPORT-02, import-review-layout.tsx; the page header lives there).
//
// Nothing reaches the bank before a human approves it; a failed extraction keeps the drafts it
// already persisted and "다시 시도" retries the same run (the API reconciles, no duplicates);
// a registration whose response was lost is retried with the same Idempotency-Key.
// Drafts the server refuses (changed since, or not confirmable) stay selected and are named.
import { Badge, Button, Checkbox, EmptyState, ProgressBar } from '@quiz/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loginRedirectPath } from '@/lib/auth/routes';
import type { Job } from '@/lib/documents/client-api';
import { watchJob } from '@/lib/documents/job-events';
import { duplicateReason } from '@/lib/questions/duplicates';
import {
  approvePublishSelection,
  chapterBody,
  draftNumber,
  draftUpdateBody,
  initialSelection,
  isRegistrationActive,
  pruneSelection,
  publishedMessage,
  refusalText,
  REGISTRATION_BACKGROUND_HINT,
  registrationRefusedMessage,
  registrationFailureMessage,
  registrationProgress,
  replaceDraft,
  reviewDraftFromImport,
  selectAllScope,
  selectAllState,
  sortDrafts,
  toggleAll,
  toggleOne,
  type BookChapterOption,
  type DraftSummary,
  type ImportDraft,
  type ImportRegistration,
  type ImportRun,
  type RefusedDraft,
  type SelectedImportDraft,
  type ReviewDraft,
} from '@/lib/questions/drafts';
import { chapterPickerNodes } from '@/lib/questions/chapter-picker';
import { abortableSleep } from '@/lib/documents/job-events';
import type { QuestionFormValues } from '@/lib/questions/form';
import {
  clampDraftPage,
  DRAFT_PAGE_SIZE,
  draftPageCount,
  draftPageRange,
  pageContent,
  summaryFromImport,
  withLoaded,
  type DraftContents,
} from '@/lib/questions/draft-pages';
import { createImportClient, ImportApiError, importPath } from '@/lib/questions/import-client';
import { workspaceHomePath } from '@/lib/workspaces/home';
import { DraftEditor, type DraftSaveResult } from '../drafts/draft-editor';
import { DraftPager } from '../drafts/draft-pager';
import { QuestionDraftReview, type DraftReviewState } from '../drafts/question-draft-review';
import { DraftChapterField } from './draft-chapter-field';
import { ImportJobProgress, type ImportStep } from './import-job-progress';
import { SourceComparePanel } from './source-compare-panel';
import styles from './question-import.module.css';

export type ImportReadOnly = 'viewer' | 'archived' | null;

export interface QuestionImportProps {
  readonly workspaceId: string;
  readonly readOnly: ImportReadOnly;
  readonly initialRun: ImportRun | null;
  /**
   * Drafts with their content, in the review shape (QIMP-PAYLOAD): the first page (QIMP-PAGING),
   * or every draft when `initialSummaries` is left out.
   */
  readonly initialDrafts: readonly ReviewDraft[];
  /** Every draft of the run without its content (QIMP-PAGING); defaults to `initialDrafts`. */
  readonly initialSummaries?: readonly DraftSummary[];
  /** The workspace's book chapters (draft chapter picker, CHAPTER-MAP). */
  readonly initialChapters?: readonly BookChapterOption[];
  /** The PDF the page was opened for (`?document=`), if any. */
  readonly documentId?: string;
  readonly loadFailed: boolean;
  /**
   * The checked drafts and whether a registration runs, after every change (QIMPORT-02: switching
   * PDFs asks first while drafts are checked). Kept off the render path (UX6-SELECT).
   */
  readonly onSelectionChange?: (selected: number, registering: boolean) => void;
  /** Each state of a registration followed here, its last one included (the list's row status). */
  readonly onRegistration?: (registration: ImportRegistration) => void;
  /** The run as this pane last read it (a retried extraction starts and ends here: the row). */
  readonly onRunChange?: (run: ImportRun) => void;
  /** How often a running registration is re-read (ms); tests shorten it. */
  readonly registrationPollMs?: number;
  /**
   * When the server read the run and drafts (ISO). A registration that ended after it ended
   * while the page was on its way: its result is not in `initialDrafts` yet and is reported.
   */
  readonly loadedAt?: string;
}

export const READ_ONLY_TEXT: Readonly<Record<Exclude<ImportReadOnly, null>, string>> = {
  viewer: '읽기 전용: 보기 권한으로는 문제를 가져오거나 승인할 수 없습니다.',
  archived: '읽기 전용: 보관된 Workspace에서는 문제를 가져오거나 승인할 수 없습니다.',
};

const EXTRACT_FAILURES: Readonly<Record<string, string>> = {
  extraction_failed: '문제를 읽어 내지 못했습니다.',
  document_not_found: '원본 PDF가 삭제되었습니다.',
  cancelled: '작업이 취소되었습니다.',
};

/** What the import is doing (null = nothing in progress). */
type Activity =
  { readonly step: 'starting' } | { readonly step: 'extracting'; readonly value?: number };

/** The failed extraction and whether "다시 시도" can resume it. */
interface ImportFailure {
  readonly message: string;
  readonly retryable: boolean;
}

function extractFailureMessage(errorCode: string | null): string {
  const reason = (errorCode && EXTRACT_FAILURES[errorCode]) || '문제를 추출하지 못했습니다.';
  return `문제 추출에 실패했습니다. ${reason}${errorCode ? ` (${errorCode})` : ''} 다시 시도하면 이미 가져온 초안은 그대로 두고 나머지만 가져옵니다.`;
}

function jobPercent(job: Job): number | undefined {
  const p = job.progress;
  return typeof p === 'number' && Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : undefined;
}

function isWorking(run: ImportRun): boolean {
  return run.status === 'queued' || run.status === 'running';
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
}

export function QuestionImport({
  workspaceId,
  readOnly,
  initialRun,
  initialDrafts,
  initialSummaries,
  initialChapters = [],
  documentId,
  loadFailed,
  registrationPollMs = 1000,
  loadedAt,
  onSelectionChange,
  onRegistration,
  onRunChange,
}: QuestionImportProps) {
  const router = useRouter();
  const client = useMemo(() => createImportClient(), []);
  const canEdit = readOnly === null;

  const [run, setRun] = useState<ImportRun | null>(initialRun);
  /** Every draft (summary or loaded content): selection, counts, registration and paging. */
  const [drafts, setDrafts] = useState<DraftSummary[]>(() =>
    sortDrafts(initialSummaries ?? initialDrafts),
  );
  /** The content of the drafts read so far (QIMP-PAGING), by id. */
  const [contents, setContents] = useState<DraftContents>(
    () => new Map(initialDrafts.map((d) => [d.id, d])),
  );
  /** Pages (by first index) read since the list was last read: `failed` offers a retry. */
  const [pageLoads, setPageLoads] = useState<ReadonlyMap<number, 'done' | 'failed'>>(
    () => new Map(),
  );
  /** Drafts checked for "선택한 문제 승인 및 등록" (screen state only). */
  const [selected, setSelected] = useState<ReadonlySet<string>>(() =>
    initialSelection(initialSummaries ?? initialDrafts),
  );
  const [chapterOptions, setChapterOptions] =
    useState<readonly BookChapterOption[]>(initialChapters);
  const chapterNodes = useMemo(
    () =>
      chapterPickerNodes(
        chapterOptions.map((o) => ({
          id: o.id,
          title: o.title,
          level: o.level,
          documentId: o.document_id,
          documentTitle: o.document_title,
        })),
      ),
    [chapterOptions],
  );
  /** Drafts whose chapter change is being saved. */
  const [savingChapter, setSavingChapter] = useState<ReadonlySet<string>>(new Set());
  const [listFailed, setListFailed] = useState(loadFailed);
  const [activity, setActivity] = useState<Activity | null>(() =>
    initialRun && isWorking(initialRun) ? { step: 'extracting' } : null,
  );
  const [failure, setFailure] = useState<ImportFailure | null>(
    initialRun && (initialRun.status === 'failed' || initialRun.status === 'cancelled')
      ? { message: extractFailureMessage(initialRun.error_code), retryable: true }
      : null,
  );
  const [states, setStates] = useState<Record<string, DraftReviewState>>({});
  /** Submitting the selection, or following its server-side registration. */
  const [publishing, setPublishing] = useState(false);
  const [registration, setRegistration] = useState<ImportRegistration | null>(null);
  const [publishFailure, setPublishFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; bank: boolean } | null>(null);
  const [editing, setEditing] = useState<ReviewDraft | null>(null);
  const [editorSession, setEditorSession] = useState(0);
  const [comparing, setComparing] = useState<ReviewDraft | null>(null);
  /** The page of the draft list on screen (0-based; kept within the pages when drafts change). */
  const [page, setPage] = useState(0);
  const draftsHeading = useRef<HTMLHeadingElement | null>(null);
  /** Set by the pager below the list: focus the list heading once the new page is on screen. */
  const focusListTop = useRef(false);

  const controller = useRef<AbortController | null>(null);
  /** Idempotency-Key of the retry of a failed run, per failed job. */
  const retryKeys = useRef(new Map<string, string>());
  /** Idempotency-Key of the last registration request whose outcome is unknown (network). */
  const registerKey = useRef<{ readonly body: string; readonly key: string } | null>(null);
  const registrationController = useRef<AbortController | null>(null);
  const [reloadingList, setReloadingList] = useState(false);
  /** The page on screen, for list reloads (which read its content with the summaries). */
  const shownPage = useRef(0);
  /**
   * Pages (by first index) being read, and the abort of those reads (on leave, and when the list
   * is read again: a page read for the older list must not overwrite the newer one).
   */
  const pagesInFlight = useRef(new Set<number>());
  const pagesController = useRef<AbortController | null>(null);

  const onUnauthenticated = useCallback(
    (error: unknown) => {
      if (error instanceof ImportApiError && error.kind === 'unauthenticated') {
        router.replace(loginRedirectPath(importPath(workspaceId, documentId)));
        return true;
      }
      return false;
    },
    [documentId, router, workspaceId],
  );

  /**
   * Reads every draft's summary and the content of the page on screen (kept within the pages of
   * the new list) into state; contents read before are dropped (the next pages are read again).
   * Resolves with the page's drafts; throws when either read fails.
   */
  const readDrafts = useCallback(
    async (importId: string, signal?: AbortSignal): Promise<ReviewDraft[]> => {
      pagesController.current?.abort();
      pagesController.current = null;
      pagesInFlight.current = new Set();
      const { items, chapters } = await client.draftSummaries(importId, signal);
      const list = sortDrafts(items.map(summaryFromImport));
      const { start, end } = draftPageRange(shownPage.current, list.length);
      const page =
        end > start ? (await client.draftPage(importId, start, DRAFT_PAGE_SIZE, signal)).items : [];
      const loaded = page.map(reviewDraftFromImport);
      const next = withLoaded(list, new Map(), loaded);
      setDrafts(next.summaries);
      setContents(next.contents);
      setPageLoads(new Map(end > start ? [[start, 'done']] : []));
      setChapterOptions(chapters);
      return loaded;
    },
    [client],
  );

  const refreshDrafts = useCallback(
    async (importId: string, signal?: AbortSignal) => {
      try {
        await readDrafts(importId, signal);
        setListFailed(false);
        return true;
      } catch (error) {
        if (signal?.aborted) return false;
        if (!onUnauthenticated(error)) setListFailed(true);
        return false;
      }
    },
    [onUnauthenticated, readDrafts],
  );

  /** A draft the server returned after a write: its content and summary on screen. */
  const showUpdated = useCallback((updated: ImportDraft) => {
    const next = reviewDraftFromImport(updated);
    setDrafts((list) => replaceDraft<DraftSummary>(list, next));
    setContents((current) => new Map(current).set(next.id, next));
  }, []);

  /** Follows the run's current job to its end, then loads the run and its drafts. */
  const followRun = useCallback(
    async (current: ImportRun, signal: AbortSignal) => {
      setRun(current);
      setFailure(null);
      setActivity({ step: 'extracting' });
      if (current.job_id && isWorking(current)) {
        try {
          await watchJob(current.job_id, {
            signal,
            onJob: (job) => setActivity({ step: 'extracting', value: jobPercent(job) }),
          });
        } catch (error) {
          if (isAbort(error, signal)) return;
          // Lost the job (deleted, network): the run below tells what happened.
        }
      }
      let latest = current;
      try {
        latest = await client.getRun(current.id, signal);
      } catch (error) {
        if (isAbort(error, signal)) return;
        onUnauthenticated(error);
      }
      setRun(latest);
      await refreshDrafts(latest.id, signal);
      if (signal.aborted) return;
      setActivity(null);
      if (latest.status === 'failed' || latest.status === 'cancelled') {
        setFailure({ message: extractFailureMessage(latest.error_code), retryable: true });
      } else if (latest.status === 'succeeded') {
        setStatus({
          text: `문제 ${latest.draft_count}개를 초안으로 가져왔습니다. 검토해 선택한 문제만 승인과 함께 문제은행에 등록됩니다.`,
          bank: false,
        });
      } else {
        setFailure({
          message: '문제 추출 상태를 확인하지 못했습니다. 다시 시도해 주세요.',
          retryable: true,
        });
      }
    },
    [client, onUnauthenticated, refreshDrafts],
  );

  const newController = useCallback(() => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    return next;
  }, []);

  async function retryImport() {
    if (!failure?.retryable || !run) return;
    const { signal } = newController();
    const jobKey = run.job_id ?? run.id;
    let key = retryKeys.current.get(jobKey);
    if (!key) {
      key = crypto.randomUUID();
      retryKeys.current.set(jobKey, key);
    }
    setFailure(null);
    setActivity({ step: 'starting' });
    try {
      const retried = await client.retryImport(run.id, key);
      await followRun(retried, signal);
    } catch (error) {
      if (isAbort(error, signal) || onUnauthenticated(error)) return;
      setActivity(null);
      if (error instanceof ImportApiError && error.kind === 'notRetryable') {
        // Another tab already retried it (or it finished): follow what the run is doing now.
        try {
          await followRun(await client.getRun(run.id, signal), signal);
          return;
        } catch {
          // Fall through to the failure below.
        }
      }
      setFailure({
        message: error instanceof ImportApiError ? error.message : '다시 시도하지 못했습니다.',
        retryable: true,
      });
    }
  }

  // Resume following a run that was still working when the page loaded; stop on leave.
  useEffect(() => {
    if (initialRun && isWorking(initialRun)) {
      const { signal } = newController();
      // Outside the effect body: following the run updates state as the job reports.
      void Promise.resolve().then(() => followRun(initialRun, signal));
    }
    return () => controller.current?.abort();
    // Only once for the server-rendered run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- review -------------------------------------------------------------------------------

  async function saveDraft(
    values: QuestionFormValues,
    baseVersion: string,
  ): Promise<DraftSaveResult> {
    const target = editing;
    if (!target) return { ok: false, message: '편집할 초안이 없습니다.' };
    try {
      const updated = await client.updateDraft(target.id, draftUpdateBody(values, baseVersion));
      showUpdated(updated);
      // A content edit can make later drafts duplicates of this one, or stop them being ones
      // (UX7-DEDUP): re-read every summary and the page on screen, whose flags the server
      // recomputes (cached pages are dropped and re-read when shown).
      if (run) void refreshDrafts(run.id);
      setStates((s) => {
        const { [target.id]: _done, ...rest } = s;
        return rest;
      });
      setStatus({
        text: `${updated.question_number ?? updated.position + 1}번 초안을 저장했습니다. 선택한 문제는 '선택한 문제 승인 및 등록'으로 저장한 내용 그대로 등록됩니다.`,
        bank: false,
      });
      return { ok: true };
    } catch (error) {
      if (onUnauthenticated(error)) return { ok: false, message: '로그인이 필요합니다.' };
      if (error instanceof ImportApiError) {
        return { ok: false, message: error.message, stale: error.kind === 'staleDraft' };
      }
      return { ok: false, message: '초안을 저장하지 못했습니다. 다시 시도해 주세요.' };
    }
  }

  /** Saves the chapter a draft is registered under (CHAPTER-MAP); not content, keeps approval. */
  const runId = run?.id ?? null;
  const changeChapter = useCallback(
    async (target: ReviewDraft, chapterId: string | null) => {
      setSavingChapter((s) => new Set(s).add(target.id));
      setStates(({ [target.id]: _old, ...rest }) => rest);
      try {
        const updated = await client.updateDraft(target.id, chapterBody(target, chapterId));
        showUpdated(updated);
      } catch (error) {
        if (onUnauthenticated(error)) return;
        const message =
          error instanceof ImportApiError ? error.message : '챕터를 바꾸지 못했습니다.';
        setStates((s) => ({ ...s, [target.id]: { error: message } }));
        if (error instanceof ImportApiError && error.kind === 'staleDraft' && runId) {
          void refreshDrafts(runId);
        }
      } finally {
        setSavingChapter((s) => {
          const next = new Set(s);
          next.delete(target.id);
          return next;
        });
      }
    },
    [client, onUnauthenticated, refreshDrafts, runId, showUpdated],
  );

  async function reloadDraft(draftId: string): Promise<ReviewDraft | null> {
    if (!run) return null;
    try {
      // The draft being edited is on the page on screen.
      const items = await readDrafts(run.id);
      return items.find((d) => d.id === draftId) ?? null;
    } catch (error) {
      onUnauthenticated(error);
      return null;
    }
  }

  /**
   * "목록 새로고침" after a failed load: reads the newest run (when the first render could not)
   * and its drafts into state, and resumes following a run that is still working.
   */
  async function reloadList() {
    setReloadingList(true);
    try {
      let latest = run;
      if (!latest) {
        try {
          latest = await client.latestRun(workspaceId, undefined, documentId);
        } catch (error) {
          onUnauthenticated(error);
          return;
        }
        if (!latest) {
          setListFailed(false);
          return;
        }
        setRun(latest);
        if (latest.status === 'failed' || latest.status === 'cancelled') {
          setFailure({ message: extractFailureMessage(latest.error_code), retryable: true });
        }
      }
      if (isWorking(latest)) {
        setListFailed(false);
        void followRun(latest, newController().signal);
        return;
      }
      await refreshDrafts(latest.id);
    } finally {
      setReloadingList(false);
    }
  }

  // --- publish ------------------------------------------------------------------------------

  // The selection on screen: ids that are gone, registered or blocked are not counted or sent.
  const chosen = useMemo(() => pruneSelection(drafts, selected), [drafts, selected]);
  const selection = useMemo(() => approvePublishSelection(drafts, chosen), [drafts, chosen]);
  const allState = useMemo(() => selectAllState(drafts, chosen), [drafts, chosen]);
  const scopeCount = useMemo(() => selectAllScope(drafts).length, [drafts]);

  // Stable list callbacks: a selection change then re-renders only the checkboxes (UX6-SELECT).
  const selectDraft = useCallback(
    (draft: ReviewDraft, on: boolean) =>
      setSelected((current) => toggleOne(pruneSelection(drafts, current), draft.id, on)),
    [drafts],
  );
  const editDraft = useCallback((draft: ReviewDraft) => {
    setEditorSession((n) => n + 1);
    setEditing(draft);
  }, []);
  const sourceDocumentId = run?.source_document_id ?? null;
  const draftPageHref = useCallback(
    (draft: ReviewDraft, page: number) =>
      (draft.sourceDocumentId ?? sourceDocumentId)
        ? `/workspaces/${workspaceId}/documents/${draft.sourceDocumentId ?? sourceDocumentId}?page=${page}`
        : null,
    [sourceDocumentId, workspaceId],
  );
  const renderChapter = useCallback(
    (draft: ReviewDraft) => {
      // UX7-DEDUP (QIMPORT-01-AC10): the same question exists; a hint, not a block.
      const duplicate = duplicateReason(draft.duplicateOf);
      return (
        <>
          {duplicate ? (
            <p className={styles.duplicate}>
              <Badge tone="warning">중복</Badge> <span>{duplicate}</span>
            </p>
          ) : null}
          {draft.chapter ? (
            <DraftChapterField
              number={draftNumber(draft)}
              info={draft.chapter}
              options={chapterOptions}
              nodes={chapterNodes}
              readOnly={!canEdit || draft.publishedQuestionId !== null}
              disabled={publishing || savingChapter.has(draft.id)}
              onChange={(chapterId) => void changeChapter(draft, chapterId)}
            />
          ) : null}
        </>
      );
    },
    [canEdit, changeChapter, chapterNodes, chapterOptions, publishing, savingChapter],
  );

  function markRefused(refused: readonly RefusedDraft[]) {
    setStates((s) => {
      const next = { ...s };
      for (const r of refused) next[r.draft_id] = { error: refusalText(r.reason) };
      return next;
    });
  }

  /**
   * Follows a server-side registration until it ends (it continues without the page: leaving
   * only stops this polling), then reloads the drafts and reports what was registered/refused.
   */
  async function followRegistration(importId: string, first: ImportRegistration) {
    registrationController.current?.abort();
    const controller = new AbortController();
    registrationController.current = controller;
    const { signal } = controller;
    setPublishing(true);
    let current = first;
    setRegistration(current);
    onRegistration?.(current);
    let misses = 0;
    while (isRegistrationActive(current)) {
      try {
        await abortableSleep(registrationPollMs, signal);
        current = await client.getRegistration(importId, current.job_id, signal);
        misses = 0;
        setRegistration(current);
        onRegistration?.(current);
      } catch (error) {
        if (isAbort(error, signal)) return;
        if (onUnauthenticated(error)) return;
        misses += 1;
        if (misses >= 5) {
          setPublishing(false);
          setRegistration(null);
          setPublishFailure(
            '등록 진행 상황을 확인하지 못했습니다. 등록은 서버에서 계속되니 잠시 후 페이지를 새로 열어 확인해 주세요.',
          );
          return;
        }
      }
    }
    await refreshDrafts(importId, signal);
    if (signal.aborted) return;
    setPublishing(false);
    setRegistration(null);
    const refused = current.refused.map((r) => ({ draft_id: r.draft_id, reason: r.reason }));
    markRefused(refused);
    if (current.status !== 'succeeded') {
      setPublishFailure(registrationFailureMessage(current));
      return;
    }
    if (current.registered > 0 || refused.length === 0) {
      setStatus({ text: publishedMessage(current.registered), bank: true });
    }
    if (refused.length > 0) setPublishFailure(registrationRefusedMessage(current.refused));
  }

  /**
   * The run's registration when the page (re)opens: one still running is followed; one that
   * ended after the server read the drafts (the list on screen predates its result) is reported
   * like a registration that ends while followed (drafts reloaded, outcome and refusals shown).
   */
  async function reattachRegistration(current: ImportRun, since?: string) {
    const jobId = current.registration_job_id;
    if (!jobId) return;
    try {
      const found = await client.getRegistration(current.id, jobId);
      if (isRegistrationActive(found) || endedAfter(found, since)) {
        await followRegistration(current.id, found);
      }
    } catch (error) {
      onUnauthenticated(error);
    }
  }

  async function publish() {
    if (!run || publishing || selection.length === 0) return;
    setPublishing(true);
    setPublishFailure(null);
    setStatus(null);
    const importId = run.id;
    const sent: SelectedImportDraft[] = selection;
    const sentIds = new Set(sent.map((ref) => ref.draft_id));
    setStates((s) => Object.fromEntries(Object.entries(s).filter(([id]) => !sentIds.has(id))));
    // A retry of a request whose outcome is unknown reuses its key (the server replays it).
    const body = JSON.stringify(sent);
    const key = registerKey.current?.body === body ? registerKey.current.key : crypto.randomUUID();
    registerKey.current = { body, key };
    let submitted: ImportRegistration;
    try {
      submitted = await client.register(importId, sent, key);
    } catch (error) {
      if (onUnauthenticated(error)) return;
      const kind = error instanceof ImportApiError ? error.kind : 'unavailable';
      if (kind !== 'network') registerKey.current = null;
      if (kind === 'registrationRunning') {
        // Another tab (or an earlier visit) is registering: follow that one.
        try {
          const latest = await client.getRun(importId);
          setRun(latest);
          setPublishing(false);
          await reattachRegistration(latest);
          return;
        } catch {
          // Fall through to the failure below.
        }
      }
      setPublishing(false);
      const message =
        error instanceof ImportApiError ? error.message : '문제를 등록하지 못했습니다.';
      setPublishFailure(`선택한 문제를 등록하지 못했습니다. ${message}`);
      if (kind !== 'network' && kind !== 'unavailable') void refreshDrafts(importId);
      return;
    }
    registerKey.current = null;
    setRun((r) => (r && r.id === importId ? { ...r, registration_job_id: submitted.job_id } : r));
    await followRegistration(importId, submitted);
  }

  // Reattach to a registration that was still running when the page loaded (QIMP-JOB).
  useEffect(() => {
    if (initialRun?.registration_job_id) {
      void Promise.resolve().then(() => reattachRegistration(initialRun, loadedAt));
    }
    return () => registrationController.current?.abort();
    // Only once for the server-rendered run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- pages ---------------------------------------------------------------------------------

  const pageCount = draftPageCount(drafts.length);
  const currentPage = clampDraftPage(page, drafts.length);
  const { start: pageStart, end: pageEnd } = draftPageRange(currentPage, drafts.length);
  /** The page's drafts with their content; null until it is read (QIMP-PAGING). */
  const pageDrafts = useMemo(
    () => pageContent(drafts, contents, currentPage),
    [drafts, contents, currentPage],
  );
  const pageFailed = pageDrafts === null && pageLoads.has(pageStart);

  /** Reads one page's content (`start` = its first index); a page on screen reports a failure. */
  const loadPage = useCallback(
    async (importId: string, start: number, ids: readonly string[]) => {
      const inFlight = pagesInFlight.current;
      if (inFlight.has(start)) return;
      inFlight.add(start);
      pagesController.current ??= new AbortController();
      const { signal } = pagesController.current;
      let outcome: 'done' | 'failed' = 'failed';
      try {
        const { items } = await client.draftPage(importId, start, DRAFT_PAGE_SIZE, signal);
        // The list was read again meanwhile (its own page read replaces this one).
        if (signal.aborted) return;
        const loaded = items.map(reviewDraftFromImport);
        // The list moved under it (drafts added or removed since): `다시 시도` reads both again.
        const got = new Set(loaded.map((d) => d.id));
        if (ids.every((id) => got.has(id))) outcome = 'done';
        setDrafts((list) => withLoaded(list, new Map(), loaded).summaries);
        setContents((current) => {
          const next = new Map(current);
          for (const d of loaded) next.set(d.id, d);
          return next;
        });
      } catch (error) {
        if (signal.aborted) return;
        if (onUnauthenticated(error)) return;
      } finally {
        inFlight.delete(start);
      }
      setPageLoads((current) => new Map(current).set(start, outcome));
    },
    [client, onUnauthenticated],
  );

  // The page on screen is read when it has no content yet, then its neighbours ahead of time.
  useEffect(() => {
    shownPage.current = currentPage;
    if (!runId || drafts.length === 0) return;
    const wanted = pageDrafts === null ? [currentPage] : [currentPage + 1, currentPage - 1];
    for (const p of wanted) {
      if (p < 0 || p >= pageCount || pageContent(drafts, contents, p)) continue;
      const { start, end } = draftPageRange(p, drafts.length);
      if (pageLoads.has(start)) continue;
      const ids = drafts.slice(start, end).map((d) => d.id);
      // Outside the effect body: the read updates state when it arrives.
      void Promise.resolve().then(() => loadPage(runId, start, ids));
    }
  }, [contents, currentPage, drafts, loadPage, pageCount, pageDrafts, pageLoads, runId]);

  useEffect(() => () => pagesController.current?.abort(), []);
  const changePage = (next: number, fromBottom: boolean) => {
    focusListTop.current = fromBottom;
    setPage(next);
  };
  useEffect(() => {
    if (!focusListTop.current) return;
    focusListTop.current = false;
    const heading = draftsHeading.current;
    if (!heading) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: 'start' });
  }, [currentPage]);

  // --- render -------------------------------------------------------------------------------

  const busy = activity !== null;
  const registered = drafts.filter((d) => d.publishedQuestionId !== null).length;
  const selectedCount = selection.length;
  useEffect(
    () => onSelectionChange?.(selectedCount, publishing),
    [onSelectionChange, publishing, selectedCount],
  );
  useEffect(() => {
    if (run) onRunChange?.(run);
  }, [onRunChange, run]);
  // Gone (another PDF chosen): nothing is checked any more. A PDF without an extraction renders
  // no pane to say so; a new pane's own report runs after this cleanup.
  useEffect(() => () => onSelectionChange?.(0, false), [onSelectionChange]);

  const documentsHref = workspaceHomePath(workspaceId, 'panel=documents');
  const step: ImportStep | null = activity?.step ?? null;

  return (
    <div className={styles.screen}>
      {activity && step ? (
        <ImportJobProgress
          step={step}
          value={'value' in activity ? activity.value : undefined}
          filename={run?.document_title ?? undefined}
        />
      ) : null}

      {failure ? (
        <div role="alert" className={styles.failure}>
          <p>{failure.message}</p>
          {failure.retryable && canEdit ? (
            <Button size="sm" onClick={() => void retryImport()}>
              다시 시도
            </Button>
          ) : null}
        </div>
      ) : null}

      {publishFailure ? (
        <div role="alert" className={styles.failure}>
          <p>{publishFailure}</p>
          <Button size="sm" onClick={() => void publish()} loading={publishing}>
            다시 시도
          </Button>
        </div>
      ) : null}

      {listFailed ? (
        <div role="alert" className={styles.failure}>
          <p>가져온 초안을 불러오지 못했습니다.</p>
          <Button size="sm" onClick={() => void reloadList()} loading={reloadingList}>
            목록 새로고침
          </Button>
        </div>
      ) : null}

      <div role="status" className={styles.status} data-empty={status === null || undefined}>
        {status ? (
          <p>
            {status.text}{' '}
            {status.bank ? (
              <Link href={workspaceHomePath(workspaceId)} className={styles.link}>
                홈 Heatmap에서 보기
              </Link>
            ) : null}
          </p>
        ) : null}
      </div>

      {run === null && !busy ? (
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
                <Link href={documentsHref}>문서 관리 열기</Link>
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {run !== null ? (
        <section
          className={styles.drafts}
          aria-labelledby="qimport-drafts-title"
          aria-busy={pageDrafts === null && !pageFailed ? true : undefined}
        >
          <div className={styles.draftsHeader}>
            <div>
              <h2
                id="qimport-drafts-title"
                ref={draftsHeading}
                tabIndex={-1}
                className={styles.sectionTitle}
              >
                가져온 초안 <span className={styles.count}>{drafts.length}개</span>
              </h2>
              <p className={styles.meta}>
                {run.document_title ? `${run.document_title} · ` : ''}미등록{' '}
                {drafts.length - registered}개 · 등록 {registered}개
              </p>
            </div>
            {canEdit ? (
              <Button
                variant="primary"
                onClick={() => void publish()}
                disabled={selectedCount === 0 || busy}
                loading={publishing}
              >
                선택한 문제 승인 및 등록 ({selectedCount})
              </Button>
            ) : null}
          </div>
          {canEdit && drafts.length > 0 ? (
            <div className={styles.selectionBar}>
              <Checkbox
                label={`전체 선택 (${scopeCount}개)`}
                checked={allState}
                disabled={scopeCount === 0 || publishing}
                onCheckedChange={(checked) =>
                  setSelected((current) =>
                    toggleAll(drafts, pruneSelection(drafts, current), checked === true),
                  )
                }
                description="등록되지 않았고 정답이 있으며 확인할 항목이 없는 초안을 모두 고릅니다(‘참고’ 안내만 있는 초안도 포함). 정답이 없거나 확인 항목이 있거나 이미 있는 문제와 같은(중복) 초안은 직접 골라 주세요. 고른 초안은 버튼을 눌러야 승인·등록됩니다."
              />
              <p className={styles.meta}>선택 {selectedCount}개</p>
            </div>
          ) : null}
          {registration ? <RegistrationProgress registration={registration} /> : null}
          {drafts.length === 0 && !busy ? (
            <p className={styles.meta}>아직 추출된 초안이 없습니다.</p>
          ) : null}
          {pageCount > 1 ? (
            <DraftPager
              label="초안 페이지"
              page={currentPage}
              pageCount={pageCount}
              start={pageStart}
              end={pageEnd}
              total={drafts.length}
              onPageChange={(next) => changePage(next, false)}
            />
          ) : null}
          {pageDrafts ? (
            <QuestionDraftReview
              label="가져온 초안"
              drafts={pageDrafts}
              states={states}
              readOnly={!canEdit}
              selected={chosen}
              selectionDisabled={publishing}
              onSelectChange={selectDraft}
              onEdit={editDraft}
              onCompare={setComparing}
              renderExtra={renderChapter}
              pageHref={draftPageHref}
            />
          ) : pageFailed ? (
            <div role="alert" className={styles.failure}>
              <p>
                초안 {pageStart + 1}–{pageEnd}을 불러오지 못했습니다.
              </p>
              <Button size="sm" onClick={() => void reloadList()} loading={reloadingList}>
                다시 시도
              </Button>
            </div>
          ) : (
            <p role="status" className={styles.meta}>
              초안 {pageStart + 1}–{pageEnd}을 불러오는 중입니다…
            </p>
          )}
          {pageCount > 1 ? (
            <DraftPager
              label="초안 페이지 (목록 아래)"
              page={currentPage}
              pageCount={pageCount}
              start={pageStart}
              end={pageEnd}
              total={drafts.length}
              onPageChange={(next) => changePage(next, true)}
            />
          ) : null}
        </section>
      ) : null}

      <DraftEditor
        draft={editing}
        session={editorSession}
        onClose={() => setEditing(null)}
        save={saveDraft}
        reload={reloadDraft}
      />
      <SourceComparePanel
        draft={comparing}
        drafts={pageDrafts ?? []}
        onSelect={setComparing}
        onClose={() => setComparing(null)}
      />
    </div>
  );
}

/** Tolerance between the web server's clock (page render) and the database's (job end). */
const CLOCK_SKEW_MS = 5000;

function endedAfter(registration: ImportRegistration, since: string | undefined): boolean {
  if (!since || !registration.finished_at) return false;
  const ended = Date.parse(registration.finished_at);
  const loaded = Date.parse(since);
  return Number.isFinite(ended) && Number.isFinite(loaded) && ended >= loaded - CLOCK_SKEW_MS;
}

/** Progress of "선택한 문제 승인 및 등록" on the server (QIMP-JOB). */
function RegistrationProgress({ registration }: { readonly registration: ImportRegistration }) {
  const { text, value } = registrationProgress(registration);
  return (
    <div className={styles.progressBox}>
      <p className={styles.progressText}>{text}</p>
      <ProgressBar className={styles.progress} label="등록 진행률" value={value} valueText={text} />
      <p className={styles.progressHint}>{REGISTRATION_BACKGROUND_HINT}</p>
    </div>
  );
}

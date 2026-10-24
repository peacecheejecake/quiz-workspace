'use client';

// QIMPORT-01 문제 PDF 가져오기 (docs/screens/questions-import.md, docs/questions.md §6).
//
//   PDF 업로드 (document_type question_paper, the DOC-01 upload flow) → PDF 분석 job → import run
//   (POST /question-imports, Idempotency-Key) → 문제 추출 job → drafts → review (편집 / 원본 비교 /
//   선택) → "선택한 문제 승인 및 등록" hands exactly the selected drafts at the versions on screen
//   to the server (POST /registrations, QIMP-JOB), whose job approves and registers them even if
//   the page is left; the screen follows its progress and reattaches on return. Checking a draft
//   or "전체 선택" is screen state only; nothing is sent until the button.
//
// The server starts the import itself once the PDF is processed (QIMPORT-01-AC06), so after the
// upload the page may be left: the POST then attaches to that run, and a later visit (or
// `?document=<id>` from 문제 PDF 관리) shows the run's progress and drafts.
//
// Nothing reaches the bank before a human approves it; a failed extraction keeps the drafts it
// already persisted and "다시 시도" retries the same run (the API reconciles, no duplicates);
// a registration whose response was lost is retried with the same Idempotency-Key.
// Drafts the server refuses (changed since, or not confirmable) stay selected and are named.
import { Button, Checkbox, EmptyState, PageHeader, ProgressBar } from '@quiz/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { loginRedirectPath } from '@/lib/auth/routes';
import { createDocumentsClient, type Job } from '@/lib/documents/client-api';
import { watchJob } from '@/lib/documents/job-events';
import { hashFile } from '@/lib/documents/sha256';
import { createTransfer } from '@/lib/documents/transport';
import {
  jobFailureMessage,
  newUploadItem,
  runUpload,
  uploadsReducer,
  type UploadContext,
  type UploadDeps,
  type UploadFailure,
  type UploadItem,
} from '@/lib/documents/upload-machine';
import { defaultTitle, PDF_CONTENT_TYPE, validatePdfFile } from '@/lib/documents/validation';
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
  type ImportDraft,
  type ImportRegistration,
  type ImportRun,
  type RefusedDraft,
  type SelectedImportDraft,
  type ReviewDraft,
} from '@/lib/questions/drafts';
import { abortableSleep } from '@/lib/documents/job-events';
import type { QuestionFormValues } from '@/lib/questions/form';
import { createImportClient, ImportApiError, importPath } from '@/lib/questions/import-client';
import { clearPendingImportFile, peekPendingImportFile } from '@/lib/questions/import-handoff';
import { WorkspaceBackLink, WorkspaceBreadcrumb } from '@/components/workspaces/sub-page-nav';
import { DraftEditor, type DraftSaveResult } from '../drafts/draft-editor';
import { QuestionDraftReview, type DraftReviewState } from '../drafts/question-draft-review';
import { DraftChapterField } from './draft-chapter-field';
import { ImportJobProgress, type ImportStep } from './import-job-progress';
import { SourceComparePanel } from './source-compare-panel';
import styles from './question-import.module.css';

export type ImportReadOnly = 'viewer' | 'archived' | null;

export interface QuestionImportProps {
  readonly workspaceId: string;
  /** Breadcrumb root; defaults to a generic label (unit tests). */
  readonly workspaceName?: string;
  readonly readOnly: ImportReadOnly;
  readonly initialRun: ImportRun | null;
  readonly initialDrafts: readonly ImportDraft[];
  /** The workspace's book chapters (draft chapter picker, CHAPTER-MAP). */
  readonly initialChapters?: readonly BookChapterOption[];
  /** The question paper the page was opened for (`?document=`), if any. */
  readonly documentId?: string;
  readonly loadFailed: boolean;
  /** How often a running registration is re-read (ms); tests shorten it. */
  readonly registrationPollMs?: number;
  /**
   * When the server read the run and drafts (ISO). A registration that ended after it ended
   * while the page was on its way: its result is not in `initialDrafts` yet and is reported.
   */
  readonly loadedAt?: string;
}

const READ_ONLY_TEXT: Readonly<Record<Exclude<ImportReadOnly, null>, string>> = {
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
  | { readonly step: 'uploading' | 'processing'; readonly value?: number; readonly file: string }
  | { readonly step: 'starting'; readonly file?: string }
  | { readonly step: 'extracting'; readonly value?: number };

/** The failed step and whether "다시 시도" can resume it. */
interface ImportFailure {
  readonly step: 'upload' | 'start' | 'extract';
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
  workspaceName = 'Workspace',
  readOnly,
  initialRun,
  initialDrafts,
  initialChapters = [],
  documentId,
  loadFailed,
  registrationPollMs = 1000,
  loadedAt,
}: QuestionImportProps) {
  const router = useRouter();
  const client = useMemo(() => createImportClient(), []);
  const documents = useMemo(() => createDocumentsClient(), []);
  const canEdit = readOnly === null;

  const [run, setRun] = useState<ImportRun | null>(initialRun);
  const [drafts, setDrafts] = useState<ReviewDraft[]>(() =>
    sortDrafts(initialDrafts.map(reviewDraftFromImport)),
  );
  /** Drafts checked for "선택한 문제 승인 및 등록" (screen state only). */
  const [selected, setSelected] = useState<ReadonlySet<string>>(() =>
    initialSelection(sortDrafts(initialDrafts.map(reviewDraftFromImport))),
  );
  const [chapterOptions, setChapterOptions] =
    useState<readonly BookChapterOption[]>(initialChapters);
  /** Drafts whose chapter change is being saved. */
  const [savingChapter, setSavingChapter] = useState<ReadonlySet<string>>(new Set());
  const [listFailed, setListFailed] = useState(loadFailed);
  const [activity, setActivity] = useState<Activity | null>(() =>
    initialRun && isWorking(initialRun) ? { step: 'extracting' } : null,
  );
  const [failure, setFailure] = useState<ImportFailure | null>(
    initialRun && (initialRun.status === 'failed' || initialRun.status === 'cancelled')
      ? { step: 'extract', message: extractFailureMessage(initialRun.error_code), retryable: true }
      : null,
  );
  const [fileAlert, setFileAlert] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, DraftReviewState>>({});
  /** Submitting the selection, or following its server-side registration. */
  const [publishing, setPublishing] = useState(false);
  const [registration, setRegistration] = useState<ImportRegistration | null>(null);
  const [publishFailure, setPublishFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; bank: boolean } | null>(null);
  const [editing, setEditing] = useState<ReviewDraft | null>(null);
  const [editorSession, setEditorSession] = useState(0);
  const [comparing, setComparing] = useState<ReviewDraft | null>(null);

  const [uploads, dispatchUpload] = useReducer(uploadsReducer, []);
  const upload: UploadItem | undefined = uploads[0];
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadFile = useRef<File | null>(null);
  const uploadContext = useRef<UploadContext>({});
  const controller = useRef<AbortController | null>(null);
  /** Idempotency-Key of the import start per source document (reused by retries). */
  const startKeys = useRef(new Map<string, string>());
  /** Idempotency-Key of the retry of a failed run, per failed job. */
  const retryKeys = useRef(new Map<string, string>());
  /** Idempotency-Key of the last registration request whose outcome is unknown (network). */
  const registerKey = useRef<{ readonly body: string; readonly key: string } | null>(null);
  const registrationController = useRef<AbortController | null>(null);
  const [reloadingList, setReloadingList] = useState(false);

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

  const refreshDrafts = useCallback(
    async (importId: string, signal?: AbortSignal) => {
      try {
        const { items, chapters } = await client.draftList(importId, signal);
        setDrafts(sortDrafts(items.map(reviewDraftFromImport)));
        setChapterOptions(chapters);
        setListFailed(false);
        return true;
      } catch (error) {
        if (signal?.aborted) return false;
        if (!onUnauthenticated(error)) setListFailed(true);
        return false;
      }
    },
    [client, onUnauthenticated],
  );

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
        setFailure({
          step: 'extract',
          message: extractFailureMessage(latest.error_code),
          retryable: true,
        });
      } else if (latest.status === 'succeeded') {
        setStatus({
          text: `문제 ${latest.draft_count}개를 초안으로 가져왔습니다. 검토해 선택한 문제만 승인과 함께 문제은행에 등록됩니다.`,
          bank: false,
        });
      } else {
        setFailure({
          step: 'extract',
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

  /** Starts (or replays, same key) the import of a processed question paper. */
  const startImport = useCallback(
    async (documentId: string, file: string | undefined, signal: AbortSignal) => {
      setActivity({ step: 'starting', file });
      let key = startKeys.current.get(documentId);
      if (!key) {
        key = crypto.randomUUID();
        startKeys.current.set(documentId, key);
      }
      let started: ImportRun;
      try {
        started = await client.startImport(workspaceId, documentId, key);
      } catch (error) {
        if (isAbort(error, signal)) return;
        if (onUnauthenticated(error)) return;
        if (error instanceof ImportApiError && error.kind === 'idempotencyKeyReused') {
          startKeys.current.delete(documentId);
        }
        setActivity(null);
        const message = error instanceof ImportApiError ? error.message : String(error);
        setFailure({
          step: 'start',
          message: `문제 추출을 시작하지 못했습니다. ${message}`,
          retryable: true,
        });
        return;
      }
      setDrafts([]);
      setStates({});
      setSelected(new Set());
      await followRun(started, signal);
    },
    [client, followRun, onUnauthenticated, workspaceId],
  );

  const deps = useMemo<UploadDeps>(
    () => ({
      client: documents,
      hash: (file, signal) => hashFile(file, signal),
      createTransfer,
      watchJob: (jobId, options) => watchJob(jobId, options),
    }),
    [documents],
  );

  /** Uploads (or resumes uploading) the paper, waits for its processing, then starts the import. */
  const runPaper = useCallback(
    async (item: UploadItem) => {
      const file = uploadFile.current;
      if (!file) return;
      const { signal } = newController();
      setFailure(null);
      setActivity({ step: 'uploading', file: item.filename });
      // Filled by the upload machine's actions (an object, so the closure writes stay typed).
      const outcome: { documentId?: string; job: Job | null; failure: UploadFailure | null } = {
        documentId: item.documentId,
        job: null,
        failure: null,
      };
      await runUpload({
        workspaceId,
        item,
        file,
        context: uploadContext.current,
        deps,
        signal,
        dispatch: (action) => {
          dispatchUpload(action);
          if (action.type === 'progress') {
            setActivity({
              step: 'uploading',
              file: item.filename,
              value: item.size > 0 ? Math.round((action.loaded / item.size) * 100) : undefined,
            });
          } else if (action.type === 'completed') {
            outcome.documentId = action.documentId;
            setActivity({ step: 'processing', file: item.filename });
          } else if (action.type === 'job') {
            outcome.job = action.job;
            setActivity({ step: 'processing', file: item.filename, value: jobPercent(action.job) });
          } else if (action.type === 'failed') {
            outcome.failure = action.failure;
          }
        },
      });
      if (signal.aborted) return;
      const { documentId, job, failure: reason } = outcome;
      if (reason || !documentId || job?.status !== 'succeeded') {
        setActivity(null);
        if (reason?.kind === 'unauthenticated') {
          router.replace(loginRedirectPath(importPath(workspaceId)));
          return;
        }
        setFailure({
          step: 'upload',
          message: reason
            ? reason.message
            : `${jobFailureMessage(job?.error_code)} 다른 PDF를 올려 주세요.`,
          retryable: reason?.retryable ?? false,
        });
        return;
      }
      await startImport(documentId, item.filename, signal);
    },
    [deps, newController, router, startImport, workspaceId],
  );

  function chooseFile(list: FileList | readonly File[] | null) {
    const file = list?.[0];
    if (!file || !canEdit) return;
    const check = validatePdfFile(file);
    if (!check.ok) {
      setFileAlert(`‘${file.name}’: ${check.message}`);
      return;
    }
    setFileAlert(null);
    setStatus(null);
    setPublishFailure(null);
    uploadFile.current = file;
    uploadContext.current = {};
    const item = newUploadItem(
      crypto.randomUUID(),
      file,
      defaultTitle(file.name),
      'question_paper',
    );
    dispatchUpload({ type: 'remove', localId: upload?.localId ?? '' });
    dispatchUpload({ type: 'add', item });
    void runPaper(item);
  }

  async function retryImport() {
    if (!failure?.retryable) return;
    if (failure.step === 'upload') {
      if (!upload) return;
      dispatchUpload({ type: 'retry', localId: upload.localId });
      void runPaper({ ...upload, failure: undefined, failedIn: undefined });
      return;
    }
    if (failure.step === 'start') {
      const documentId = upload?.documentId;
      if (!documentId) return;
      const { signal } = newController();
      setFailure(null);
      void startImport(documentId, upload.filename, signal);
      return;
    }
    if (!run) return;
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
        step: 'extract',
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

  // A PDF dropped on the home's "문제 PDF 관리" dialog (QIMPORT-01-AC05) starts uploading on
  // arrival. Deferred a tick so a strict-mode remount (cleanup, then the effect again) starts it
  // once; the hand-off is cleared only when the upload actually starts.
  useEffect(() => {
    const handed = canEdit ? peekPendingImportFile(workspaceId) : null;
    if (!handed) return;
    const timer = window.setTimeout(() => {
      clearPendingImportFile();
      chooseFile([handed]);
    }, 0);
    return () => window.clearTimeout(timer);
    // Only on arrival.
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
      setDrafts((list) => replaceDraft(list, reviewDraftFromImport(updated)));
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
  async function changeChapter(target: ReviewDraft, chapterId: string | null) {
    setSavingChapter((s) => new Set(s).add(target.id));
    setStates(({ [target.id]: _old, ...rest }) => rest);
    try {
      const updated = await client.updateDraft(target.id, chapterBody(target, chapterId));
      setDrafts((list) => replaceDraft(list, reviewDraftFromImport(updated)));
    } catch (error) {
      if (onUnauthenticated(error)) return;
      const message = error instanceof ImportApiError ? error.message : '챕터를 바꾸지 못했습니다.';
      setStates((s) => ({ ...s, [target.id]: { error: message } }));
      if (error instanceof ImportApiError && error.kind === 'staleDraft' && run) {
        void refreshDrafts(run.id);
      }
    } finally {
      setSavingChapter((s) => {
        const next = new Set(s);
        next.delete(target.id);
        return next;
      });
    }
  }

  async function reloadDraft(draftId: string): Promise<ReviewDraft | null> {
    if (!run) return null;
    try {
      const items = (await client.listDrafts(run.id)).map(reviewDraftFromImport);
      setDrafts(sortDrafts(items));
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
          setFailure({
            step: 'extract',
            message: extractFailureMessage(latest.error_code),
            retryable: true,
          });
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
  const chosen = pruneSelection(drafts, selected);
  const selection = approvePublishSelection(drafts, chosen);
  const allState = selectAllState(drafts, chosen);
  const scopeCount = selectAllScope(drafts).length;

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
    let misses = 0;
    while (isRegistrationActive(current)) {
      try {
        await abortableSleep(registrationPollMs, signal);
        current = await client.getRegistration(importId, current.job_id, signal);
        misses = 0;
        setRegistration(current);
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

  // --- render -------------------------------------------------------------------------------

  const busy = activity !== null;
  const registered = drafts.filter((d) => d.publishedQuestionId !== null).length;
  const selectedCount = selection.length;
  const sourceDocumentId = run?.source_document_id ?? null;

  const uploadButton = canEdit ? (
    <Button variant="primary" onClick={() => inputRef.current?.click()} disabled={busy}>
      PDF 업로드
    </Button>
  ) : null;

  const step: ImportStep | null = activity?.step ?? null;

  return (
    <div className={styles.screen}>
      <PageHeader
        back={<WorkspaceBackLink workspaceId={workspaceId} />}
        breadcrumb={
          <WorkspaceBreadcrumb
            workspace={{ id: workspaceId, name: workspaceName }}
            trail={[{ label: '문제 PDF 가져오기' }]}
          />
        }
        title="문제 PDF 가져오기"
        description="문제지 PDF를 올리면 문제를 초안으로 추출합니다. 원본과 비교해 검토하고 승인한 문제만 문제은행에 등록됩니다. 정답지에 없는 정답은 만들지 않습니다."
        actions={
          <>
            <Button asChild>
              <Link href={`/workspaces/${workspaceId}/questions/bank`}>문제은행</Link>
            </Button>
            {uploadButton}
          </>
        }
      />
      {canEdit ? (
        <input
          ref={inputRef}
          type="file"
          accept={`${PDF_CONTENT_TYPE},.pdf`}
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            chooseFile(event.target.files);
            event.target.value = '';
          }}
        />
      ) : null}

      {readOnly ? <p className={styles.readOnly}>{READ_ONLY_TEXT[readOnly]}</p> : null}

      {fileAlert ? (
        <p role="alert" className={styles.alert}>
          {fileAlert}
        </p>
      ) : null}

      {activity && step ? (
        <ImportJobProgress
          step={step}
          value={'value' in activity ? activity.value : undefined}
          filename={'file' in activity ? activity.file : undefined}
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
              <Link href={`/workspaces/${workspaceId}/questions/bank`} className={styles.link}>
                문제은행에서 보기
              </Link>
            ) : null}
          </p>
        ) : null}
      </div>

      {run === null && !busy ? (
        <EmptyState
          title="가져온 문제가 없습니다"
          description={
            canEdit
              ? '문제지 PDF(최대 50MB)를 올리면 문제마다 초안을 만들고 원본 페이지를 연결합니다.'
              : '이 Workspace에서 가져온 문제 PDF가 아직 없습니다.'
          }
        />
      ) : null}

      {run !== null ? (
        <section className={styles.drafts} aria-labelledby="qimport-drafts-title">
          <div className={styles.draftsHeader}>
            <div>
              <h2 id="qimport-drafts-title" className={styles.sectionTitle}>
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
                description="등록되지 않았고 정답이 있으며 확인할 항목이 없는 초안을 모두 고릅니다. 정답이 없거나 확인 항목이 있는 초안은 직접 골라 주세요. 고른 초안은 버튼을 눌러야 승인·등록됩니다."
              />
              <p className={styles.meta}>선택 {selectedCount}개</p>
            </div>
          ) : null}
          {registration ? <RegistrationProgress registration={registration} /> : null}
          {drafts.length === 0 && !busy ? (
            <p className={styles.meta}>아직 추출된 초안이 없습니다.</p>
          ) : null}
          <QuestionDraftReview
            label="가져온 초안"
            drafts={drafts}
            states={states}
            readOnly={!canEdit}
            selected={chosen}
            selectionDisabled={publishing}
            onSelectChange={(draft, on) =>
              setSelected((current) => toggleOne(pruneSelection(drafts, current), draft.id, on))
            }
            onEdit={(draft) => {
              setEditorSession((n) => n + 1);
              setEditing(draft);
            }}
            onCompare={setComparing}
            renderExtra={(draft) =>
              draft.chapter ? (
                <DraftChapterField
                  number={draftNumber(draft)}
                  info={draft.chapter}
                  options={chapterOptions}
                  readOnly={!canEdit || draft.publishedQuestionId !== null}
                  disabled={publishing || savingChapter.has(draft.id)}
                  onChange={(chapterId) => void changeChapter(draft, chapterId)}
                />
              ) : null
            }
            pageHref={(draft, page) =>
              (draft.sourceDocumentId ?? sourceDocumentId)
                ? `/workspaces/${workspaceId}/documents/${draft.sourceDocumentId ?? sourceDocumentId}?page=${page}`
                : null
            }
          />
        </section>
      ) : null}

      <DraftEditor
        draft={editing}
        session={editorSession}
        onClose={() => setEditing(null)}
        save={saveDraft}
        reload={reloadDraft}
      />
      <SourceComparePanel draft={comparing} onClose={() => setComparing(null)} />
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

// DOC-01 upload state machine. Pure parts (reducer, resume point, row view) are unit-tested; the
// effectful driver `runUpload` gets its I/O injected.
//
//   hashing → requesting (upload-intent) → uploading (direct Storage) → completing
//     (complete-upload, 202) → queued → processing (job events) → ready | failed
//
// Any upload step can fail; "다시 시도" resumes from the first unfinished step: the same intent
// and stored bytes are reused while valid (complete-upload is idempotent per intent), so a retry
// never creates a second document. An expired intent restarts from a new one.
import type {
  DocumentsClient,
  DocumentSummary,
  DocumentType,
  Job,
  UploadIntent,
} from './client-api';
import { DOCUMENT_FAILURE_MESSAGES, DocumentApiError, type DocumentFailureKind } from './errors';
import { JobGoneError } from './job-events';
import { HashAbortedError } from './sha256';
import { UploadAbortedError, type Transfer, type TransferFactory } from './transport';
import { PDF_CONTENT_TYPE } from './validation';

export type UploadPhase =
  | 'hashing'
  | 'requesting'
  | 'uploading'
  | 'completing'
  | 'queued'
  | 'processing'
  | 'ready'
  | 'failed';

export interface JobSnapshot {
  readonly status: Job['status'];
  readonly stage: string | null;
  readonly progress: number | null;
  readonly errorCode: string | null;
  /** When the job was queued / first started (ISO); the row shows how long it has waited. */
  readonly queuedAt: string | null;
  readonly startedAt: string | null;
}

export interface UploadFailure {
  readonly kind: DocumentFailureKind | 'job';
  readonly message: string;
  readonly retryable: boolean;
}

export interface UploadItem {
  readonly localId: string;
  readonly filename: string;
  readonly title: string;
  readonly size: number;
  readonly documentType: DocumentType;
  readonly phase: UploadPhase;
  /** Bytes sent to Storage in the current attempt. */
  readonly loaded: number;
  readonly sha256?: string;
  readonly uploadId?: string;
  /** Epoch ms after which the intent can no longer be completed. */
  readonly intentExpiresAt?: number;
  /** The bytes are in Storage (PUT/TUS finished). */
  readonly stored: boolean;
  readonly documentId?: string;
  readonly jobId?: string;
  readonly job?: JobSnapshot;
  readonly failure?: UploadFailure;
  /** Phase in which the last failure happened (the row keeps showing that step). */
  readonly failedIn?: UploadPhase;
}

export type UploadAction =
  | { readonly type: 'add'; readonly item: UploadItem }
  | { readonly type: 'hashing'; readonly localId: string }
  | { readonly type: 'hashed'; readonly localId: string; readonly sha256: string }
  | { readonly type: 'requesting'; readonly localId: string }
  | {
      readonly type: 'intent';
      readonly localId: string;
      readonly uploadId: string;
      readonly expiresAt: number;
    }
  | { readonly type: 'progress'; readonly localId: string; readonly loaded: number }
  | { readonly type: 'stored'; readonly localId: string }
  | {
      readonly type: 'completed';
      readonly localId: string;
      readonly documentId: string;
      readonly jobId: string;
    }
  | { readonly type: 'job'; readonly localId: string; readonly job: Job }
  | { readonly type: 'failed'; readonly localId: string; readonly failure: UploadFailure }
  | { readonly type: 'retry'; readonly localId: string }
  | { readonly type: 'remove'; readonly localId: string }
  | { readonly type: 'removeDocument'; readonly documentId: string };

export function newUploadItem(
  localId: string,
  file: { readonly name: string; readonly size: number },
  title: string,
  documentType: DocumentType = 'book',
): UploadItem {
  return {
    localId,
    filename: file.name,
    title,
    size: file.size,
    documentType,
    phase: 'hashing',
    loaded: 0,
    stored: false,
  };
}

export function jobSnapshot(job: Job): JobSnapshot {
  return {
    status: job.status,
    stage: job.stage ?? null,
    progress: job.progress ?? null,
    errorCode: job.error_code ?? null,
    queuedAt: job.created_at,
    startedAt: job.started_at ?? null,
  };
}

/** The list's queued/running parse job (UX3-JOB): rows this tab does not follow live. */
export function processingJobSnapshot(doc: DocumentSummary): JobSnapshot | undefined {
  const job = doc.processing_job;
  if (!job) return undefined;
  return {
    status: job.status,
    stage: job.stage ?? null,
    progress: job.progress ?? null,
    errorCode: null,
    queuedAt: job.created_at,
    startedAt: job.started_at ?? null,
  };
}

function phaseForJob(job: Job): UploadPhase {
  if (job.status === 'succeeded') return 'ready';
  if (job.status === 'failed' || job.status === 'cancelled') return 'failed';
  return job.status === 'queued' ? 'queued' : 'processing';
}

export const JOB_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  parse_failed: 'PDF를 분석하지 못했습니다. 손상되었거나 지원하지 않는 PDF일 수 있습니다.',
  source_invalid: '올바른 PDF 파일이 아닙니다.',
  source_too_large: 'PDF 파일이 너무 큽니다.',
  too_many_pages: 'PDF 쪽수가 너무 많습니다.',
  no_indexable_text: 'PDF에서 텍스트를 찾지 못했습니다.',
  indexing_failed: '검색 색인을 만들지 못했습니다.',
  document_not_found: '문서가 삭제되어 처리하지 않았습니다.',
  cancelled: '처리가 취소되었습니다.',
};

export function jobFailureMessage(errorCode: string | null | undefined): string {
  const reason = errorCode ? JOB_FAILURE_MESSAGES[errorCode] : undefined;
  return `처리 실패: ${reason ?? '문서를 처리하지 못했습니다.'}${errorCode ? ` (${errorCode})` : ''}`;
}

function update(
  state: readonly UploadItem[],
  localId: string,
  fn: (item: UploadItem) => UploadItem,
): UploadItem[] {
  return state.map((item) => (item.localId === localId ? fn(item) : item));
}

export function uploadsReducer(state: readonly UploadItem[], action: UploadAction): UploadItem[] {
  switch (action.type) {
    case 'add':
      return [action.item, ...state.filter((i) => i.localId !== action.item.localId)];
    case 'hashing':
      return update(state, action.localId, (i) => ({ ...i, phase: 'hashing' }));
    case 'hashed':
      return update(state, action.localId, (i) => ({ ...i, sha256: action.sha256 }));
    case 'requesting':
      return update(state, action.localId, (i) => ({ ...i, phase: 'requesting' }));
    case 'intent':
      return update(state, action.localId, (i) => ({
        ...i,
        phase: 'uploading',
        uploadId: action.uploadId,
        intentExpiresAt: action.expiresAt,
        stored: false,
        loaded: 0,
      }));
    case 'progress':
      return update(state, action.localId, (i) => ({
        ...i,
        phase: 'uploading',
        loaded: Math.min(Math.max(action.loaded, 0), i.size),
      }));
    case 'stored':
      return update(state, action.localId, (i) => ({
        ...i,
        phase: 'completing',
        stored: true,
        loaded: i.size,
      }));
    case 'completed':
      return update(state, action.localId, (i) => ({
        ...i,
        phase: 'queued',
        documentId: action.documentId,
        jobId: action.jobId,
      }));
    case 'job':
      return update(state, action.localId, (i) => {
        const phase = phaseForJob(action.job);
        const job = jobSnapshot(action.job);
        return {
          ...i,
          phase,
          job,
          ...(phase === 'failed'
            ? {
                failure: {
                  kind: 'job' as const,
                  message: jobFailureMessage(job.errorCode ?? action.job.status),
                  retryable: false,
                },
                failedIn: 'processing' as const,
              }
            : { failure: undefined, failedIn: undefined }),
        };
      });
    case 'failed':
      return update(state, action.localId, (i) => {
        const kind = action.failure.kind;
        return {
          ...i,
          failedIn: i.phase === 'failed' ? i.failedIn : i.phase,
          phase: 'failed',
          failure: action.failure,
          // What the next attempt can no longer reuse.
          ...(kind === 'expired' || kind === 'storage'
            ? { uploadId: undefined, intentExpiresAt: undefined, stored: false }
            : {}),
          ...(kind === 'incomplete' ? { stored: false } : {}),
        };
      });
    case 'retry':
      return update(state, action.localId, (i) =>
        i.failure?.retryable
          ? { ...i, phase: resumePhase(i), failure: undefined, failedIn: undefined, loaded: 0 }
          : i,
      );
    case 'remove':
      return state.filter((i) => i.localId !== action.localId);
    case 'removeDocument':
      return state.filter((i) => i.documentId !== action.documentId);
  }
}

/** First unfinished step of an item (where a run or a retry starts). */
export function resumePhase(item: UploadItem, now = Date.now()): UploadPhase {
  if (!item.sha256) return 'hashing';
  // Stored bytes are completed with their original intent, even past its client-side expiry.
  if (item.stored && item.uploadId && (!item.documentId || !item.jobId)) return 'completing';
  if (!item.uploadId || (item.intentExpiresAt !== undefined && item.intentExpiresAt <= now)) {
    return 'requesting';
  }
  if (!item.stored) return 'uploading';
  if (!item.documentId || !item.jobId) return 'completing';
  return item.job?.status === 'running' ? 'processing' : 'queued';
}

/** True while the upload can still be cancelled without leaving a document behind. */
export function isCancellable(item: UploadItem): boolean {
  if (item.documentId) return false;
  if (item.phase === 'failed') return item.failedIn !== 'processing';
  return item.phase === 'hashing' || item.phase === 'requesting' || item.phase === 'uploading';
}

export function toFailure(error: unknown): UploadFailure {
  if (error instanceof DocumentApiError) {
    return { kind: error.kind, message: error.message, retryable: error.retryable };
  }
  if (error instanceof JobGoneError) {
    return { kind: 'notFound', message: DOCUMENT_FAILURE_MESSAGES.notFound, retryable: false };
  }
  return { kind: 'unavailable', message: DOCUMENT_FAILURE_MESSAGES.unavailable, retryable: true };
}

export function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    error instanceof UploadAbortedError ||
    error instanceof HashAbortedError ||
    (error instanceof DOMException && error.name === 'AbortError')
  );
}

/** Per-item resources that must not live in React state (the signed URL inside the intent). */
export interface UploadContext {
  intent?: UploadIntent;
  transfer?: Transfer;
}

export interface UploadDeps {
  readonly client: DocumentsClient;
  readonly hash: (file: Blob, signal: AbortSignal) => Promise<string>;
  readonly createTransfer: TransferFactory;
  readonly watchJob: (
    jobId: string,
    options: { onJob: (job: Job) => void; signal: AbortSignal },
  ) => Promise<Job>;
  readonly now?: () => number;
}

export interface RunUploadArgs {
  readonly workspaceId: string;
  readonly item: UploadItem;
  readonly file: Blob;
  readonly context: UploadContext;
  readonly deps: UploadDeps;
  readonly dispatch: (action: UploadAction) => void;
  readonly signal: AbortSignal;
}

/**
 * Drives one item from its first unfinished step to a terminal job state. Resolves when the job
 * is terminal, the run failed (dispatched as `failed`) or it was cancelled via `signal`.
 */
export async function runUpload({
  workspaceId,
  item,
  file,
  context,
  deps,
  dispatch,
  signal,
}: RunUploadArgs): Promise<void> {
  const now = deps.now ?? Date.now;
  const id = item.localId;
  const { stored } = item;
  let { sha256, documentId, jobId } = item;
  try {
    if (!sha256) {
      dispatch({ type: 'hashing', localId: id });
      sha256 = await deps.hash(file, signal);
      dispatch({ type: 'hashed', localId: id, sha256 });
    }
    if (!documentId || !jobId) {
      // Bytes already stored under an intent: complete-upload may have committed with its
      // response lost. Always ask again with the ORIGINAL upload id — the API replays a
      // completed intent before checking expiry — and only start over after an explicit
      // `upload-expired` answer (the reducer then drops `uploadId` and `stored`).
      let uploadId = stored ? item.uploadId : undefined;
      if (!uploadId) {
        let intent = context.intent;
        const expired = item.intentExpiresAt !== undefined && item.intentExpiresAt <= now();
        // The reducer drops `uploadId` when an intent can no longer be used (expired, rejected).
        if (!intent || !item.uploadId || intent.upload_id !== item.uploadId || expired) {
          dispatch({ type: 'requesting', localId: id });
          intent = await deps.client.createUploadIntent(
            workspaceId,
            {
              filename: item.filename,
              size_bytes: item.size,
              content_type: PDF_CONTENT_TYPE,
              sha256,
              document_type: item.documentType,
            },
            signal,
          );
          context.intent = intent;
          context.transfer = undefined;
          const expiresAt = Date.parse(intent.expires_at);
          dispatch({ type: 'intent', localId: id, uploadId: intent.upload_id, expiresAt });
        }
        const transfer = context.transfer ?? deps.createTransfer(file, intent);
        context.transfer = transfer;
        dispatch({ type: 'progress', localId: id, loaded: 0 });
        await transfer.run({
          signal,
          onProgress: (loaded) => dispatch({ type: 'progress', localId: id, loaded }),
        });
        dispatch({ type: 'stored', localId: id });
        uploadId = intent.upload_id;
      }
      const done = await deps.client.completeUpload(uploadId, sha256, signal);
      documentId = done.document_id;
      jobId = done.job_id;
      // The signed URL is no longer needed once the document exists.
      context.intent = undefined;
      context.transfer = undefined;
      dispatch({ type: 'completed', localId: id, documentId, jobId });
    }
    await deps.watchJob(jobId, {
      signal,
      onJob: (job) => dispatch({ type: 'job', localId: id, job }),
    });
  } catch (error) {
    if (isCancellation(error, signal)) return;
    dispatch({ type: 'failed', localId: id, failure: toFailure(error) });
  }
}

// --- rows ---------------------------------------------------------------------------------------

export type RowStatus = 'uploading' | 'processing' | 'ready' | 'failed';

export interface DocumentRow {
  readonly key: string;
  readonly localId?: string;
  readonly documentId?: string;
  readonly title: string;
  readonly filename: string;
  readonly documentType: DocumentType;
  readonly size: number;
  readonly updatedAt?: string;
  readonly status: RowStatus;
  /** Present while bytes are (or were being) sent: upload progress of this attempt. */
  readonly upload?: {
    readonly phase: UploadPhase;
    readonly loaded: number;
    readonly total: number;
  };
  readonly job?: JobSnapshot;
  readonly error?: string;
  readonly retryable: boolean;
  readonly cancellable: boolean;
}

function uploadStatus(item: UploadItem): RowStatus {
  switch (item.phase) {
    case 'queued':
    case 'processing':
      return 'processing';
    case 'ready':
      return 'ready';
    case 'failed':
      return item.failedIn === 'processing' || item.failedIn === 'queued' ? 'failed' : 'uploading';
    default:
      return 'uploading';
  }
}

function rowFromUpload(item: UploadItem, doc?: DocumentSummary): DocumentRow {
  const status = uploadStatus(item);
  const uploading = status === 'uploading';
  return {
    key: doc ? doc.id : `local-${item.localId}`,
    localId: item.localId,
    documentId: item.documentId,
    title: doc?.title ?? item.title,
    filename: doc?.filename ?? item.filename,
    documentType: doc?.document_type ?? item.documentType,
    size: doc?.size_bytes ?? item.size,
    updatedAt: doc?.updated_at,
    status,
    upload: uploading
      ? { phase: item.failedIn ?? item.phase, loaded: item.loaded, total: item.size }
      : undefined,
    job: item.job ?? (doc ? processingJobSnapshot(doc) : undefined),
    error: item.failure?.message,
    retryable: item.failure?.retryable ?? false,
    cancellable: isCancellable(item),
  };
}

function rowFromDocument(doc: DocumentSummary): DocumentRow {
  return {
    key: doc.id,
    documentId: doc.id,
    title: doc.title,
    filename: doc.filename,
    documentType: doc.document_type,
    size: doc.size_bytes,
    updatedAt: doc.updated_at,
    status: doc.status,
    job: doc.status === 'processing' ? processingJobSnapshot(doc) : undefined,
    error: doc.status === 'failed' ? jobFailureMessage(doc.last_error) : undefined,
    retryable: false,
    cancellable: false,
  };
}

/**
 * One row per document: uploads not yet in the server list first (newest first), then the
 * server's documents. While this tab follows a document's job, its live progress is shown; a
 * terminal state from either side wins over an in-progress one.
 */
export function buildRows(
  documents: readonly DocumentSummary[],
  uploads: readonly UploadItem[],
): DocumentRow[] {
  const byDocument = new Map<string, UploadItem>();
  for (const upload of uploads) {
    if (upload.documentId) byDocument.set(upload.documentId, upload);
  }
  const listed = new Set(documents.map((d) => d.id));
  const localOnly = uploads
    .filter((u) => !u.documentId || !listed.has(u.documentId))
    .map((u) => rowFromUpload(u));
  const server = documents.map((doc) => {
    const local = byDocument.get(doc.id);
    if (!local) return rowFromDocument(doc);
    const localTerminal = local.phase === 'ready' || uploadStatus(local) === 'failed';
    const serverTerminal = doc.status === 'ready' || doc.status === 'failed';
    if (serverTerminal && !localTerminal) return rowFromDocument(doc);
    return rowFromUpload(local, doc);
  });
  return [...localOnly, ...server];
}

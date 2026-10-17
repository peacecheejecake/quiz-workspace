'use client';

// DOC-01 documents library (docs/screens/documents-library.md): list with live status, empty
// state, PDF upload (button + drag & drop) with client-side checks, direct Storage upload with
// progress / cancel / retry, then parse/index progress from the job event stream.
import { Button, ConfirmDialog, EmptyState, PageHeader, useToast } from '@quiz/ui';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type DragEvent,
  type Ref,
} from 'react';
import { createDocumentsClient, type DocumentSummary, type Job } from '@/lib/documents/client-api';
import { loginRedirectPath } from '@/lib/auth/routes';
import { DocumentApiError } from '@/lib/documents/errors';
import { watchJob } from '@/lib/documents/job-events';
import { hashFile } from '@/lib/documents/sha256';
import { createTransfer } from '@/lib/documents/transport';
import {
  buildRows,
  newUploadItem,
  runUpload,
  uploadsReducer,
  type DocumentRow,
  type UploadContext,
  type UploadDeps,
  type UploadItem,
} from '@/lib/documents/upload-machine';
import { defaultTitle, PDF_CONTENT_TYPE, validatePdfFile } from '@/lib/documents/validation';
import { DocumentRowItem } from './document-row';
import styles from './documents.module.css';

export interface DocumentsLibraryProps {
  readonly workspaceId: string;
  readonly initialDocuments: readonly DocumentSummary[];
  /** Editor+ in an active workspace; otherwise the library is read-only. */
  readonly canEdit: boolean;
  /** Why the library is read-only (shown as a note), when it is. */
  readonly readOnlyReason?: string;
  readonly loadFailed?: boolean;
}

const POLL_INTERVAL_MS = 3000;

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

export function DocumentsLibrary({
  workspaceId,
  initialDocuments,
  canEdit,
  readOnlyReason,
  loadFailed = false,
}: DocumentsLibraryProps) {
  const client = useMemo(() => createDocumentsClient(), []);
  const { toast } = useToast();
  const router = useRouter();
  const [documents, setDocuments] = useState<readonly DocumentSummary[]>(initialDocuments);
  const [listFailed, setListFailed] = useState(loadFailed);
  const [uploads, dispatch] = useReducer(uploadsReducer, []);
  const [alert, setAlert] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [dragging, setDragging] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DocumentRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const files = useRef(new Map<string, File>());
  const contexts = useRef(new Map<string, UploadContext>());
  const controllers = useRef(new Map<string, AbortController>());
  const uploadsRef = useRef(uploads);
  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  const refresh = useCallback(async () => {
    try {
      setDocuments(await client.listDocuments(workspaceId));
      setListFailed(false);
    } catch (error) {
      if (error instanceof DocumentApiError && error.kind === 'unauthenticated') {
        router.replace(loginRedirectPath(`/workspaces/${workspaceId}/documents`));
      }
    }
  }, [client, router, workspaceId]);

  const deps = useMemo<UploadDeps>(
    () => ({
      client,
      hash: (file, signal) => hashFile(file, signal),
      createTransfer,
      watchJob: (jobId, options) => watchJob(jobId, options),
    }),
    [client],
  );

  const announceJob = useCallback((item: UploadItem, job: Job) => {
    if (job.status === 'succeeded') setAnnouncement(`${item.title}: 준비 완료`);
    else if (job.status === 'failed' || job.status === 'cancelled') {
      setAnnouncement(`${item.title}: 처리 실패`);
    }
  }, []);

  const start = useCallback(
    (item: UploadItem) => {
      const file = files.current.get(item.localId);
      if (!file) return;
      const context = contexts.current.get(item.localId) ?? {};
      contexts.current.set(item.localId, context);
      const controller = new AbortController();
      controllers.current.set(item.localId, controller);
      void runUpload({
        workspaceId,
        item,
        file,
        context,
        deps,
        signal: controller.signal,
        dispatch: (action) => {
          dispatch(action);
          if (action.type === 'job') announceJob(item, action.job);
          if (action.type === 'failed') setAnnouncement(`${item.title}: ${action.failure.message}`);
        },
      }).finally(() => {
        if (controllers.current.get(item.localId) === controller) {
          controllers.current.delete(item.localId);
        }
        if (!controller.signal.aborted) void refresh();
      });
    },
    [announceJob, deps, refresh, workspaceId],
  );

  const addFiles = useCallback(
    (list: FileList | readonly File[]) => {
      if (!canEdit) return;
      let rejection: string | null = null;
      for (const file of Array.from(list)) {
        const check = validatePdfFile(file);
        if (!check.ok) {
          rejection = `‘${file.name}’: ${check.message}`;
          continue;
        }
        const item = newUploadItem(crypto.randomUUID(), file, defaultTitle(file.name));
        files.current.set(item.localId, file);
        dispatch({ type: 'add', item });
        start(item);
      }
      setAlert(rejection);
    },
    [canEdit, start],
  );

  const cancel = useCallback((localId: string) => {
    controllers.current.get(localId)?.abort();
    controllers.current.delete(localId);
    files.current.delete(localId);
    contexts.current.delete(localId);
    dispatch({ type: 'remove', localId });
    setAnnouncement('업로드를 취소했습니다.');
    uploadButtonRef.current?.focus();
  }, []);

  const retry = useCallback(
    (localId: string) => {
      const item = uploadsRef.current.find((u) => u.localId === localId);
      if (!item?.failure?.retryable) return;
      dispatch({ type: 'retry', localId });
      start({ ...item, failure: undefined, failedIn: undefined });
    },
    [start],
  );

  async function confirmDelete() {
    const row = pendingDelete;
    if (!row?.documentId) return;
    setDeleting(true);
    try {
      await client.deleteDocument(row.documentId);
      dispatch({ type: 'removeDocument', documentId: row.documentId });
      setDocuments((docs) => docs.filter((d) => d.id !== row.documentId));
      toast({ tone: 'success', title: `‘${row.title}’ 문서를 삭제했습니다.` });
    } catch (error) {
      const message =
        error instanceof DocumentApiError ? error.message : '문서를 삭제하지 못했습니다.';
      toast({ tone: 'error', title: message });
      void refresh();
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }

  // Abort everything in flight when the page goes away.
  useEffect(() => {
    const live = controllers.current;
    return () => {
      for (const controller of live.values()) controller.abort();
      live.clear();
    };
  }, []);

  // Warn before leaving while bytes are still being sent.
  const sending = uploads.some((u) =>
    ['hashing', 'requesting', 'uploading', 'completing'].includes(u.phase),
  );
  useEffect(() => {
    if (!sending) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [sending]);

  // Polling fallback for documents this tab does not follow live (e.g. after a reload).
  const followed = new Set(
    uploads
      .filter((u) => u.documentId && (u.phase === 'queued' || u.phase === 'processing'))
      .map((u) => u.documentId),
  );
  const needsPolling = documents.some(
    (d) => (d.status === 'processing' || d.status === 'uploading') && !followed.has(d.id),
  );
  useEffect(() => {
    if (!needsPolling) return;
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [needsPolling, refresh]);

  const rows = buildRows(documents, uploads);
  const empty = rows.length === 0;

  const uploadButton = (ref?: Ref<HTMLButtonElement>) => (
    <Button ref={ref} variant="primary" onClick={() => inputRef.current?.click()}>
      PDF 업로드
    </Button>
  );

  const dropHandlers = canEdit
    ? {
        onDragEnter: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragging(true);
        },
        onDragOver: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: (event: DragEvent) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragging(false);
        },
        onDrop: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragging(false);
          addFiles(event.dataTransfer.files);
        },
      }
    : {};

  return (
    <>
      <PageHeader
        title="문서"
        description="PDF를 올리면 원문을 분석하고 검색 색인을 만듭니다. PDF는 최대 50MB까지 올릴 수 있습니다."
        actions={canEdit ? uploadButton(uploadButtonRef) : undefined}
      />
      {canEdit ? (
        <input
          ref={inputRef}
          type="file"
          accept={`${PDF_CONTENT_TYPE},.pdf`}
          multiple
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files);
            event.target.value = '';
          }}
        />
      ) : null}
      <section
        aria-label="문서 목록"
        className={styles.dropZone}
        data-dragging={dragging || undefined}
        {...dropHandlers}
      >
        {readOnlyReason ? (
          <p role="note" className={styles.note}>
            {readOnlyReason}
          </p>
        ) : null}
        {alert ? (
          <p role="alert" className={styles.alert}>
            {alert}
          </p>
        ) : null}
        {listFailed ? (
          <p role="alert" className={styles.alert}>
            문서 목록을 불러오지 못했습니다.{' '}
            <Button size="sm" onClick={() => void refresh()}>
              목록 새로고침
            </Button>
          </p>
        ) : null}
        {canEdit ? (
          <p className={styles.dropHint}>
            {dragging
              ? '놓으면 업로드를 시작합니다.'
              : 'PDF 파일을 이 영역에 끌어다 놓아도 업로드할 수 있습니다.'}
          </p>
        ) : null}
        {empty && !listFailed ? (
          <EmptyState
            title="아직 문서가 없습니다"
            description={
              canEdit
                ? 'PDF를 업로드하면 원문 검색과 문제 만들기에 사용할 수 있습니다.'
                : '이 Workspace에 업로드된 PDF가 아직 없습니다.'
            }
            action={canEdit ? uploadButton() : undefined}
          />
        ) : (
          <ul className={styles.list}>
            {rows.map((row) => (
              <DocumentRowItem
                key={row.key}
                row={row}
                workspaceId={workspaceId}
                canEdit={canEdit}
                onCancel={cancel}
                onRetry={retry}
                onDelete={setPendingDelete}
              />
            ))}
          </ul>
        )}
      </section>
      <p role="status" className="qz-visually-hidden">
        {announcement}
      </p>
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="문서를 삭제할까요?"
        description={
          pendingDelete
            ? `‘${pendingDelete.title}’ 문서가 목록과 검색에서 사라집니다. 이 작업은 되돌릴 수 없습니다.`
            : ''
        }
        confirmLabel="삭제"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}

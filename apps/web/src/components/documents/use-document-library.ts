'use client';

// DOC-01 document state for the workspace home (UX3c): the workspace's documents with live status,
// PDF uploads (client-side checks, direct Storage upload with progress / cancel / retry, then
// parse/index progress from the job event stream), the polling fallback, `종류 변경` and deletion.
// It lives in the always-mounted home, not in the "문서 관리" dialog, so closing the dialog never
// aborts an upload and the header's `문서 n` stays current. Every PDF is uploaded as `auto`
// (UX6-UPLOAD): the server classifies it, each file in its own row.
import { useToast } from '@quiz/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { loginRedirectPath } from '@/lib/auth/routes';
import {
  createDocumentsClient,
  type DocumentDetail,
  type DocumentKind,
  type DocumentSummary,
  type Job,
} from '@/lib/documents/client-api';
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
import { defaultTitle, validatePdfFile } from '@/lib/documents/validation';
import { workspaceHomePath } from '@/lib/workspaces/home';

const POLL_INTERVAL_MS = 3000;

export interface DocumentLibraryOptions {
  readonly workspaceId: string;
  readonly initialDocuments: readonly DocumentSummary[];
  /** Editor+ in an active workspace; otherwise nothing can be uploaded or deleted. */
  readonly canEdit: boolean;
  readonly loadFailed?: boolean;
}

export interface DocumentLibrary {
  readonly documents: readonly DocumentSummary[];
  /** Every row: server documents merged with this tab's uploads (both document types). */
  readonly rows: readonly DocumentRow[];
  readonly listFailed: boolean;
  /** Why the last chosen files were rejected (one message), or null. */
  readonly alert: string | null;
  /** Polite live-region text for upload/processing milestones. */
  readonly announcement: string;
  readonly refresh: () => Promise<void>;
  readonly addFiles: (files: FileList | readonly File[]) => void;
  readonly rejectFiles: (files: readonly File[]) => void;
  readonly cancel: (localId: string) => void;
  readonly retry: (localId: string) => void;
  /** `종류 변경` (DOC-01-AC08): saved at once; a refusal is kept per document. */
  readonly changeKind: (row: DocumentRow, kind: DocumentKind) => Promise<void>;
  /** Why the last kind change of a document was refused, by document id. */
  readonly kindFailures: Readonly<Record<string, string>>;
  /** The document whose kind is being saved, if any. */
  readonly changingKind: string | null;
  /** Asks to delete `row` (the home shows the confirmation). */
  readonly requestDelete: (row: DocumentRow) => void;
  readonly pendingDelete: DocumentRow | null;
  readonly deleting: boolean;
  readonly confirmDelete: () => Promise<void>;
  readonly cancelDelete: () => void;
}

export function useDocumentLibrary({
  workspaceId,
  initialDocuments,
  canEdit,
  loadFailed = false,
}: DocumentLibraryOptions): DocumentLibrary {
  const client = useMemo(() => createDocumentsClient(), []);
  const { toast } = useToast();
  const router = useRouter();
  const [documents, setDocuments] = useState<readonly DocumentSummary[]>(initialDocuments);
  const [listFailed, setListFailed] = useState(loadFailed);
  const [uploads, dispatch] = useReducer(uploadsReducer, []);
  const [alert, setAlert] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [pendingDelete, setPendingDelete] = useState<DocumentRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [kindFailures, setKindFailures] = useState<Readonly<Record<string, string>>>({});
  const [changingKind, setChangingKind] = useState<string | null>(null);
  const files = useRef(new Map<string, File>());
  const contexts = useRef(new Map<string, UploadContext>());
  const controllers = useRef(new Map<string, AbortController>());
  const uploadsRef = useRef(uploads);
  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  // A newer server render (router.refresh after a mutation elsewhere) brings a fresher list.
  const [seenInitial, setSeenInitial] = useState(initialDocuments);
  if (seenInitial !== initialDocuments) {
    setSeenInitial(initialDocuments);
    setDocuments(initialDocuments);
    setListFailed(loadFailed);
  }

  const refresh = useCallback(async () => {
    try {
      setDocuments(await client.listDocuments(workspaceId));
      setListFailed(false);
    } catch (error) {
      if (error instanceof DocumentApiError && error.kind === 'unauthenticated') {
        router.replace(loginRedirectPath(workspaceHomePath(workspaceId, 'panel=documents')));
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

  /** Files the drop target filtered out by type: same message as the client-side check. */
  const rejectFiles = useCallback((list: readonly File[]) => {
    const file = list[0];
    if (!file) return;
    const check = validatePdfFile(file);
    setAlert(`‘${file.name}’: ${check.ok ? 'PDF 파일만 올릴 수 있습니다.' : check.message}`);
  }, []);

  const cancel = useCallback((localId: string) => {
    controllers.current.get(localId)?.abort();
    controllers.current.delete(localId);
    files.current.delete(localId);
    contexts.current.delete(localId);
    dispatch({ type: 'remove', localId });
    setAnnouncement('업로드를 취소했습니다.');
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

  const confirmDelete = useCallback(async () => {
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
  }, [client, pendingDelete, refresh, toast]);

  // `종류 변경` is serialised per document and the last choice wins (Codex P2): a pick made while
  // an earlier one is still being saved is sent once that one has answered, compared with the kind
  // the server reported then — not with the row's kind from before the first pick — even when the
  // earlier one was refused; a refusal is shown only when it is the final outcome.
  const wantedKind = useRef(new Map<string, DocumentKind>());
  const savingKind = useRef(new Set<string>());
  const changeKind = useCallback(
    async (row: DocumentRow, kind: DocumentKind) => {
      const documentId = row.documentId;
      if (!canEdit || !documentId || row.status !== 'ready') return;
      setKindFailures(({ [documentId]: _old, ...rest }) => rest);
      wantedKind.current.set(documentId, kind);
      if (savingKind.current.has(documentId)) return; // the running save sends it next
      savingKind.current.add(documentId);
      setChangingKind(documentId);
      let current = row.kind;
      let changed = false;
      try {
        for (;;) {
          const target = wantedKind.current.get(documentId);
          if (target === undefined || target === current) break;
          try {
            const updated = await client.updateDocumentKind(documentId, target);
            current = updated.kind ?? target;
            changed = true;
            setDocuments((docs) =>
              docs.map((d) => (d.id === documentId ? summaryOf(updated, d) : d)),
            );
          } catch (error) {
            if (error instanceof DocumentApiError && error.kind === 'unauthenticated') {
              router.replace(loginRedirectPath(workspaceHomePath(workspaceId, 'panel=documents')));
              return;
            }
            // A different pick made meanwhile replaces the refused one: send it, and show no
            // reason for a choice the user already moved on from.
            if (wantedKind.current.get(documentId) !== target) continue;
            const message =
              error instanceof DocumentApiError ? error.message : '종류를 바꾸지 못했습니다.';
            setKindFailures((failures) => ({ ...failures, [documentId]: message }));
            void refresh();
            break;
          }
        }
        if (changed) {
          setAnnouncement(`${row.title}: 종류를 바꿨습니다.`);
          // Chapter choices and search scopes rendered by the server follow the new kind.
          router.refresh();
        }
      } finally {
        wantedKind.current.delete(documentId);
        savingKind.current.delete(documentId);
        setChangingKind(null);
      }
    },
    [canEdit, client, refresh, router, workspaceId],
  );

  // Abort everything in flight when the home goes away.
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

  return {
    documents,
    rows: buildRows(documents, uploads),
    listFailed,
    alert,
    announcement,
    refresh,
    addFiles,
    rejectFiles,
    cancel,
    retry,
    changeKind,
    kindFailures,
    changingKind,
    requestDelete: setPendingDelete,
    pendingDelete,
    deleting,
    confirmDelete,
    cancelDelete: () => setPendingDelete(null),
  };
}

/** The list entry after `종류 변경`: the detail's summary fields over the listed ones. */
function summaryOf(detail: DocumentDetail, listed: DocumentSummary): DocumentSummary {
  const { active_revision: _active, latest_revision: _latest, ...summary } = detail;
  return { ...listed, ...summary };
}

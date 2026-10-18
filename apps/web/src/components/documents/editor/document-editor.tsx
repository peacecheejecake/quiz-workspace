'use client';

// DOC-02 PDF 열람·원문 교정 (docs/screens/documents-editor.md): outline tree · PDF.js viewer ·
// canonical text pane side by side (tabs on mobile). Readers (viewer role, archived workspace)
// see the active published revision without edit controls; editors see the latest revision (the
// correction draft when there is one), correct blocks inline, publish the draft (index job
// followed live) and roll back from the revision history. FastAPI decides every write.
import { Button, PageHeader } from '@quiz/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { loginRedirectPath } from '@/lib/auth/routes';
import { blockEditReducer, IDLE, type BlockEditState } from '@/lib/documents/block-edit';
import {
  createEditorClient,
  EditorApiError,
  type ContentBlock,
  type ContentRevision,
  type DocumentContent,
  type DocumentDetail,
  type OutlineItem,
  type RevisionHistoryItem,
} from '@/lib/documents/editor-api';
import { JobGoneError, watchJob } from '@/lib/documents/job-events';
import {
  applySavedBlock,
  blockPage,
  locationsOn,
  sectionOf,
  targetBlockFor,
  viewerSearch,
} from '@/lib/documents/outline';
import { loadPdfBytes, SignedUrlCache } from '@/lib/documents/pdf-source';
import {
  INDEX_FAILURE_MESSAGE,
  isDraft,
  isPublishing,
  pinnedStatusText,
  PUBLISH_IDLE,
  resumePublishState,
  revisionStatusText,
  type PublishState,
} from '@/lib/documents/publish-state';
import styles from './editor.module.css';
import { OutlineTree } from './outline-tree';
import { PdfViewer } from './pdf-viewer';
import { PublishBar } from './publish-bar';
import { TextBlockEditor } from './text-block-editor';

export interface DocumentEditorProps {
  readonly workspaceId: string;
  readonly document: DocumentDetail;
  /** Editor+ in an active workspace (the API still decides every write). */
  readonly canEdit: boolean;
  /** Why the screen is read-only, when it is (viewer role; archived has its own banner). */
  readonly readOnlyReason?: string;
  /** `?page=N` deep link (source links, search hits). */
  readonly initialPage: number | null;
  /** `?block=<id>` deep link. */
  readonly initialBlockId: string | null;
  /**
   * `?revision=<id>` when it differs from what the screen shows by default (a search hit's
   * published revision): that revision is shown read-only with a way back to the latest text.
   */
  readonly pinnedRevisionId?: string | null;
}

type MobileView = 'outline' | 'pdf' | 'text';

/** Reloads overtaken by newer saves before the screen asks the user to reload. */
const MAX_SUPERSEDED_RELOADS = 3;

const MOBILE_VIEWS: readonly { id: MobileView; label: string }[] = [
  { id: 'outline', label: '목차' },
  { id: 'pdf', label: 'PDF' },
  { id: 'text', label: '원문' },
];

type ContentState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly content: DocumentContent };

export function DocumentEditor({
  workspaceId,
  document: initialDocument,
  canEdit: initialCanEdit,
  readOnlyReason,
  initialPage,
  initialBlockId,
  pinnedRevisionId = null,
}: DocumentEditorProps) {
  const client = useMemo(() => createEditorClient(), []);
  const router = useRouter();
  const documentId = initialDocument.id;
  const documentPath = `/workspaces/${workspaceId}/documents/${documentId}`;
  const pdfSource = useMemo(() => {
    const urls = new SignedUrlCache((signal) => client.getSourceUrl(documentId, signal));
    return (signal: AbortSignal) => loadPdfBytes(urls, { signal });
  }, [client, documentId]);

  const [document, setDocument] = useState(initialDocument);
  const [canEdit, setCanEdit] = useState(initialCanEdit);
  const pinned = pinnedRevisionId !== null;
  /** Corrections go to the draft, so a pinned (search-hit) revision is read-only. */
  const editable = canEdit && !pinned;
  const ready = document.active_revision_id !== null;
  const selector: ContentRevision = pinnedRevisionId ?? (canEdit ? 'latest' : 'active');

  const [contentState, setContentState] = useState<ContentState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [page, setPage] = useState(initialPage ?? 1);
  const [currentBlockId, setCurrentBlockId] = useState<string | null>(null);
  /** Block named in `?block=`: the current selection, cleared by pure page navigation. */
  const [linkedBlockId, setLinkedBlockId] = useState<string | null>(initialBlockId);
  /** The text shown may be behind the server after a save (refresh failed): offer a retry. */
  const [staleContent, setStaleContent] = useState(false);
  const [highlightKey, setHighlightKey] = useState(0);
  const [editState, dispatchEdit] = useReducer(blockEditReducer, IDLE);
  const [justSaved, setJustSaved] = useState(false);
  const [publish, setPublish] = useState<PublishState>(PUBLISH_IDLE);
  const [revisions, setRevisions] = useState<readonly RevisionHistoryItem[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [mobileView, setMobileView] = useState<MobileView>('pdf');
  const deepLinkApplied = useRef(false);
  const watchController = useRef<AbortController | null>(null);
  const editStateRef = useRef<BlockEditState>(editState);
  useEffect(() => {
    editStateRef.current = editState;
  }, [editState]);
  const revisionIdRef = useRef<string | null>(null);

  const content = contentState.status === 'ready' ? contentState.content : null;
  useEffect(() => {
    revisionIdRef.current = content?.revision?.id ?? null;
  }, [content]);
  const blocks = useMemo(() => content?.blocks ?? [], [content]);
  const outline = useMemo(() => content?.outline ?? [], [content]);
  const currentBlock = useMemo(
    () => blocks.find((b) => b.block_id === currentBlockId),
    [blocks, currentBlockId],
  );

  const toLogin = useCallback(
    () => router.replace(loginRedirectPath(documentPath)),
    [documentPath, router],
  );

  /** Handles answers every action shares; returns true when the error was consumed. */
  const handleCommonError = useCallback(
    (error: unknown): boolean => {
      if (!(error instanceof EditorApiError)) return false;
      if (error.kind === 'unauthenticated') {
        toLogin();
        return true;
      }
      if (error.kind === 'archived' || error.kind === 'forbidden') {
        // The server says we cannot write (role changed, workspace archived): go read-only.
        setCanEdit(false);
        setNotice(error.message);
        return true;
      }
      return false;
    },
    [toLogin],
  );

  /** Text-pane scroll is only wanted when the selection did not come from that pane. */
  const scrollTextOnSelect = useRef(false);

  // Deep link (`?block=` or `?page=`), applied once to the first text that arrives.
  const applyDeepLink = useCallback(
    (loadedBlocks: readonly ContentBlock[]) => {
      if (deepLinkApplied.current) return;
      deepLinkApplied.current = true;
      const byId = initialBlockId
        ? loadedBlocks.find((b) => b.block_id === initialBlockId)
        : undefined;
      const onPage =
        !byId && initialPage !== null
          ? loadedBlocks.find((b) => blockPage(b) === initialPage)
          : undefined;
      const target = byId ?? onPage;
      if (!target) return;
      scrollTextOnSelect.current = true;
      setCurrentBlockId(target.block_id);
      setLinkedBlockId(target.block_id);
      if (byId) setPage(blockPage(byId));
      setHighlightKey((k) => k + 1);
    },
    [initialBlockId, initialPage],
  );

  // --- loading ---------------------------------------------------------------------------------

  // Every local content change the server already has (a saved correction, a restore) bumps the
  // generation. A full load captures it when it starts and is applied only if nothing changed in
  // between; otherwise its snapshot may predate that change and would overwrite newer text.
  const contentGeneration = useRef(0);
  /** Loads `selector`'s content; null when a newer local change superseded this load. */
  const loadFresh = useCallback(
    async (selectorToLoad: ContentRevision, signal?: AbortSignal) => {
      const generation = contentGeneration.current;
      const loaded = await client.loadContent(documentId, selectorToLoad, signal);
      return generation === contentGeneration.current ? loaded : null;
    },
    [client, documentId],
  );

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    loadFresh(selector, controller.signal)
      .then((loaded) => {
        if (loaded === null) return; // a save landed meanwhile; it keeps its own content
        setContentState({ status: 'ready', content: loaded });
        applyDeepLink(loaded.blocks);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof EditorApiError && error.kind === 'unauthenticated') return toLogin();
        if (
          error instanceof EditorApiError &&
          error.kind === 'forbidden' &&
          selector === 'latest'
        ) {
          setCanEdit(false); // drafts are for editors only: fall back to the published text
          return;
        }
        setContentState({
          status: 'error',
          message:
            error instanceof EditorApiError
              ? error.message
              : '원문을 불러오지 못했습니다. 다시 시도해 주세요.',
        });
      });
    return () => controller.abort();
  }, [applyDeepLink, loadFresh, ready, reloadKey, selector, toLogin]);

  const refreshRevisions = useCallback(async () => {
    if (!editable) return null;
    try {
      const items = await client.listRevisions(documentId);
      setRevisions(items);
      return items;
    } catch (error) {
      handleCommonError(error);
      return null;
    }
  }, [editable, client, documentId, handleCommonError]);

  const refreshDocument = useCallback(async () => {
    try {
      setDocument(await client.getDocument(documentId));
    } catch (error) {
      handleCommonError(error);
    }
  }, [client, documentId, handleCommonError]);

  // --- selection & navigation ------------------------------------------------------------------

  const selectBlock = useCallback(
    (
      block: ContentBlock,
      { view, scrollText = false }: { view?: MobileView; scrollText?: boolean } = {},
    ) => {
      scrollTextOnSelect.current = scrollText;
      setCurrentBlockId(block.block_id);
      setLinkedBlockId(block.block_id);
      setPage(blockPage(block));
      setHighlightKey((k) => k + 1);
      if (view) setMobileView(view);
    },
    [],
  );

  const onOutlineNavigate = useCallback(
    (node: OutlineItem) => {
      const target = targetBlockFor(node, blocks);
      if (target) selectBlock(target, { view: 'pdf', scrollText: true });
      else if (node.page != null) {
        setPage(node.page);
        setLinkedBlockId(null);
        setMobileView('pdf');
      }
      setAnnouncement(`${node.title}${node.page != null ? ` · ${node.page}쪽` : ''}`);
    },
    [blocks, selectBlock],
  );

  // Keep `?page=` and `?block=` in the address bar (reload and sharing reopen the same view).
  useEffect(() => {
    const url = new URL(window.location.href);
    const search = viewerSearch(url.search, page, linkedBlockId);
    if (search === url.search) return;
    url.search = search;
    window.history.replaceState(window.history.state, '', url);
  }, [linkedBlockId, page]);

  // Scroll the current block into view in the text pane.
  const textScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!currentBlockId || !scrollTextOnSelect.current) return;
    scrollTextOnSelect.current = false;
    const scroller = textScrollRef.current;
    const element = scroller?.querySelector<HTMLElement>(
      `[data-block-id="${CSS.escape(currentBlockId)}"]`,
    );
    if (!scroller || !element) return;
    scroller.scrollTo({ top: Math.max(element.offsetTop - 16, 0) });
  }, [currentBlockId, highlightKey]);

  // --- publish ---------------------------------------------------------------------------------

  const follow = useCallback(
    async (jobId: string) => {
      watchController.current?.abort();
      const controller = new AbortController();
      watchController.current = controller;
      setPublish({ phase: 'indexing', jobId, job: null });
      try {
        const final = await watchJob(jobId, {
          signal: controller.signal,
          onJob: (job) => setPublish({ phase: 'indexing', jobId, job }),
        });
        if (final.status === 'succeeded') {
          await refreshDocument();
          // Edits are locked while publishing, so nothing should supersede this load; if
          // something did, keep the newer local content.
          const loaded = await loadFresh('latest', controller.signal);
          if (loaded) setContentState({ status: 'ready', content: loaded });
          setJustSaved(false);
          setPublish({
            phase: 'succeeded',
            revisionNumber: loaded?.revision?.revision_number ?? null,
          });
          setAnnouncement('발행 완료: 새 버전이 검색에 반영되었습니다');
        } else {
          setPublish({ phase: 'failed', reason: 'indexing', message: INDEX_FAILURE_MESSAGE });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (handleCommonError(error)) return;
        setPublish({
          phase: 'failed',
          reason: error instanceof JobGoneError ? 'indexing' : 'request',
          message:
            error instanceof JobGoneError
              ? INDEX_FAILURE_MESSAGE
              : '발행 진행 상황을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
        });
      } finally {
        if (watchController.current === controller) watchController.current = null;
        void refreshRevisions();
      }
    },
    [handleCommonError, loadFresh, refreshDocument, refreshRevisions],
  );

  useEffect(() => () => watchController.current?.abort(), []);

  // After a reload: resume a running publish, or show the last failed one with its retry.
  const resumed = useRef(false);
  useEffect(() => {
    if (!editable || !ready || resumed.current) return;
    resumed.current = true;
    void refreshRevisions().then((items) => {
      if (!items) return;
      const state = resumePublishState(items, INDEX_FAILURE_MESSAGE);
      if (state.phase === 'indexing') void follow(state.jobId);
      else if (state.phase === 'failed') setPublish(state);
    });
  }, [editable, follow, ready, refreshRevisions]);

  const draft = content?.revision && isDraft(content.revision) ? content.revision : null;

  const onPublish = useCallback(async () => {
    if (!draft || isPublishing(publish)) return;
    setNotice(null);
    setPublish({ phase: 'requesting' });
    try {
      const accepted = await client.publish(documentId, draft.id, crypto.randomUUID());
      void follow(accepted.job_id);
    } catch (error) {
      if (handleCommonError(error)) {
        setPublish(PUBLISH_IDLE);
        return;
      }
      if (error instanceof EditorApiError && error.kind === 'nothingToPublish') {
        setPublish(PUBLISH_IDLE);
        setNotice(error.message);
        setReloadKey((k) => k + 1);
        return;
      }
      if (error instanceof EditorApiError && error.kind === 'conflict') {
        setPublish(PUBLISH_IDLE);
        setNotice(
          '초안이 다른 곳에서 바뀌었습니다. 최신 초안을 불러왔으니 확인한 뒤 다시 발행해 주세요.',
        );
        setReloadKey((k) => k + 1);
        return;
      }
      setPublish({
        phase: 'failed',
        reason: 'request',
        message:
          error instanceof EditorApiError
            ? error.message
            : '발행 요청을 보내지 못했습니다. 다시 시도해 주세요.',
      });
    }
  }, [client, documentId, draft, follow, handleCommonError, publish]);

  const onRestore = useCallback(
    async (revision: RevisionHistoryItem): Promise<boolean> => {
      setRestoring(revision.id);
      setNotice(null);
      try {
        await client.restore(documentId, revision.id);
        contentGeneration.current += 1; // loads started before the restore hold the pre-restore draft
        const loaded = await loadFresh('latest');
        if (loaded) setContentState({ status: 'ready', content: loaded });
        setJustSaved(true);
        setPublish(PUBLISH_IDLE);
        setAnnouncement(`버전 ${revision.revision_number}의 내용을 초안으로 되돌렸습니다`);
        void refreshRevisions();
        return true;
      } catch (error) {
        if (!handleCommonError(error)) {
          setNotice(
            error instanceof EditorApiError
              ? error.message
              : '되돌리지 못했습니다. 다시 시도해 주세요.',
          );
        }
        return false;
      } finally {
        setRestoring(null);
      }
    },
    [client, documentId, handleCommonError, loadFresh, refreshRevisions],
  );

  // --- block corrections -----------------------------------------------------------------------

  const onStartEdit = useCallback((block: ContentBlock) => {
    setNotice(null);
    setCurrentBlockId(block.block_id);
    setLinkedBlockId(block.block_id);
    setPage(blockPage(block));
    dispatchEdit({ type: 'start', block });
  }, []);
  const onChange = useCallback((text: string) => dispatchEdit({ type: 'change', text }), []);
  const onCancel = useCallback(() => dispatchEdit({ type: 'cancel' }), []);

  /**
   * Full reload of the latest text after a save. A reload overtaken by a newer save is dropped
   * and run again (its snapshot may miss that save); after repeated overtakes the screen offers a
   * manual reload instead.
   */
  const refreshContent = useCallback(async () => {
    try {
      for (let attempt = 0; attempt < MAX_SUPERSEDED_RELOADS; attempt += 1) {
        const loaded = await loadFresh('latest');
        if (loaded) {
          setContentState({ status: 'ready', content: loaded });
          setStaleContent(false);
          return;
        }
      }
      setStaleContent(true);
    } catch (error) {
      if (!handleCommonError(error)) setStaleContent(true);
    }
  }, [handleCommonError, loadFresh]);

  const onSave = useCallback(async () => {
    const state = editStateRef.current;
    if (state.phase !== 'editing') return;
    dispatchEdit({ type: 'save' });
    if (state.text === state.original) return; // unchanged: nothing to save
    const { blockId, text, baseVersion } = state;
    try {
      const saved = await client.correctBlock(documentId, blockId, text, baseVersion);
      dispatchEdit({ type: 'saved', blockId });
      setJustSaved(true);
      if (publish.phase === 'failed' || publish.phase === 'succeeded') setPublish(PUBLISH_IDLE);
      setAnnouncement('초안에 저장했습니다');
      const sameRevision = revisionIdRef.current === saved.revision.id;
      // Show the saved block and its (draft) revision right away, whatever happens next; loads
      // already in flight may predate this save and are discarded.
      contentGeneration.current += 1;
      setContentState((prev) =>
        prev.status !== 'ready'
          ? prev
          : { status: 'ready', content: applySavedBlock(prev.content, saved) },
      );
      if (!sameRevision || saved.block.type === 'heading') {
        // A new draft (chapter ids belong to each revision) or a renamed section: reload. A
        // failure here does not undo the save; the screen offers to reload the text.
        void refreshContent();
      }
      void refreshRevisions();
    } catch (error) {
      if (error instanceof EditorApiError && error.kind === 'conflict') {
        const latest = await client
          .getBlock(documentId, blockId, 'latest')
          .then((detail) => detail.block)
          .catch(() => null);
        dispatchEdit({
          type: 'conflict',
          blockId,
          failure: { kind: 'conflict', message: error.message },
          latest,
        });
        return;
      }
      if (handleCommonError(error)) {
        dispatchEdit({
          type: 'failed',
          blockId,
          failure: { kind: 'forbidden', message: (error as EditorApiError).message },
        });
        return;
      }
      const failure =
        error instanceof EditorApiError
          ? {
              kind: error.kind,
              message:
                error.detail && error.kind === 'invalid'
                  ? `${error.message} ${error.detail}`
                  : error.message,
            }
          : { kind: 'unavailable' as const, message: '저장하지 못했습니다. 다시 시도해 주세요.' };
      dispatchEdit({ type: 'failed', blockId, failure });
    }
  }, [client, documentId, handleCommonError, publish.phase, refreshContent, refreshRevisions]);

  // Unsaved text survives an accidental tab close.
  useEffect(() => {
    if (editState.phase === 'idle' || editState.text === editState.original) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [editState]);

  // --- render ----------------------------------------------------------------------------------

  const statusText = !ready
    ? document.status === 'failed'
      ? '처리 실패'
      : '처리 중 · 아직 발행된 원문이 없습니다'
    : contentState.status === 'loading'
      ? '원문을 불러오는 중…'
      : pinned
        ? pinnedStatusText(content?.revision ?? null)
        : revisionStatusText({
            canEdit,
            revision: content?.revision ?? null,
            justSaved,
            publish,
          });

  const highlights = locationsOn(currentBlock, page);
  const currentSection = sectionOf(currentBlock, outline);

  return (
    <div className={styles.screen}>
      <PageHeader
        title={document.title}
        breadcrumb={
          <nav aria-label="위치">
            <Link href={`/workspaces/${workspaceId}/documents`}>문서</Link>
          </nav>
        }
        description={document.filename !== document.title ? document.filename : undefined}
      />

      <PublishBar
        statusText={statusText}
        canEdit={editable && ready}
        hasDraft={draft !== null}
        publish={publish}
        editing={editState.phase !== 'idle'}
        revisions={revisions}
        restoring={restoring}
        onPublish={() => void onPublish()}
        onRestore={onRestore}
        onOpenHistory={() => void refreshRevisions()}
      />

      {pinned ? (
        <div role="note" className={styles.note}>
          <p>
            {content?.revision && !content.revision.is_active
              ? '검색 결과가 나온 이전 발행본을 보고 있습니다. 그 뒤에 새 버전이 발행되어 현재 원문과 다를 수 있습니다.'
              : canEdit
                ? '검색 결과가 나온 발행본을 보고 있습니다. 아직 발행하지 않은 초안의 내용과 다를 수 있습니다.'
                : '검색 결과가 나온 발행본을 보고 있습니다.'}
          </p>
          <Link href={`${documentPath}${viewerSearch('', page, linkedBlockId)}`}>
            {canEdit ? '최신 원문 보기·교정하기' : '최신 원문 보기'}
          </Link>
        </div>
      ) : null}
      {readOnlyReason ? (
        <p role="note" className={styles.note}>
          {readOnlyReason}
        </p>
      ) : null}
      {notice ? (
        <p role="alert" className={styles.noticeAlert}>
          {notice}
        </p>
      ) : null}
      {staleContent ? (
        <div role="alert" className={styles.publishAlert}>
          <p>
            수정 내용은 초안에 저장되었지만 최신 원문을 다시 불러오지 못했습니다. 목차와 원문이
            최신이 아닐 수 있습니다.
          </p>
          <Button size="sm" onClick={() => void refreshContent()}>
            원문 다시 불러오기
          </Button>
        </div>
      ) : null}
      {!ready ? (
        <p role="note" className={styles.note}>
          {document.status === 'failed'
            ? `문서 처리에 실패했습니다.${document.last_error ? ` (${document.last_error})` : ''} 문서 목록에서 다시 시도할 수 있습니다.`
            : '문서를 처리하는 중입니다. 처리가 끝나면 목차와 원문 텍스트가 표시됩니다.'}{' '}
          <Link href={`/workspaces/${workspaceId}/documents`}>문서 목록으로</Link>
        </p>
      ) : null}

      <div className={styles.viewSwitch} role="group" aria-label="보기 선택">
        {MOBILE_VIEWS.map((view) => (
          <button
            key={view.id}
            type="button"
            className={`${styles.viewSwitchButton} qz-focus-ring`}
            aria-pressed={mobileView === view.id}
            onClick={() => setMobileView(view.id)}
          >
            {view.label}
          </button>
        ))}
      </div>

      <div className={styles.split} data-view={mobileView}>
        <nav aria-label="문서 목차" className={styles.outlinePane} data-pane="outline">
          <h2 className={styles.paneTitle}>목차</h2>
          {contentState.status === 'ready' ? (
            <OutlineTree
              items={outline}
              currentId={currentSection}
              onNavigate={onOutlineNavigate}
            />
          ) : contentState.status === 'loading' && ready ? (
            <p className={styles.paneNote}>목차를 불러오는 중입니다…</p>
          ) : null}
        </nav>

        <section aria-label="PDF 원본" className={styles.pdfPane} data-pane="pdf">
          <PdfViewer
            source={pdfSource}
            page={page}
            onPageChange={(next) => {
              setPage(next);
              setLinkedBlockId(null);
              setAnnouncement(`${next}쪽`);
            }}
            highlights={highlights}
            highlightKey={`${currentBlockId ?? ''}:${highlightKey}`}
          />
        </section>

        <section aria-label="원문 텍스트" className={styles.textPane} data-pane="text">
          <div className={styles.textScroller} ref={textScrollRef}>
            {contentState.status === 'loading' && ready ? (
              <p className={styles.paneNote} aria-busy="true">
                원문 텍스트를 불러오는 중입니다…
              </p>
            ) : null}
            {contentState.status === 'error' ? (
              <div role="alert" className={styles.inlineAlert}>
                <p>{contentState.message}</p>
                <button
                  type="button"
                  className={`${styles.linkButton} qz-focus-ring`}
                  onClick={() => {
                    setContentState({ status: 'loading' });
                    setReloadKey((k) => k + 1);
                  }}
                >
                  다시 불러오기
                </button>
              </div>
            ) : null}
            {content ? (
              <TextBlockEditor
                blocks={blocks}
                currentBlockId={currentBlockId}
                canEdit={editable}
                editLocked={isPublishing(publish) || restoring !== null}
                editState={editState}
                onSelect={(block) => selectBlock(block, { view: 'pdf' })}
                onStartEdit={onStartEdit}
                onChange={onChange}
                onSave={() => void onSave()}
                onCancel={onCancel}
              />
            ) : null}
          </div>
        </section>
      </div>

      <p className="qz-visually-hidden" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

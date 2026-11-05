'use client';

// WS-VIEW-01 shared document: the DOC-02 viewer parts in read-only mode — outline tree, the
// original PDF (streamed by the same-origin relay after the share check) and the published
// revision's text blocks with their pages — in the DOCVIEW-01 layout (document-viewer-layout.tsx,
// the same browser-wide settings as DOC-02). No correction, publish or revision controls.
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DocumentViewerLayout,
  useDocumentViewer,
} from '@/components/documents/editor/document-viewer-layout';
import { OutlineTree } from '@/components/documents/editor/outline-tree';
import { PdfViewer, type PageChangeReason } from '@/components/documents/editor/pdf-viewer';
import { TextBlockEditor } from '@/components/documents/editor/text-block-editor';
import { scrollTextTo, useWhenShown } from '@/components/documents/editor/text-sync';
import editorStyles from '@/components/documents/editor/editor.module.css';
import { IDLE } from '@/lib/documents/block-edit';
import { blockPage, sectionOf, targetBlockFor, type OutlineJump } from '@/lib/documents/outline';
import type {
  ContentBlock,
  OutlineItem,
  SharedClient,
  SharedDocument,
  SharedQuestion,
  SharedDocumentSummary,
} from '@/lib/shared/client';
import { documentQuestions, type DocumentQuestion } from '@/lib/documents/document-questions';
import { pageGroups, selectionHighlights, textTargetForPage } from '@/lib/documents/text-groups';
import { endsShareView, sharedFailureMessage } from '@/lib/shared/messages';
import { sharePath } from '@/lib/shared/view-state';
import styles from './shared.module.css';

export interface SharedDocumentViewProps {
  readonly shareId: string;
  readonly client: SharedClient;
  readonly documentId: string;
  readonly archived: boolean;
  readonly expiryLabel: string | null;
  /** The document's entry in the shared workspace; null when it is not shared (any more). */
  readonly summary: SharedDocumentSummary | null;
  /** `?page=` / `?block=` deep link (question sources, search hits). */
  readonly page: number | null;
  readonly blockId: string | null;
  readonly onUnavailable: () => void;
}

type ContentState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string; readonly missing: boolean }
  | { readonly status: 'ready'; readonly document: SharedDocument };

const noop = () => undefined;
/** Safety stop for paging a document's shared questions (100 × 100). */
const MAX_QUESTION_PAGES = 100;

export function SharedDocumentView({
  shareId,
  client,
  documentId,
  archived,
  expiryLabel,
  summary,
  page: linkedPage,
  blockId: linkedBlockId,
  onUnavailable,
}: SharedDocumentViewProps) {
  const [content, setContent] = useState<ContentState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(linkedPage ?? 1);
  const [currentBlockId, setCurrentBlockId] = useState<string | null>(null);
  const [highlightKey, setHighlightKey] = useState(0);
  const [outlineJump, setOutlineJump] = useState<OutlineJump | null>(null);
  const viewer = useDocumentViewer();
  const { blockChosen, outlineChosen, textVisible } = viewer;
  /** The text pane follows the PDF's page (AC08) rather than a chosen block. */
  const followPage = useRef(false);
  const [announcement, setAnnouncement] = useState('');
  /** The deep link (page/block) last applied to the loaded content. */
  const [appliedLink, setAppliedLink] = useState<string | null>(null);
  const pdfSource = useCallback(
    (signal: AbortSignal) =>
      client.pdf(documentId, signal).catch((error: unknown) => {
        // The viewer would only show its own error: a revoked/expired link ends the view.
        if (!signal.aborted && endsShareView(error)) onUnavailable();
        throw error;
      }),
    [client, documentId, onUnavailable],
  );

  useEffect(() => {
    const controller = new AbortController();
    client.document(documentId, controller.signal).then(
      (document) => {
        if (!controller.signal.aborted) setContent({ status: 'ready', document });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (endsShareView(error)) {
          onUnavailable();
          return;
        }
        const missing = (error as { kind?: string }).kind === 'notFound';
        setContent({
          status: 'error',
          missing,
          message: missing
            ? '이 문서는 공유되지 않았거나 더 이상 볼 수 없습니다.'
            : sharedFailureMessage(error),
        });
      },
    );
    return () => controller.abort();
  }, [client, documentId, attempt, onUnavailable]);

  const document = content.status === 'ready' ? content.document : null;
  const blocks = useMemo<readonly ContentBlock[]>(() => document?.blocks ?? [], [document]);
  const outline = useMemo<readonly OutlineItem[]>(() => document?.outline ?? [], [document]);

  const selectBlock = useCallback((block: ContentBlock) => {
    const target = blockPage(block);
    followPage.current = false;
    setCurrentBlockId(block.block_id);
    setPage(target);
    setHighlightKey((k) => k + 1);
    setAnnouncement(`${target}쪽`);
  }, []);

  // Apply `?page=` / `?block=` once the text is loaded, and again whenever the link changes.
  const linkKey = `${linkedPage ?? ''}:${linkedBlockId ?? ''}`;
  if (document && appliedLink !== linkKey) {
    setAppliedLink(linkKey);
    const linked = linkedBlockId ? blocks.find((b) => b.block_id === linkedBlockId) : undefined;
    if (linked) {
      setCurrentBlockId(linked.block_id);
      setPage(blockPage(linked));
      setHighlightKey((k) => k + 1);
    } else if (linkedPage !== null) {
      setCurrentBlockId(null);
      setPage(linkedPage);
    }
  }

  // DOC-02-AC08: the text pane follows the PDF when the reader moves it.
  // DOC-02-AC11: published questions imported from this PDF show in question format.
  const [questions, setQuestions] = useState<readonly DocumentQuestion[]>([]);
  const loadedDocument = document !== null;
  useEffect(() => {
    if (!loadedDocument) return;
    const controller = new AbortController();
    void (async () => {
      const items: SharedQuestion[] = [];
      let cursor: string | null = null;
      for (let n = 0; n < MAX_QUESTION_PAGES; n += 1) {
        const list = await client.questions(cursor, controller.signal, documentId);
        items.push(...list.items);
        cursor = list.next_cursor ?? null;
        if (!cursor) break;
      }
      if (!controller.signal.aborted) setQuestions(documentQuestions(items, documentId));
    })().catch(() => undefined);
    return () => controller.abort();
  }, [client, documentId, loadedDocument]);
  const groups = useMemo(() => pageGroups(blocks, questions), [blocks, questions]);
  const textScrollRef = useRef<HTMLDivElement>(null);
  const syncTextTo = useRef<number | null>(null);
  const onViewerPage = useCallback((next: number, reason: PageChangeReason) => {
    setPage(next);
    if (reason === 'navigate') setAnnouncement(`${next}쪽`);
    followPage.current = true;
    syncTextTo.current = next;
  }, []);
  useEffect(() => {
    const target = syncTextTo.current;
    if (target === null || target !== page) return;
    syncTextTo.current = null;
    scrollTextTo(textScrollRef.current, textTargetForPage(groups, target));
  }, [groups, page]);

  const onTextSelect = useCallback(
    (block: ContentBlock) => {
      selectBlock(block);
      blockChosen();
    },
    [blockChosen, selectBlock],
  );
  const currentBlock = useMemo(
    () => blocks.find((b) => b.block_id === currentBlockId),
    [blocks, currentBlockId],
  );
  const highlights = useMemo(
    () => selectionHighlights(currentBlock, outlineJump, blocks, groups),
    [blocks, currentBlock, groups, outlineJump],
  );
  const title = document?.title ?? summary?.title ?? '문서';

  // An outline jump also brings its block into view in the text pane (DOCVIEW-01: in 변환본 alone
  // the text pane is the only place it shows).
  const scrollTextToBlock = useRef(false);
  useEffect(() => {
    if (!currentBlockId || !scrollTextToBlock.current) return;
    scrollTextToBlock.current = false;
    scrollTextTo(textScrollRef.current, { kind: 'block', blockId: currentBlockId });
  }, [currentBlockId, highlightKey]);
  // A text pane shown again catches up: the chosen block, or the page the PDF is on.
  const resyncText = useCallback(() => {
    scrollTextTo(
      textScrollRef.current,
      currentBlockId && !followPage.current
        ? { kind: 'block', blockId: currentBlockId }
        : textTargetForPage(groups, page),
    );
  }, [currentBlockId, groups, page]);
  useWhenShown(textVisible, resyncText);

  const onOutlineNavigate = useCallback(
    (node: OutlineItem) => {
      const block = targetBlockFor(node, blocks);
      setOutlineJump(block ? { node, blockId: block.block_id } : null);
      if (block) {
        scrollTextToBlock.current = true;
        selectBlock(block);
      } else if (node.page != null) {
        followPage.current = true;
        setCurrentBlockId(null);
        setPage(node.page);
      }
      // Tablets fold the panel that covers the panes; narrow screens close it and show 원본.
      outlineChosen();
    },
    [blocks, outlineChosen, selectBlock],
  );

  const header = (
    <div className={styles.documentHeader}>
      <nav aria-label="위치">
        <Link href={sharePath(shareId)} className={`${styles.backLink} qz-focus-ring`}>
          공유 Workspace 홈
        </Link>
      </nav>
      <h2 id="shared-document-title" className={styles.documentTitle}>
        {title}
      </h2>
      <p role="note">
        공유 문서는 읽기 전용입니다. 발행된 문서와 문제만 볼 수 있고, 이 화면에서는 아무것도
        저장되지 않습니다.
      </p>
      {archived ? <p role="note">보관된 Workspace입니다.</p> : null}
      {expiryLabel ? <p>{expiryLabel}</p> : null}
    </div>
  );

  return (
    <section className={styles.document} aria-labelledby="shared-document-title">
      {content.status === 'error' ? (
        <>
          {header}
          <div className={styles.alert} role="alert">
            <p>{content.message}</p>
            {content.missing ? null : (
              <button
                type="button"
                className={`${editorStyles.linkButton} qz-focus-ring`}
                onClick={() => {
                  setContent({ status: 'loading' });
                  setAttempt((n) => n + 1);
                }}
              >
                다시 불러오기
              </button>
            )}
          </div>
        </>
      ) : (
        <DocumentViewerLayout
          viewer={viewer}
          chrome={header}
          preventAutoHide={archived}
          headingLevel={3}
          outline={
            document ? (
              <OutlineTree
                items={outline}
                currentId={sectionOf(currentBlock, outline)}
                onNavigate={onOutlineNavigate}
              />
            ) : (
              <p className={editorStyles.paneNote}>목차를 불러오는 중입니다…</p>
            )
          }
          pdf={
            <PdfViewer
              source={pdfSource}
              page={page}
              onPageChange={onViewerPage}
              highlights={highlights}
              highlightKey={`${currentBlockId ?? ''}:${highlightKey}`}
              deferResize={viewer.resizing}
            />
          }
          text={
            <div className={editorStyles.textScroller} ref={textScrollRef}>
              {document ? (
                blocks.length === 0 ? (
                  <p className={editorStyles.paneNote}>이 문서에는 원문 텍스트가 없습니다.</p>
                ) : (
                  <TextBlockEditor
                    groups={groups}
                    currentBlockId={currentBlockId}
                    currentPage={page}
                    canEdit={false}
                    editLocked
                    editState={IDLE}
                    onSelect={onTextSelect}
                    onStartEdit={noop}
                    onChange={noop}
                    onSave={noop}
                    onCancel={noop}
                  />
                )
              ) : (
                <p className={editorStyles.paneNote} aria-busy="true">
                  원문 텍스트를 불러오는 중입니다…
                </p>
              )}
            </div>
          }
        />
      )}

      <p className="qz-visually-hidden" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}

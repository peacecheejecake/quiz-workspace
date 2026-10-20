'use client';

// WS-VIEW-01 shared document: the DOC-02 viewer parts in read-only mode — outline tree, the
// original PDF (streamed by the same-origin relay after the share check) and the published
// revision's text blocks with their pages. No correction, publish or revision controls.
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { OutlineTree } from '@/components/documents/editor/outline-tree';
import { PdfViewer } from '@/components/documents/editor/pdf-viewer';
import { TextBlockEditor } from '@/components/documents/editor/text-block-editor';
import editorStyles from '@/components/documents/editor/editor.module.css';
import { IDLE } from '@/lib/documents/block-edit';
import {
  blockPage,
  sectionOf,
  targetBlockFor,
  viewerHighlights,
  type OutlineJump,
} from '@/lib/documents/outline';
import type {
  ContentBlock,
  OutlineItem,
  SharedClient,
  SharedDocument,
  SharedDocumentSummary,
} from '@/lib/shared/client';
import { endsShareView, sharedFailureMessage } from '@/lib/shared/messages';
import { sharePath } from '@/lib/shared/view-state';
import styles from './shared.module.css';

export interface SharedDocumentViewProps {
  readonly shareId: string;
  readonly client: SharedClient;
  readonly documentId: string;
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

type MobileView = 'outline' | 'pdf' | 'text';

const MOBILE_VIEWS: readonly { id: MobileView; label: string }[] = [
  { id: 'outline', label: '목차' },
  { id: 'pdf', label: 'PDF' },
  { id: 'text', label: '원문' },
];

const noop = () => undefined;

export function SharedDocumentView({
  shareId,
  client,
  documentId,
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
  const [mobileView, setMobileView] = useState<MobileView>('pdf');
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

  const selectBlock = useCallback((block: ContentBlock, view?: MobileView) => {
    const target = blockPage(block);
    setCurrentBlockId(block.block_id);
    setPage(target);
    setHighlightKey((k) => k + 1);
    setAnnouncement(`${target}쪽`);
    if (view) setMobileView(view);
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

  const currentBlock = blocks.find((b) => b.block_id === currentBlockId);
  const title = document?.title ?? summary?.title ?? '문서';

  return (
    <section className={styles.document} aria-labelledby="shared-document-title">
      <div className={styles.documentHeader}>
        <nav aria-label="위치">
          <Link href={sharePath(shareId)} className={`${styles.backLink} qz-focus-ring`}>
            공유 Workspace 홈
          </Link>
        </nav>
        <h2 id="shared-document-title" className={styles.documentTitle}>
          {title}
        </h2>
      </div>

      {content.status === 'error' ? (
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
      ) : (
        <>
          <div className={editorStyles.viewSwitch} role="group" aria-label="보기 선택">
            {MOBILE_VIEWS.map((view) => (
              <button
                key={view.id}
                type="button"
                className={`${editorStyles.viewSwitchButton} qz-focus-ring`}
                aria-pressed={mobileView === view.id}
                onClick={() => setMobileView(view.id)}
              >
                {view.label}
              </button>
            ))}
          </div>

          <div className={`${editorStyles.split} ${styles.split}`} data-view={mobileView}>
            <nav aria-label="장·절 목차" className={editorStyles.outlinePane} data-pane="outline">
              <h3 className={editorStyles.paneTitle}>목차</h3>
              {document ? (
                <OutlineTree
                  items={outline}
                  currentId={sectionOf(currentBlock, outline)}
                  onNavigate={(node) => {
                    const block = targetBlockFor(node, blocks);
                    setOutlineJump(block ? { node, blockId: block.block_id } : null);
                    if (block) selectBlock(block);
                    else if (node.page != null) {
                      setCurrentBlockId(null);
                      setPage(node.page);
                    }
                  }}
                />
              ) : (
                <p className={editorStyles.paneNote}>목차를 불러오는 중입니다…</p>
              )}
            </nav>

            <section aria-label="PDF 원본" className={editorStyles.pdfPane} data-pane="pdf">
              <PdfViewer
                source={pdfSource}
                page={page}
                onPageChange={(next) => {
                  setPage(next);
                  setAnnouncement(`${next}쪽`);
                }}
                highlights={viewerHighlights(currentBlock, outlineJump, blocks, page)}
                highlightKey={`${currentBlockId ?? ''}:${highlightKey}`}
              />
            </section>

            <section aria-label="원문 텍스트" className={editorStyles.textPane} data-pane="text">
              <div className={editorStyles.textScroller}>
                {document ? (
                  blocks.length === 0 ? (
                    <p className={editorStyles.paneNote}>이 문서에는 원문 텍스트가 없습니다.</p>
                  ) : (
                    <TextBlockEditor
                      blocks={blocks}
                      currentBlockId={currentBlockId}
                      canEdit={false}
                      editLocked
                      editState={IDLE}
                      onSelect={(block) => selectBlock(block, 'pdf')}
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
            </section>
          </div>
        </>
      )}

      <p className="qz-visually-hidden" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}

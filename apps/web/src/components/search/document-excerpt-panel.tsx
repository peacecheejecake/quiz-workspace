'use client';

// `DocumentExcerptPanel` (docs/design-system.md §5.1): a modal FloatingSidePanel over the results
// (a bottom sheet on phones; modal since UX9, HOMEDLG-01 — the results behind it are inert and do
// not step aside) with the hit's paragraph-complete excerpt — the text around the keyword, the
// keyword marked (SEARCH-01-AC11) and scrolled into view —, its location and the jump into the
// PDF. `이전 결과`/`다음 결과` (Alt+↑/Alt+↓) move it along the results; closing it returns focus
// to the result last shown. `PDF에서 보기` opens the page in place (UX12-SOURCE).
// The jump target is refined to the block that holds the match (lib/search/jump.ts) while the
// panel is open; a click before that finished waits for it.
import { Button, FloatingSidePanel } from '@quiz/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { PdfPageDialog, type PdfPageTarget } from '@/components/documents/editor/pdf-page-dialog';
import type { SearchClient, SearchItem } from '@/lib/search/client';
import { apiJumpTarget, resolveJumpTarget, type JumpTarget } from '@/lib/search/jump';
import { pageLabel, pdfLinkFor } from '@/lib/search/state';
import { SearchExcerpt } from './search-excerpt';
import { hitKey } from './search-result-list';
import styles from './search.module.css';

export interface DocumentExcerptPanelProps {
  /** Member view: "PDF에서 보기" opens the 원본 PDF dialog, which links to DOC-02. */
  readonly workspaceId?: string;
  /**
   * "PDF에서 보기" stays a plain DOC-02 link: the AI 질문 panel, which can be open over a mock exam
   * question before its submission, where no whole-PDF dialog may open (QSRC-01).
   */
  readonly linkOnly?: boolean;
  /** Shared view (WS-VIEW-01): opens the hit in place instead of linking to DOC-02. */
  readonly onJump?: (item: SearchItem, target: JumpTarget) => void;
  readonly client: Pick<SearchClient, 'block'>;
  /** The hit shown; kept while the panel animates closed. */
  readonly item: SearchItem | null;
  /** The results in list order: `이전 결과`/`다음 결과` show the neighbouring one via `onSelect`. */
  readonly items?: readonly SearchItem[];
  readonly onSelect?: (item: SearchItem) => void;
  readonly open: boolean;
  readonly onClose: () => void;
  /** A note above the excerpt (ASK-01: the source's revision is no longer the published one). */
  readonly notice?: string | null;
}

const linkFor = (workspaceId: string, item: SearchItem, target: JumpTarget) =>
  pdfLinkFor(workspaceId, {
    document_id: item.document_id,
    revision_id: item.revision_id,
    page: target.page,
    block_id: target.blockId,
  });

export function DocumentExcerptPanel({
  workspaceId,
  linkOnly = false,
  onJump: jumpInPlace,
  client,
  item,
  items = [],
  onSelect,
  open,
  onClose,
  notice,
}: DocumentExcerptPanelProps) {
  const router = useRouter();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [resolved, setResolved] = useState<{ key: string; target: JumpTarget } | null>(null);
  const pendingRef = useRef<{ key: string; promise: Promise<JumpTarget> } | null>(null);
  const [pdfPage, setPdfPage] = useState<PdfPageTarget | null>(null);

  useEffect(() => {
    if (!item) return;
    const key = hitKey(item);
    const controller = new AbortController();
    const promise = resolveJumpTarget(client, item, controller.signal);
    pendingRef.current = { key, promise };
    void promise.then((target) => {
      if (!controller.signal.aborted) setResolved({ key, target });
    });
    return () => controller.abort();
  }, [client, item]);

  const key = item ? hitKey(item) : null;
  const at = key === null ? -1 : items.findIndex((i) => hitKey(i) === key);
  const previous = at > 0 ? items[at - 1] : undefined;
  const next = at >= 0 ? items[at + 1] : undefined;

  // The first query term (else the matched passage) in view once the panel shows a hit.
  const visible = open && item !== null;
  useEffect(() => {
    if (!visible) return;
    const frame = window.requestAnimationFrame(() => {
      const mark =
        bodyRef.current?.querySelector('mark[data-term]') ?? bodyRef.current?.querySelector('mark');
      mark?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visible, key]);
  const target = item ? (resolved?.key === key ? resolved.target : apiJumpTarget(item)) : null;

  const onJump = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!item || workspaceId === undefined || resolved?.key === key) return;
    const pending = pendingRef.current;
    if (!pending || pending.key !== key) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    void pending.promise.then((t) => router.push(linkFor(workspaceId, item, t)));
  };

  const openPdfPage =
    workspaceId !== undefined && !linkOnly
      ? (hit: SearchItem, to: JumpTarget) =>
          setPdfPage({
            documentId: hit.document_id,
            page: to.page,
            documentHref: linkFor(workspaceId, hit, to),
            documentTitle: hit.document_title,
          })
      : undefined;
  const jump = jumpInPlace ?? openPdfPage;

  const openInPlace = () => {
    if (!item || !target || !jump) return;
    const pending = pendingRef.current;
    if (resolved?.key === key || !pending || pending.key !== key) jump(item, target);
    else void pending.promise.then((t) => jump(item, t));
  };

  return (
    <FloatingSidePanel
      open={open && item !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="본문 발췌"
      steps={
        onSelect
          ? {
              previousLabel: '이전 결과',
              nextLabel: '다음 결과',
              onPrevious: previous ? () => onSelect(previous) : undefined,
              onNext: next ? () => onSelect(next) : undefined,
            }
          : undefined
      }
      onCloseAutoFocus={(event) => {
        // The result last shown (maybe not the one that opened the panel).
        if (key === null) return;
        const result = document.querySelector<HTMLElement>(
          `button[data-hit-key="${CSS.escape(key)}"]`,
        );
        if (!result) return;
        event.preventDefault();
        result.focus();
      }}
      description={
        item && target ? `${item.document_title} · ${pageLabel(target.page)}` : undefined
      }
      footer={
        item && target && jump ? (
          <Button
            variant="primary"
            aria-haspopup={jumpInPlace ? undefined : 'dialog'}
            onClick={openInPlace}
          >
            PDF에서 보기
          </Button>
        ) : item && target && workspaceId !== undefined ? (
          <Button asChild variant="primary">
            <Link href={linkFor(workspaceId, item, target)} onClick={onJump}>
              PDF에서 보기
            </Link>
          </Button>
        ) : null
      }
    >
      {item ? (
        <div ref={bodyRef} className={styles.panelBody}>
          {notice ? <p className={styles.hint}>{notice}</p> : null}
          {item.breadcrumb.length > 1 ? (
            <nav aria-label="위치">
              <ol className={styles.panelBreadcrumb}>
                {item.breadcrumb.map((part, index) => (
                  <li key={`${index}:${part}`}>{part}</li>
                ))}
              </ol>
            </nav>
          ) : null}
          <SearchExcerpt
            text={item.text}
            highlights={item.highlights}
            termHighlights={item.term_highlights}
            language={item.language}
            truncatedStart={item.truncated_start}
            truncatedEnd={item.truncated_end}
          />
        </div>
      ) : null}
      {/* Inside the panel, so it stacks over it and Escape closes only this. */}
      <PdfPageDialog target={pdfPage} onClose={() => setPdfPage(null)} />
    </FloatingSidePanel>
  );
}

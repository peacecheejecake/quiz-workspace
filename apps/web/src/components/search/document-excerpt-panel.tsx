'use client';

// `DocumentExcerptPanel` (docs/design-system.md §5.1): non-modal FloatingSidePanel next to the
// results with the hit's paragraph-complete excerpt, its location and the jump into the PDF.
// The jump target is refined to the block that holds the match (lib/search/jump.ts) while the
// panel is open; a click before that finished waits for it.
import { Button, FloatingSidePanel } from '@quiz/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { SearchClient, SearchItem } from '@/lib/search/client';
import { apiJumpTarget, resolveJumpTarget, type JumpTarget } from '@/lib/search/jump';
import { pageLabel, pdfLinkFor } from '@/lib/search/state';
import { SearchExcerpt } from './search-excerpt';
import { hitKey } from './search-result-list';
import styles from './search.module.css';

export interface DocumentExcerptPanelProps {
  readonly workspaceId: string;
  readonly client: Pick<SearchClient, 'block'>;
  /** The hit shown; kept while the panel animates closed. */
  readonly item: SearchItem | null;
  readonly open: boolean;
  readonly onClose: () => void;
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
  client,
  item,
  open,
  onClose,
}: DocumentExcerptPanelProps) {
  const router = useRouter();
  const [resolved, setResolved] = useState<{ key: string; target: JumpTarget } | null>(null);
  const pendingRef = useRef<{ key: string; promise: Promise<JumpTarget> } | null>(null);

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
  const target = item ? (resolved?.key === key ? resolved.target : apiJumpTarget(item)) : null;

  const onJump = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!item || resolved?.key === key) return;
    const pending = pendingRef.current;
    if (!pending || pending.key !== key) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    void pending.promise.then((t) => router.push(linkFor(workspaceId, item, t)));
  };

  return (
    <FloatingSidePanel
      modal={false}
      open={open && item !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="원문 발췌"
      description={
        item && target ? `${item.document_title} · ${pageLabel(target.page)}` : undefined
      }
      footer={
        item && target ? (
          <Button asChild variant="primary">
            <Link href={linkFor(workspaceId, item, target)} onClick={onJump}>
              PDF에서 보기
            </Link>
          </Button>
        ) : null
      }
    >
      {item ? (
        <div className={styles.panelBody}>
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
    </FloatingSidePanel>
  );
}

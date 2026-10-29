'use client';

// The share guest's 문서 요약 (DOCSUM-01-AC06, docs/workspace-sharing.md §8): which shared books
// have a summary of the revision the guest reads (one read per book through the share relay; a
// 404 — no summary, or a run still in progress — means no `요약` button), and the read-only panel
// (`?panel=document-summary&document=<id>`): the summary only, its page links into the shared
// document view. No run state, errors of a run, usage or actions are ever shown to a guest.
import { Badge, FloatingSidePanel, Skeleton } from '@quiz/ui';
import { useEffect, useState } from 'react';
import { fetchSharedSummary, type SharedSummary } from '@/lib/documents/summary';
import type { SharedDocumentSummary } from '@/lib/shared/client';
import { sharedDocumentHref } from '@/lib/shared/view-state';
import { SummaryContentView } from '@/components/documents/summary/summary-content';
import summaryStyles from '@/components/documents/summary/summary.module.css';

/** Summaries of the shared books that have one (the documents offering `요약`). */
export function useSharedSummaries(
  shareId: string,
  documents: readonly SharedDocumentSummary[] | null,
): ReadonlyMap<string, SharedSummary> {
  const [found, setFound] = useState<ReadonlyMap<string, SharedSummary>>(new Map());
  const books = (documents ?? [])
    .filter((d) => d.document_type !== 'question_paper')
    .map((d) => d.id)
    .join(',');
  useEffect(() => {
    if (!books) return;
    const controller = new AbortController();
    void Promise.all(
      books.split(',').map(async (id) => {
        try {
          return [id, await fetchSharedSummary(shareId, id, controller.signal)] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (controller.signal.aborted) return;
      setFound(new Map(entries.filter((e) => e !== null)));
    });
    return () => controller.abort();
  }, [shareId, books]);
  return found;
}

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'missing' }
  | { readonly status: 'ready'; readonly summary: SharedSummary };

export interface SharedSummaryPanelProps {
  readonly shareId: string;
  readonly open: boolean;
  /** The panel's document when it is one of the share's documents; null shows "볼 수 없습니다". */
  readonly documentId: string | null;
  readonly title: string | null;
  /** What the availability read already returned (shown at once, then refreshed). */
  readonly cached?: SharedSummary;
  readonly onClose: () => void;
  readonly returnFocusTo?: () => HTMLElement | null;
}

export function SharedSummaryPanel({
  shareId,
  open,
  documentId,
  title,
  cached,
  onClose,
  returnFocusTo,
}: SharedSummaryPanelProps) {
  return (
    <FloatingSidePanel
      modal={false}
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="문서 요약"
      description={title ?? undefined}
      closeLabel="문서 요약 닫기"
      headerActions={cached ? <Badge tone="accent">AI 생성</Badge> : undefined}
      mobileLayout="full"
      onCloseAutoFocus={(event) => {
        const target = returnFocusTo?.();
        if (!target?.isConnected) return;
        event.preventDefault();
        target.focus();
      }}
    >
      {open && documentId ? (
        <SharedSummaryBody
          key={documentId}
          shareId={shareId}
          documentId={documentId}
          cached={cached}
        />
      ) : open ? (
        <div className={summaryStyles.body}>
          <p role="status" className={summaryStyles.note}>
            이 문서의 요약을 볼 수 없습니다.
          </p>
        </div>
      ) : null}
    </FloatingSidePanel>
  );
}

function SharedSummaryBody({
  shareId,
  documentId,
  cached,
}: {
  readonly shareId: string;
  readonly documentId: string;
  readonly cached?: SharedSummary;
}) {
  const [load, setLoad] = useState<Load>(
    cached ? { status: 'ready', summary: cached } : { status: 'loading' },
  );
  useEffect(() => {
    const controller = new AbortController();
    fetchSharedSummary(shareId, documentId, controller.signal).then(
      (summary) => setLoad({ status: 'ready', summary }),
      () => {
        if (!controller.signal.aborted) setLoad({ status: 'missing' });
      },
    );
    return () => controller.abort();
  }, [shareId, documentId]);

  if (load.status === 'loading') {
    return (
      <div className={summaryStyles.body} aria-busy="true">
        <p role="status" className={summaryStyles.note}>
          요약을 불러오는 중입니다.
        </p>
        <Skeleton shape="rect" height="1.25rem" width="60%" />
        <Skeleton shape="rect" height="5rem" />
      </div>
    );
  }
  if (load.status === 'missing') {
    return (
      <div className={summaryStyles.body}>
        <p role="status" className={summaryStyles.note}>
          이 문서의 요약을 볼 수 없습니다.
        </p>
      </div>
    );
  }
  return (
    <div className={summaryStyles.body}>
      <SummaryContentView
        content={load.summary}
        pageHref={(page) => sharedDocumentHref(shareId, documentId, { page })}
      />
    </div>
  );
}

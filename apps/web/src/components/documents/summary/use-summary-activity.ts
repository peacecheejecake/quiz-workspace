'use client';

// "요약 중" of the 문서 관리 rows (DOCSUM-01): which documents have a queued/running summary run.
// While the dialog is open the newest page of workspace jobs (the HISTORY-01 relay) is read —
// one request, quickly again while a summary job is active, slowly otherwise — and the open
// summary panel reports its own document's state in between.
import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceJob } from '@/lib/history/model';

export const SUMMARY_JOB_TYPE = 'document.summarize';
const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 15000;
const EMPTY: ReadonlySet<string> = new Set();

/** Documents with a queued/running `document.summarize` job in `jobs`. */
export function activeSummaryDocuments(jobs: readonly WorkspaceJob[]): Set<string> {
  const out = new Set<string>();
  for (const job of jobs) {
    if (
      job.job_type === SUMMARY_JOB_TYPE &&
      (job.status === 'queued' || job.status === 'running') &&
      job.target_id
    ) {
      out.add(job.target_id);
    }
  }
  return out;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function useSummaryActivity(workspaceId: string, watching: boolean) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(EMPTY);

  const report = useCallback((documentId: string, active: boolean) => {
    setBusy((prev) => {
      if (prev.has(documentId) === active) return prev;
      const next = new Set(prev);
      if (active) next.add(documentId);
      else next.delete(documentId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!watching) return;
    let live = true;
    let timer: number | undefined;
    const controller = new AbortController();
    const poll = async () => {
      let next = IDLE_POLL_MS;
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/jobs?limit=50`,
          {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { accept: 'application/json' },
            signal: controller.signal,
          },
        );
        if (response.ok) {
          const page = (await response.json()) as { items?: WorkspaceJob[] };
          if (!live) return;
          const active = activeSummaryDocuments(page.items ?? []);
          setBusy((prev) => (sameSet(prev, active) ? prev : active));
          if (active.size > 0) next = ACTIVE_POLL_MS;
        }
      } catch {
        if (!live) return;
      }
      if (live) timer = window.setTimeout(() => void poll(), next);
    };
    void poll();
    return () => {
      live = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [workspaceId, watching]);

  return { busy, report };
}

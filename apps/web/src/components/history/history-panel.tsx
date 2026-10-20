'use client';

// HISTORY-01 "이력" dialog body (docs/screens/history-jobs.md, UX3c): 변경 이력 (who changed which
// document/question, when, and which revision), 작업 (async jobs with their cause, retryability and
// a retry action) and the signed-in user's own 풀이 기록, merged into one list, newest first, each
// row naming its kind. Mounted when the dialog opens: the first pages load through the BFF relays
// while a skeleton shows; "더 보기" reads further pages. Every state is text (never colour alone);
// times are <time datetime>.
import { Badge, Button, Skeleton } from '@quiz/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  createHistoryClient,
  retryFailureMessage,
  type HistoryItems,
  type HistoryKind,
} from '@/lib/history/client';
import {
  actorLabel,
  appendPage,
  attemptResultLabel,
  attemptResultTone,
  ENTRY_KIND_LABELS,
  eventLabel,
  formatHistoryTime,
  hasMoreHistory,
  jobCauseLabel,
  jobStatusLabel,
  jobStatusTone,
  jobTypeLabel,
  mergeHistory,
  questionLabel,
  retryabilityLabel,
  revisionLabel,
  targetLabel,
  type Activity,
  type HistoryEntry,
  type HistoryPage,
  type HistoryPages,
  type WorkspaceAttempt,
  type WorkspaceJob,
} from '@/lib/history/model';
import { patchSearch } from '@/lib/workspaces/home';
import styles from './history.module.css';

export interface HistoryPanelProps {
  readonly workspaceId: string;
  /** Verified id of the signed-in user (entries of this actor read "나"). */
  readonly viewerId: string | null;
}

const KINDS: readonly HistoryKind[] = ['activities', 'jobs', 'attempts'];
const KIND_NAMES: Readonly<Record<HistoryKind, string>> = {
  activities: '변경 이력',
  jobs: '작업 기록',
  attempts: '풀이 기록',
};

type ListState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ok'; readonly page: HistoryPage<T> }
  | { readonly status: 'unavailable' };

type Lists = { readonly [K in HistoryKind]: ListState<HistoryItems[K]> };

const LOADING: Lists = {
  activities: { status: 'loading' },
  jobs: { status: 'loading' },
  attempts: { status: 'loading' },
};

function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function pageOf<T>(state: ListState<T>): HistoryPage<T> | null {
  return state.status === 'ok' ? state.page : null;
}

function HistoryTime({ iso }: { readonly iso: string }) {
  return <time dateTime={iso}>{formatHistoryTime(iso)}</time>;
}

export function HistoryPanel({ workspaceId, viewerId }: HistoryPanelProps) {
  const client = useMemo(() => createHistoryClient(), []);
  const [lists, setLists] = useState<Lists>(LOADING);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [reloading, setReloading] = useState<HistoryKind | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryMessage, setRetryMessage] = useState<{
    readonly tone: 'status' | 'alert';
    readonly text: string;
  } | null>(null);

  const load = useCallback(
    async <K extends HistoryKind>(kind: K): Promise<ListState<HistoryItems[K]>> => {
      try {
        return { status: 'ok', page: await client.list(workspaceId, kind) };
      } catch {
        return { status: 'unavailable' };
      }
    },
    [client, workspaceId],
  );

  const reload = useCallback(
    async (kinds: readonly HistoryKind[]) => {
      const results = await Promise.all(kinds.map((kind) => load(kind)));
      setLists((current) => {
        const next = { ...current } as Record<HistoryKind, ListState<unknown>>;
        kinds.forEach((kind, i) => {
          next[kind] = results[i] as ListState<unknown>;
        });
        return next as unknown as Lists;
      });
      setMoreFailed(false);
    },
    [load],
  );

  useEffect(() => {
    void Promise.resolve().then(() => reload(KINDS));
  }, [reload]);

  const pages: HistoryPages = {
    activities: pageOf(lists.activities),
    jobs: pageOf(lists.jobs),
    attempts: pageOf(lists.attempts),
  };
  const entries = mergeHistory(pages);
  const loading = KINDS.some((kind) => lists[kind].status === 'loading');

  async function loadMore() {
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const updates = await Promise.all(
        KINDS.map(async (kind) => {
          const page = pages[kind];
          if (!page?.nextCursor) return null;
          return [kind, await client.list(workspaceId, kind, page.nextCursor)] as const;
        }),
      );
      setLists((current) => {
        const next = { ...current } as Record<HistoryKind, ListState<{ readonly id: string }>>;
        for (const update of updates) {
          if (!update) continue;
          const [kind, more] = update;
          const state = next[kind];
          if (state.status === 'ok') {
            next[kind] = { status: 'ok', page: appendPage(state.page, more) };
          }
        }
        return next as unknown as Lists;
      });
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  async function retry(job: WorkspaceJob) {
    setRetryingId(job.id);
    setRetryMessage(null);
    try {
      await client.retry(job, newIdempotencyKey());
      setRetryMessage({
        tone: 'status',
        text: '새 작업을 시작했습니다. 실패한 작업 기록은 그대로 남습니다.',
      });
    } catch (error) {
      setRetryMessage({ tone: 'alert', text: retryFailureMessage(error) });
    } finally {
      await reload(['jobs', 'activities']);
      setRetryingId(null);
    }
  }

  if (loading) {
    return (
      <div aria-busy="true" className={styles.panel}>
        <p role="status" className="qz-visually-hidden">
          이력을 불러오는 중입니다.
        </p>
        <Skeleton shape="rect" height="3rem" />
        <Skeleton shape="rect" height="3rem" />
        <Skeleton shape="rect" height="3rem" />
        <Skeleton shape="rect" height="3rem" />
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <p className={styles.note}>
        문서 교정과 문제 변경, 문서 분석·색인과 문제 가져오기 작업, 내 풀이 기록을 최신순으로 보여
        줍니다. 내 풀이 기록은 나에게만 보입니다.
      </p>
      {KINDS.filter((kind) => lists[kind].status === 'unavailable').map((kind) => (
        <div key={kind} role="alert" className={styles.error}>
          <p>{KIND_NAMES[kind]}을(를) 불러오지 못했습니다. 잠시 후 다시 불러오세요.</p>
          <Button
            size="sm"
            loading={reloading === kind}
            onClick={async () => {
              setReloading(kind);
              await reload([kind]);
              setReloading(null);
            }}
          >
            다시 불러오기
          </Button>
        </div>
      ))}
      {retryMessage ? (
        <p
          role={retryMessage.tone}
          className={retryMessage.tone === 'alert' ? styles.error : styles.status}
        >
          {retryMessage.text}
        </p>
      ) : null}
      {entries.length === 0 ? (
        <p className={styles.empty}>아직 이력이 없습니다.</p>
      ) : (
        <ul aria-label="이력" className={styles.list}>
          {entries.map((entry) => (
            <EntryItem
              key={`${entry.kind}:${entry.item.id}`}
              entry={entry}
              workspaceId={workspaceId}
              viewerId={viewerId}
              retrying={retryingId}
              onRetry={(job) => void retry(job)}
            />
          ))}
        </ul>
      )}
      {hasMoreHistory(pages) ? (
        <Button
          size="sm"
          variant="ghost"
          className={styles.more}
          loading={loadingMore}
          onClick={() => void loadMore()}
        >
          더 보기
        </Button>
      ) : null}
      {moreFailed ? (
        <p role="alert" className={styles.status}>
          이전 기록을 불러오지 못했습니다. 다시 시도하세요.
        </p>
      ) : null}
    </div>
  );
}

function EntryItem({
  entry,
  workspaceId,
  viewerId,
  retrying,
  onRetry,
}: {
  readonly entry: HistoryEntry;
  readonly workspaceId: string;
  readonly viewerId: string | null;
  readonly retrying: string | null;
  readonly onRetry: (job: WorkspaceJob) => void;
}) {
  const kind = <Badge>{ENTRY_KIND_LABELS[entry.kind]}</Badge>;
  if (entry.kind === 'activity') {
    return <ActivityItem kind={kind} activity={entry.item} viewerId={viewerId} />;
  }
  if (entry.kind === 'job') {
    return (
      <JobItem
        kind={kind}
        job={entry.item}
        retrying={retrying === entry.item.id}
        onRetry={onRetry}
      />
    );
  }
  return <AttemptItem kind={kind} attempt={entry.item} workspaceId={workspaceId} />;
}

function ActivityItem({
  kind,
  activity,
  viewerId,
}: {
  readonly kind: ReactNode;
  readonly activity: Activity;
  readonly viewerId: string | null;
}) {
  const revision = revisionLabel(activity);
  return (
    <li className={styles.item} data-kind="activity">
      <div className={styles.itemMain}>
        {kind} <span className={styles.event}>{eventLabel(activity.event_type)}</span>{' '}
        <span>{targetLabel(activity.target_type, activity.target_label)}</span>{' '}
        {revision ? <Badge>{revision}</Badge> : null}
      </div>{' '}
      <div className={styles.meta}>
        <span>{actorLabel(activity.actor, viewerId)}</span> <span aria-hidden="true">·</span>{' '}
        <HistoryTime iso={activity.created_at} />
      </div>
    </li>
  );
}

function JobItem({
  kind,
  job,
  retrying,
  onRetry,
}: {
  readonly kind: ReactNode;
  readonly job: WorkspaceJob;
  readonly retrying: boolean;
  readonly onRetry: (job: WorkspaceJob) => void;
}) {
  const cause = jobCauseLabel(job);
  const retryability = retryabilityLabel(job);
  const target = targetLabel(job.target_type, job.target_label);
  return (
    <li className={styles.item} data-kind="job">
      <div className={styles.itemMain}>
        {kind} <span className={styles.event}>{jobTypeLabel(job.job_type)}</span>{' '}
        <span>{target}</span>{' '}
        <Badge tone={jobStatusTone(job.status)}>{jobStatusLabel(job.status)}</Badge>
      </div>{' '}
      {cause ? (
        <p className={styles.cause}>
          <span>
            원인: <span className={styles.causeText}>{cause}</span>
          </span>{' '}
          <span aria-hidden="true">·</span> <span>{retryability}</span>
        </p>
      ) : null}{' '}
      <div className={styles.meta}>
        <span>시작</span> <HistoryTime iso={job.created_at} />
      </div>
      {job.retryable ? (
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="primary"
            loading={retrying}
            aria-label={`다시 시도: ${target}`}
            onClick={() => onRetry(job)}
          >
            다시 시도
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function AttemptItem({
  kind,
  attempt,
  workspaceId,
}: {
  readonly kind: ReactNode;
  readonly attempt: WorkspaceAttempt;
  readonly workspaceId: string;
}) {
  // Opens the question's practice panel on the home, keeping the open dialogs.
  const search = useSearchParams();
  const href = `/workspaces/${workspaceId}${patchSearch(search.toString(), {
    question: attempt.question_id,
  })}`;
  return (
    <li className={styles.item} data-kind="attempt">
      <div className={styles.itemMain}>
        {kind}{' '}
        <Link href={href} scroll={false} className={`${styles.link} qz-focus-ring`}>
          {questionLabel(attempt.question_number)}
        </Link>{' '}
        <Badge tone={attemptResultTone(attempt.result)}>{attemptResultLabel(attempt.result)}</Badge>{' '}
        <Badge>{`버전 ${attempt.revision_version}`}</Badge>
      </div>{' '}
      <div className={styles.meta}>
        <span>제출</span> <HistoryTime iso={attempt.submitted_at} />
      </div>
    </li>
  );
}

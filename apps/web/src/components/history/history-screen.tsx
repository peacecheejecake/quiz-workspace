'use client';

// HISTORY-01 `/workspaces/:workspaceId/history` (docs/screens/history-jobs.md): three labelled
// regions — 변경 이력 (who changed which document/question, when, and which revision), 작업 (async
// jobs with their cause, retryability and a retry action) and 풀이 이력 (the signed-in user's own
// attempts). The first page of each comes from the server; older pages and the retry go through
// the BFF relays. Every state is text (never color alone); times are <time datetime>.
import { Badge, Button, PageHeader } from '@quiz/ui';
import Link from 'next/link';
import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  createHistoryClient,
  retryFailureMessage,
  type HistoryItems,
  type HistoryKind,
} from '@/lib/history/client';
import type { HistoryLoads } from '@/lib/history/data';
import {
  actorLabel,
  appendPage,
  attemptResultLabel,
  attemptResultTone,
  eventLabel,
  formatHistoryTime,
  jobCauseLabel,
  jobStatusLabel,
  jobStatusTone,
  jobTypeLabel,
  questionLabel,
  retryabilityLabel,
  revisionLabel,
  targetLabel,
  type Activity,
  type HistoryLoad,
  type HistoryPage,
  type WorkspaceAttempt,
  type WorkspaceJob,
} from '@/lib/history/model';
import styles from './history.module.css';

export interface HistoryScreenProps {
  readonly workspaceId: string;
  /** Verified id of the signed-in user (entries of this actor read "나"). */
  readonly viewerId: string | null;
  readonly initial: HistoryLoads;
}

type ListState<T> =
  { readonly status: 'ok'; readonly page: HistoryPage<T> } | { readonly status: 'unavailable' };

function HistoryTime({ iso }: { readonly iso: string }) {
  return <time dateTime={iso}>{formatHistoryTime(iso)}</time>;
}

function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

interface HistoryList<T> {
  readonly state: ListState<T>;
  readonly loadingMore: boolean;
  readonly moreFailed: boolean;
  readonly loadMore: () => Promise<void>;
  readonly reload: () => Promise<boolean>;
}

/** One list's state with "더 보기" and a reload of its first page. */
function useHistoryList<K extends HistoryKind>(
  workspaceId: string,
  kind: K,
  initial: HistoryLoad<HistoryItems[K]>,
): HistoryList<HistoryItems[K]> {
  type T = HistoryItems[K];
  const client = useMemo(() => createHistoryClient(), []);
  const [state, setState] = useState<ListState<T>>(initial);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);

  const fetchPage = (cursor?: string) => client.list(workspaceId, kind, cursor);

  async function loadMore() {
    if (state.status !== 'ok' || !state.page.nextCursor) return;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const next = await fetchPage(state.page.nextCursor);
      setState((current) =>
        current.status === 'ok' ? { status: 'ok', page: appendPage(current.page, next) } : current,
      );
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  async function reload(): Promise<boolean> {
    try {
      const page = await fetchPage();
      setState({ status: 'ok', page });
      setMoreFailed(false);
      return true;
    } catch {
      return false;
    }
  }

  return { state, loadingMore, moreFailed, loadMore, reload };
}

interface SectionProps<T> {
  readonly title: string;
  readonly note?: string;
  readonly emptyText: string;
  readonly list: HistoryList<T>;
  readonly wide?: boolean;
  readonly footer?: ReactNode;
  readonly children: (items: readonly T[]) => ReactNode;
}

function HistorySection<T extends { readonly id: string }>({
  title,
  note,
  emptyText,
  list,
  wide,
  footer,
  children,
}: SectionProps<T>) {
  const headingId = useId();
  const [reloading, setReloading] = useState(false);
  const { state } = list;
  return (
    <section
      aria-labelledby={headingId}
      className={wide ? `${styles.section} ${styles.wide}` : styles.section}
    >
      <div className={styles.sectionHeader}>
        <h2 id={headingId} className={styles.sectionTitle}>
          {title}
        </h2>
        {note ? <p className={styles.sectionNote}>{note}</p> : null}
      </div>
      {state.status === 'unavailable' ? (
        <div role="alert" className={styles.error}>
          <p>{title}을(를) 불러오지 못했습니다. 잠시 후 다시 불러오세요.</p>
          <Button
            size="sm"
            loading={reloading}
            onClick={async () => {
              setReloading(true);
              await list.reload();
              setReloading(false);
            }}
          >
            다시 불러오기
          </Button>
        </div>
      ) : state.page.items.length === 0 ? (
        <p className={styles.empty}>{emptyText}</p>
      ) : (
        <>
          <ul className={styles.list}>{children(state.page.items)}</ul>
          {state.page.nextCursor ? (
            <Button
              size="sm"
              variant="ghost"
              className={styles.more}
              loading={list.loadingMore}
              onClick={() => void list.loadMore()}
            >
              더 보기
            </Button>
          ) : null}
          {list.moreFailed ? (
            <p role="alert" className={styles.status}>
              이전 기록을 불러오지 못했습니다. 다시 시도하세요.
            </p>
          ) : null}
        </>
      )}
      {footer}
    </section>
  );
}

function ActivityItem({
  activity,
  viewerId,
}: {
  readonly activity: Activity;
  readonly viewerId: string | null;
}) {
  const revision = revisionLabel(activity);
  return (
    <li className={styles.item}>
      <div className={styles.itemMain}>
        <span className={styles.event}>{eventLabel(activity.event_type)}</span>{' '}
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
  job,
  retrying,
  onRetry,
}: {
  readonly job: WorkspaceJob;
  readonly retrying: boolean;
  readonly onRetry: (job: WorkspaceJob) => void;
}) {
  const cause = jobCauseLabel(job);
  const retryability = retryabilityLabel(job);
  const target = targetLabel(job.target_type, job.target_label);
  return (
    <li className={styles.item}>
      <div className={styles.itemMain}>
        <span className={styles.event}>{jobTypeLabel(job.job_type)}</span> <span>{target}</span>{' '}
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
  attempt,
  workspaceId,
}: {
  readonly attempt: WorkspaceAttempt;
  readonly workspaceId: string;
}) {
  const href = `/workspaces/${workspaceId}/questions?question=${encodeURIComponent(attempt.question_id)}`;
  return (
    <li className={styles.item}>
      <div className={styles.itemMain}>
        <Link href={href} className={`${styles.link} qz-focus-ring`}>
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

export function HistoryScreen({ workspaceId, viewerId, initial }: HistoryScreenProps) {
  const client = useMemo(() => createHistoryClient(), []);
  const activities = useHistoryList(workspaceId, 'activities', initial.activities);
  const jobs = useHistoryList(workspaceId, 'jobs', initial.jobs);
  const attempts = useHistoryList(workspaceId, 'attempts', initial.attempts);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryMessage, setRetryMessage] = useState<{
    readonly tone: 'status' | 'alert';
    readonly text: string;
  } | null>(null);

  async function retry(job: WorkspaceJob) {
    setRetryingId(job.id);
    setRetryMessage(null);
    try {
      await client.retry(job, newIdempotencyKey());
      setRetryMessage({
        tone: 'status',
        text: '새 작업을 시작했습니다. 실패한 작업 기록은 그대로 남습니다.',
      });
      await Promise.all([jobs.reload(), activities.reload()]);
    } catch (error) {
      setRetryMessage({ tone: 'alert', text: retryFailureMessage(error) });
      await Promise.all([jobs.reload(), activities.reload()]);
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className={styles.screen}>
      <PageHeader
        title="이력"
        description="문서 교정과 문제 변경, 색인 작업 상태, 내 풀이 기록을 확인합니다."
      />
      <div className={styles.sections}>
        <HistorySection<Activity>
          title="변경 이력"
          note="문서 교정과 문제 변경을 누가, 언제, 어느 버전으로 했는지 보여 줍니다."
          emptyText="아직 변경 이력이 없습니다."
          list={activities}
          wide
        >
          {(items) =>
            items.map((activity) => (
              <ActivityItem key={activity.id} activity={activity} viewerId={viewerId} />
            ))
          }
        </HistorySection>
        <HistorySection<WorkspaceJob>
          title="작업"
          note="문서 분석·색인과 문제 가져오기 작업입니다. 실패한 작업은 원인과 재시도 가능 여부를 표시합니다."
          emptyText="아직 실행된 작업이 없습니다."
          list={jobs}
          footer={
            retryMessage ? (
              <p
                role={retryMessage.tone}
                className={retryMessage.tone === 'alert' ? styles.error : styles.status}
              >
                {retryMessage.text}
              </p>
            ) : null
          }
        >
          {(items) =>
            items.map((job) => (
              <JobItem
                key={job.id}
                job={job}
                retrying={retryingId === job.id}
                onRetry={(j) => void retry(j)}
              />
            ))
          }
        </HistorySection>
        <HistorySection<WorkspaceAttempt>
          title="풀이 이력"
          note="내 풀이 기록은 나에게만 보입니다."
          emptyText="아직 이 Workspace에서 푼 문제가 없습니다."
          list={attempts}
        >
          {(items) =>
            items.map((attempt) => (
              <AttemptItem key={attempt.id} attempt={attempt} workspaceId={workspaceId} />
            ))
          }
        </HistorySection>
      </div>
    </div>
  );
}

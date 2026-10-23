'use client';

// QGEN-MULTI batch results page `/questions/generate?batch=<id>` (docs/screens/
// questions-generation.md "묶음 변형 출제", QGEN-01-AC06..AC08): the whole batch's progress
// (finished sources out of all) and one group per source with its run's state, draft and
// registered counts and a `초안 검토` link into that run's ordinary review page
// (`?source=&run=&batch=`), where drafts are reviewed, approved and registered as for a single
// generation. Nothing here registers anything. While any run works the page re-reads the batch.
import { Badge, Button, PageHeader, ProgressBar } from '@quiz/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { loginRedirectPath } from '@/lib/auth/routes';
import {
  batchPath,
  createGenerationClient,
  GenerationApiError,
  generatePath,
  runFailureMessage,
  type GenerationBatch,
} from '@/lib/questions/generation-client';
import { batchItemStatus, batchProgress, VARIATION_LABELS } from '@/lib/questions/generation-model';
import { WorkspaceBackLink, WorkspaceBreadcrumb } from '@/components/workspaces/sub-page-nav';
import styles from './question-generation.module.css';

/** How often a working batch is re-read. */
export const BATCH_POLL_MS = 2000;

export interface GenerationBatchViewProps {
  readonly workspaceId: string;
  readonly workspaceName?: string;
  readonly batchId: string;
  /** null: not found here (deleted workspace data, another workspace's id) or not loaded. */
  readonly initialBatch: GenerationBatch | null;
  readonly loadFailed: boolean;
}

export function GenerationBatchView({
  workspaceId,
  workspaceName = 'Workspace',
  batchId,
  initialBatch,
  loadFailed,
}: GenerationBatchViewProps) {
  const router = useRouter();
  const client = useMemo(() => createGenerationClient(), []);
  const [batch, setBatch] = useState<GenerationBatch | null>(initialBatch);
  const [failed, setFailed] = useState(loadFailed);
  const working = batch?.status === 'working';

  // Re-read a working batch every BATCH_POLL_MS (each new batch schedules the next read); a
  // failed read stops until the reviewer asks again.
  useEffect(() => {
    if (!working || failed) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      client.getBatch(workspaceId, batchId, controller.signal).then(setBatch, (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof GenerationApiError && error.kind === 'unauthenticated') {
          router.replace(loginRedirectPath(batchPath(workspaceId, batchId)));
          return;
        }
        setFailed(true);
      });
    }, BATCH_POLL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [client, workspaceId, batchId, working, failed, batch, router]);

  const header = (
    <PageHeader
      back={<WorkspaceBackLink workspaceId={workspaceId} />}
      breadcrumb={
        <WorkspaceBreadcrumb
          workspace={{ id: workspaceId, name: workspaceName }}
          trail={[{ label: '묶음 변형 출제' }]}
        />
      }
      title="묶음 변형 출제"
      description="원본마다 만든 변형 초안을 원본별로 검토하세요. 승인한 초안만 문제은행에 등록됩니다."
      actions={
        <Button asChild>
          <Link href={`/workspaces/${workspaceId}/questions/bank`}>문제은행</Link>
        </Button>
      }
    />
  );

  if (!batch) {
    return (
      <div className={styles.screen}>
        {header}
        <div role="alert" className={styles.failure}>
          <p>
            {loadFailed
              ? '묶음 결과를 불러오지 못했습니다.'
              : '묶음 변형 출제를 찾을 수 없습니다. 이 Workspace의 묶음이 아니거나 접근 권한이 없습니다.'}
          </p>
          {loadFailed ? (
            <Button size="sm" onClick={() => router.refresh()}>
              다시 불러오기
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const progress = batchProgress(batch);
  const types = batch.items[0]?.run.variation_types.map((t) => VARIATION_LABELS[t]).join('·');

  return (
    <div className={styles.screen}>
      {header}
      <section className={styles.progressBox} aria-labelledby="qgen-batch-summary">
        <h2 id="qgen-batch-summary" className={styles.sectionTitle}>
          {batch.mode === 'random' ? '임의 선택' : '선택한 문제'} {batch.run_count}개
          {types ? <span className={styles.count}> · {types}</span> : null}
        </h2>
        <p className={styles.progressText} role="status">
          {working
            ? `변형 초안 생성 중 · 원본 ${batch.finished_run_count}/${batch.run_count}개 완료`
            : `생성 완료 · 초안 ${batch.draft_count}개 · 등록 ${batch.published_count}개`}
        </p>
        <ProgressBar
          className={styles.progress}
          label="묶음 생성 진행률"
          value={progress}
          valueText={`원본 ${batch.run_count}개 중 ${batch.finished_run_count}개 완료`}
        />
        {batch.mode === 'random' && batch.requested_count > batch.run_count ? (
          <p className={styles.muted}>
            조건에 맞는 확정 문제가 {batch.run_count}개뿐이라 {batch.requested_count}개 대신{' '}
            {batch.run_count}개를 골랐습니다.
          </p>
        ) : null}
      </section>

      {failed ? (
        <div role="alert" className={styles.failure}>
          <p>진행 상태를 새로 불러오지 못했습니다.</p>
          <Button size="sm" onClick={() => setFailed(false)}>
            다시 불러오기
          </Button>
        </div>
      ) : null}

      <ul aria-label="원본별 변형 결과" className={styles.batchGroups}>
        {batch.items.map((item) => {
          const { run, source } = item;
          const previewId = `qgen-batch-source-${item.position}`;
          const failure = run.status === 'failed' || run.status === 'cancelled';
          return (
            <li
              key={run.id}
              className={styles.batchGroup}
              data-state={failure ? 'failed' : run.status}
            >
              <div className={styles.batchGroupHeader}>
                <span className={styles.pickMeta}>
                  {source.question_number ? <Badge>{source.question_number}번</Badge> : null}
                  <Badge
                    tone={failure ? 'danger' : run.status === 'succeeded' ? 'success' : 'neutral'}
                  >
                    {batchItemStatus(run)}
                  </Badge>
                </span>
                <Link
                  className={styles.link}
                  href={generatePath(workspaceId, source.question_id, run.id, batch.id)}
                  aria-describedby={previewId}
                >
                  초안 검토
                </Link>
              </div>
              <p id={previewId} className={styles.pickStem}>
                {source.preview}
              </p>
              {failure ? (
                <p className={styles.batchGroupStatus}>
                  {runFailureMessage(run.error_code ?? run.status)}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

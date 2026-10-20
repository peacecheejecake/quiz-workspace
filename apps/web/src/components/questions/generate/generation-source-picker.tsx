// QGEN-01 without a source (`/questions/generate` from the overview, or an unknown `?source=`):
// pick one of the workspace's CONFIRMED questions to vary. Each entry links to `?source=<id>`.
import { Badge, Button, EmptyState, PageHeader } from '@quiz/ui';
import Link from 'next/link';
import { QUESTION_TYPE_LABELS, type Question } from '@/lib/questions/form';
import { generatePath } from '@/lib/questions/generation-client';
import { WorkspaceBackLink, WorkspaceBreadcrumb } from '@/components/workspaces/sub-page-nav';
import styles from './question-generation.module.css';

export interface GenerationSourcePickerProps {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly candidates: readonly Question[];
  readonly sourceMissing: boolean;
  readonly loadFailed: boolean;
  /** The list was cut at this many questions. */
  readonly limit: number;
}

export function GenerationSourcePicker({
  workspaceId,
  workspaceName,
  candidates,
  sourceMissing,
  loadFailed,
  limit,
}: GenerationSourcePickerProps) {
  const bank = `/workspaces/${workspaceId}/questions/bank`;
  return (
    <div className={styles.screen}>
      <PageHeader
        back={<WorkspaceBackLink workspaceId={workspaceId} />}
        breadcrumb={
          <WorkspaceBreadcrumb
            workspace={{ id: workspaceId, name: workspaceName }}
            trail={[{ label: '문제 변형 출제' }]}
          />
        }
        title="문제 변형 출제"
        description="변형할 확정 문제를 고르세요. 문제은행의 문제 상세에서 '변형 출제'를 눌러도 됩니다."
        actions={
          <Button asChild>
            <Link href={bank}>문제은행</Link>
          </Button>
        }
      />
      {sourceMissing ? (
        <p role="alert" className={styles.alert}>
          원본 문제를 찾을 수 없습니다. 삭제되었거나 이 Workspace의 문제가 아닙니다.
        </p>
      ) : null}
      {loadFailed ? (
        <div role="alert" className={styles.failure}>
          <p>문제 목록을 불러오지 못했습니다.</p>
          <Button asChild size="sm">
            <Link href={generatePath(workspaceId)}>다시 불러오기</Link>
          </Button>
        </div>
      ) : candidates.length === 0 ? (
        <EmptyState
          title="변형할 확정 문제가 없습니다"
          description="문제은행에서 문제를 등록하고 확정하면 여기에서 변형할 수 있습니다."
          action={
            <Button asChild variant="primary">
              <Link href={bank}>문제은행으로 이동</Link>
            </Button>
          }
        />
      ) : (
        <section className={styles.drafts} aria-labelledby="qgen-pick-title">
          <h2 id="qgen-pick-title" className={styles.sectionTitle}>
            원본으로 쓸 문제 고르기
          </h2>
          <ul className={styles.pickList}>
            {candidates.map((q) => (
              <li key={q.id}>
                <Link href={generatePath(workspaceId, q.id)} className={styles.pickItem}>
                  <span className={styles.pickMeta}>
                    {q.question_number ? <Badge>{q.question_number}번</Badge> : null}
                    <Badge>{QUESTION_TYPE_LABELS[q.question_type]}</Badge>
                    {q.chapter ? <span className={styles.muted}>{q.chapter.title}</span> : null}
                  </span>
                  <span className={styles.pickStem}>{q.revision.stem}</span>
                </Link>
              </li>
            ))}
          </ul>
          {candidates.length >= limit ? (
            <p className={styles.muted}>
              최근 {limit}개만 보여 줍니다. 다른 문제는 문제은행에서 찾아 &lsquo;변형 출제&rsquo;를
              눌러 주세요.
            </p>
          ) : null}
        </section>
      )}
    </div>
  );
}

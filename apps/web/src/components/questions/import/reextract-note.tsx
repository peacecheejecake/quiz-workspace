// UX12-REEXTRACT-AC02/AC03: how a re-extracted draft relates to what came before. A changed stem
// escapes the duplicate flag, so the note names the earlier question, links it and offers to
// archive it; nothing is applied by itself.
import { Badge, Button } from '@quiz/ui';
import Link from 'next/link';
import { changedText, type DraftPrevious } from '@/lib/questions/reextract';
import { workspaceHomePath } from '@/lib/workspaces/home';
import styles from './question-import.module.css';

export function ReextractNote({
  workspaceId,
  previous,
  canArchive,
  onArchive,
}: {
  readonly workspaceId: string;
  readonly previous: DraftPrevious | null;
  readonly canArchive: boolean;
  readonly onArchive: (previous: DraftPrevious) => void;
}) {
  if (!previous) {
    return (
      <p className={styles.duplicate}>
        <Badge>새 문제</Badge> <span>이전 추출에 없던 문제입니다.</span>
      </p>
    );
  }
  const text = changedText(previous);
  if (!text) return null;
  const questionId = previous.question_id;
  return (
    <p className={styles.duplicate}>
      <Badge tone="warning">변경됨</Badge> <span>{text}</span>
      {questionId ? (
        <>
          <Link
            href={workspaceHomePath(workspaceId, `question=${encodeURIComponent(questionId)}`)}
            className={styles.link}
          >
            이전 문제 보기
          </Link>
          {canArchive ? (
            <Button size="sm" onClick={() => onArchive(previous)}>
              이전 문제 보관
            </Button>
          ) : null}
        </>
      ) : null}
    </p>
  );
}

'use client';

// QPLAY-01 Floating Practice Panel — shell built by M5.4 for QOV-01 (open from a dot, modal,
// Escape/close returns focus to the dot, favorite/retry in the header). Opening it starts a
// practice session, which is what records the view (never the hover preview). The session never
// carries answers; answering, grading, self-grade and previous/next are M5.5's (QPLAY-01).
import {
  Button,
  FavoriteToggle,
  FloatingSidePanel,
  RetryToggle,
  questionTypeLabels,
} from '@quiz/ui';
import { useEffect, useState, type ComponentProps } from 'react';
import {
  openPracticeSessionAction,
  type PracticeSession,
  type StudyActionResult,
} from '@/lib/questions/practice-actions';
import styles from './practice-panel.module.css';

export interface PracticeQuestion {
  readonly id: string;
  /** `3장 12번 문제`: names the dialog (same title as the dot's label). */
  readonly title: string;
  readonly chapterTitle: string;
  readonly questionType: keyof typeof questionTypeLabels;
  /** Overview preview (first lines of the stem), shown until the session arrives. */
  readonly preview: string;
  readonly isFavorite: boolean;
  readonly needsRetry: boolean;
}

export interface PracticePanelProps {
  readonly workspaceId: string;
  /** The open question; null = closed. */
  readonly question: PracticeQuestion | null;
  /** Archived workspace: no session, no study-state changes (the API refuses them too). */
  readonly readOnly: boolean;
  /** `data-screen-id` of the panel body (QPLAY-01). */
  readonly screenId?: string;
  readonly onClose: () => void;
  /** Favorite / retry toggled in the header. */
  readonly onFlagsChange: (
    questionId: string,
    flags: { is_favorite?: boolean; needs_retry?: boolean },
  ) => void;
  /** A session was opened: the server recorded the view. */
  readonly onViewed: (questionId: string) => void;
  /** Where focus goes when the panel closes (the opening dot). */
  readonly onCloseAutoFocus?: ComponentProps<typeof FloatingSidePanel>['onCloseAutoFocus'];
}

type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly session: PracticeSession }
  | { readonly status: 'error'; readonly message: string };

interface Opening {
  readonly questionId: string | null;
  /** Idempotency key of this opening: a re-run effect (Strict Mode, retry) reuses it. */
  readonly key: string;
}

function newKey(): string {
  return crypto.randomUUID();
}

export function PracticePanel({
  workspaceId,
  question,
  readOnly,
  screenId,
  onClose,
  onFlagsChange,
  onViewed,
  onCloseAutoFocus,
}: PracticePanelProps) {
  const questionId = question?.id ?? null;
  // The last open question keeps rendering while the panel animates closed.
  const [shown, setShown] = useState(question);
  if (question && question !== shown) setShown(question);

  const [opening, setOpening] = useState<Opening>(() => ({ questionId, key: newKey() }));
  if (opening.questionId !== questionId) {
    setOpening({ questionId, key: newKey() });
  }
  const [session, setSession] = useState<SessionState & { readonly key: string | null }>({
    status: 'loading',
    key: null,
  });

  useEffect(() => {
    const id = opening.questionId;
    if (!id || readOnly) return;
    let current = true;
    const key = opening.key;
    void openPracticeSessionAction(workspaceId, id, key).then(
      (result: StudyActionResult<PracticeSession>) => {
        if (result.ok) onViewed(id);
        if (!current) return;
        setSession(
          result.ok
            ? { status: 'ready', session: result.data, key }
            : { status: 'error', message: result.message, key },
        );
      },
      () => {
        if (current) {
          setSession({ status: 'error', message: '문제를 불러오지 못했습니다.', key });
        }
      },
    );
    return () => {
      current = false;
    };
    // onViewed is a stable callback of the screen; the opening identifies the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening, readOnly, workspaceId]);

  const view = shown;
  const state: SessionState =
    session.key === opening.key ? session : { status: 'loading' as const };

  return (
    <FloatingSidePanel
      open={question !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={view?.title ?? '문제'}
      description={
        view ? `${questionTypeLabels[view.questionType]} · ${view.chapterTitle}` : undefined
      }
      closeLabel="패널 닫기"
      onCloseAutoFocus={onCloseAutoFocus}
      headerActions={
        view && !readOnly ? (
          <>
            <FavoriteToggle
              pressed={view.isFavorite}
              onPressedChange={(pressed) => onFlagsChange(view.id, { is_favorite: pressed })}
            />
            <RetryToggle
              pressed={view.needsRetry}
              onPressedChange={(pressed) => onFlagsChange(view.id, { needs_retry: pressed })}
            />
          </>
        ) : undefined
      }
    >
      {view ? (
        <div className={styles.body} data-screen-id={screenId}>
          {readOnly ? (
            <>
              <p className={styles.notice}>
                보관된 Workspace는 읽기 전용입니다. 문제를 풀거나 학습 상태를 바꿀 수 없습니다.
              </p>
              <p className={styles.stem}>{view.preview}</p>
            </>
          ) : state.status === 'ready' ? (
            <>
              <p className={styles.stem}>{state.session.stem}</p>
              {state.session.options.length > 0 ? (
                <ol className={styles.options} aria-label="보기">
                  {state.session.options.map((option) => (
                    <li key={option.id}>{option.text}</li>
                  ))}
                </ol>
              ) : null}
            </>
          ) : state.status === 'error' ? (
            <div role="alert" className={styles.error}>
              <p>{state.message}</p>
              <Button onClick={() => setOpening((o) => ({ ...o, key: newKey() }))}>
                다시 시도
              </Button>
            </div>
          ) : (
            <div aria-busy="true">
              <p className={styles.stem}>{view.preview}</p>
              <p className={styles.loading}>문제를 불러오는 중입니다…</p>
            </div>
          )}
        </div>
      ) : null}
    </FloatingSidePanel>
  );
}

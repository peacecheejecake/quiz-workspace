'use client';

// UX7-BANK-2 "문제 상세" (docs/screens/questions-practice.md "정답·해설·이력 보기", QPLAY-01-AC09/AC10,
// QOV-01-AC15; QVIEW-01 call sites 4–5): the practice panel menu's 정답·해설 보기 / 수정 이력·출처 and
// the 보관·초안 문제 rows open one question in QuestionViewer `manage` mode. This opener reads the
// full question (answers included) only when the dialog opens, through the same read API the bank
// used (any member, archived workspaces too); the practice session never carries it. Read-only:
// an opener may add its own actions in `footer`.
import { useEffect, useState, type ReactNode } from 'react';
import { getQuestionAction } from '@/lib/questions/actions';
import type { QuestionDetail } from '@/lib/questions/form';
import { QuestionViewer, type DetailFocus, type ManageLoad } from '../viewer/question-viewer';

export type { DetailFocus };

export interface DetailTarget {
  readonly questionId: string;
  readonly focus: DetailFocus;
  /** Shown as the dialog description, e.g. "3번 문제 · 객관식 · 1장". */
  readonly description?: string;
  /** Where focus goes back on close (the opener's button), when it is still on the page. */
  readonly returnFocus?: HTMLElement | null;
}

export interface QuestionDetailDialogProps {
  readonly workspaceId: string;
  /** Null while closed. */
  readonly target: DetailTarget | null;
  readonly onClose: () => void;
  /** The workspace's documents, for the source titles. */
  readonly documents: readonly { readonly id: string; readonly title: string }[];
  /** Opener actions for the loaded question (the 보관·초안 문제 dialog's editor actions). */
  readonly footer?: (question: QuestionDetail) => ReactNode;
  /** A new value re-reads the question (after the opener changed it). */
  readonly reloadKey?: number;
}

export function QuestionDetailDialog({
  workspaceId,
  target,
  onClose,
  documents,
  footer,
  reloadKey = 0,
}: QuestionDetailDialogProps) {
  // The last target keeps rendering while the dialog animates closed.
  const [shown, setShown] = useState(target);
  // Every opening (and 다시 시도) reads the question again.
  const [attempt, setAttempt] = useState(0);
  if (target && target !== shown) {
    setShown(target);
    setAttempt((n) => n + 1);
  }
  const [load, setLoad] = useState<ManageLoad & { readonly key: string | null }>({
    status: 'loading',
    key: null,
  });
  const questionId = target?.questionId ?? null;
  const loadKey = questionId ? `${questionId}:${reloadKey}:${attempt}` : null;

  useEffect(() => {
    if (!questionId || !loadKey) return;
    let live = true;
    getQuestionAction(workspaceId, questionId).then(
      (result) => {
        if (!live) return;
        setLoad(
          result.ok
            ? { status: 'ready', question: result.data, key: loadKey }
            : { status: 'error', message: result.message, key: loadKey },
        );
      },
      () => {
        if (live)
          setLoad({ status: 'error', message: '문제를 불러오지 못했습니다.', key: loadKey });
      },
    );
    return () => {
      live = false;
    };
  }, [workspaceId, questionId, loadKey]);

  // A re-read (reloadKey) keeps showing the last question until the new one arrives.
  const [lastReady, setLastReady] = useState<QuestionDetail | null>(null);
  if (load.status === 'ready' && load.question !== lastReady) setLastReady(load.question);
  const current: ManageLoad =
    load.key === loadKey
      ? load
      : lastReady && lastReady.id === questionId
        ? { status: 'ready', question: lastReady }
        : { status: 'loading' };

  return (
    <QuestionViewer
      mode="manage"
      workspaceId={workspaceId}
      open={target !== null}
      onClose={onClose}
      description={shown?.description}
      focus={target?.focus ?? shown?.focus ?? 'answers'}
      returnFocus={shown?.returnFocus ?? null}
      load={current}
      onRetry={() => setAttempt((n) => n + 1)}
      documents={documents}
      {...(footer ? { footer } : {})}
    />
  );
}

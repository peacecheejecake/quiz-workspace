'use client';

// UX7-BANK-2 "문제 상세" (docs/screens/questions-practice.md "정답·해설·이력 보기", QPLAY-01-AC09/AC10,
// QOV-01-AC15): the retired QBANK-01 detail panel's read view as a modal dialog — type, status,
// version, the active revision with its correct options, accepted answers, rubric and
// explanation, the source links into the PDF viewer and the revision history with a preview of
// an older revision. It reads the full question (answers included) only when it opens, through
// the same read API the bank used (any member, archived workspaces too); the practice session
// never carries it. Read-only: an opener may add its own actions in `footer`.
import { Badge, Button, ModalDialog } from '@quiz/ui';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  getQuestionAction,
  getQuestionRevisionAction,
  type QuestionRevision,
} from '@/lib/questions/actions';
import {
  PUBLICATION_STATUS_LABELS,
  QUESTION_TYPE_LABELS,
  type QuestionDetail,
} from '@/lib/questions/form';
import { documentTitle, formatDateTime, pageText, sourceHref } from '../labels';
import { RevisionView } from '../question-detail';
import styles from './question-detail-dialog.module.css';

/** Which part of the detail the opener asked for: focus goes to its heading. */
export type DetailFocus = 'answers' | 'history';

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

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly question: QuestionDetail }
  | { readonly status: 'error'; readonly message: string };

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
  const historyRef = useRef<HTMLHeadingElement>(null);
  const [load, setLoad] = useState<Load & { readonly key: string | null }>({
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
  const current: Load =
    load.key === loadKey
      ? load
      : lastReady && lastReady.id === questionId
        ? { status: 'ready', question: lastReady }
        : { status: 'loading' };
  const question = current.status === 'ready' ? current.question : null;

  return (
    <ModalDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="문제 상세"
      description={shown?.description}
      onOpenAutoFocus={(event) => {
        if (target?.focus !== 'history') return;
        event.preventDefault();
        historyRef.current?.focus();
      }}
      onCloseAutoFocus={(event) => {
        const back = shown?.returnFocus;
        if (back?.isConnected) {
          event.preventDefault();
          back.focus();
        }
      }}
      footer={question && footer ? footer(question) : undefined}
    >
      <div className={styles.detail}>
        {current.status === 'error' ? (
          <div role="alert" className={styles.alert}>
            <p>{current.message}</p>
            <Button onClick={() => setAttempt((n) => n + 1)}>다시 시도</Button>
          </div>
        ) : question ? (
          <>
            <div className={styles.meta}>
              <Badge>{QUESTION_TYPE_LABELS[question.question_type]}</Badge>
              <Badge tone={question.publication_status === 'CONFIRMED' ? 'success' : 'warning'}>
                {PUBLICATION_STATUS_LABELS[question.publication_status]}
              </Badge>
              <span>버전 {question.revision.version}</span>
            </div>
            <RevisionView
              revision={question.revision}
              type={question.question_type}
              heading="문제"
            />
          </>
        ) : (
          <p className={styles.text} role="status">
            문제를 불러오는 중입니다.
          </p>
        )}

        <section className={styles.section} aria-labelledby="question-detail-sources">
          <h3 id="question-detail-sources" className={styles.heading}>
            출처
          </h3>
          {question ? (
            <Sources workspaceId={workspaceId} question={question} documents={documents} />
          ) : null}
        </section>

        <section className={styles.section} aria-labelledby="question-detail-history">
          <h3
            id="question-detail-history"
            ref={historyRef}
            tabIndex={-1}
            className={styles.heading}
          >
            수정 이력
          </h3>
          {question ? (
            <History
              key={`${question.id}:${question.revision.id}`}
              workspaceId={workspaceId}
              question={question}
            />
          ) : null}
        </section>
      </div>
    </ModalDialog>
  );
}

function Sources({
  workspaceId,
  question,
  documents,
}: {
  readonly workspaceId: string;
  readonly question: QuestionDetail;
  readonly documents: readonly { readonly id: string; readonly title: string }[];
}) {
  if (question.sources.length === 0) {
    return <p className={styles.text}>연결된 출처가 없습니다.</p>;
  }
  return (
    <ul className={styles.plainList}>
      {question.sources.map((source, i) => {
        const href = sourceHref(workspaceId, source);
        const text =
          `${documentTitle(documents, source.document_id)} ${pageText(source) ?? ''}`.trim();
        return (
          <li key={`${source.document_id ?? 'none'}-${i}`}>
            {href ? (
              <Link href={href} className={styles.sourceLink}>
                {text}
              </Link>
            ) : (
              text
            )}
          </li>
        );
      })}
    </ul>
  );
}

function History({
  workspaceId,
  question,
}: {
  readonly workspaceId: string;
  readonly question: QuestionDetail;
}) {
  const [selected, setSelected] = useState(question.revision.id);
  const [past, setPast] = useState<{ id: string; revision: QuestionRevision } | null>(null);
  const [pastError, setPastError] = useState<string | null>(null);

  async function show(revisionId: string) {
    setSelected(revisionId);
    setPastError(null);
    if (revisionId === question.revision.id) {
      setPast(null);
      return;
    }
    if (past?.id === revisionId) return;
    const result = await getQuestionRevisionAction(workspaceId, question.id, revisionId);
    if (result.ok) setPast({ id: revisionId, revision: result.data });
    else setPastError(result.message);
  }

  return (
    <>
      <ul className={styles.plainList}>
        {question.revisions.map((r) => (
          <li key={r.id}>
            <Button
              size="sm"
              className={styles.revisionButton}
              aria-pressed={selected === r.id}
              onClick={() => void show(r.id)}
            >
              버전 {r.version}
              {r.id === question.revision.id ? ' (현재)' : ''} · {formatDateTime(r.created_at)}
            </Button>
          </li>
        ))}
      </ul>
      {pastError ? <p role="alert">{pastError}</p> : null}
      {past && selected === past.id ? (
        <div className={styles.revisionPreview}>
          <RevisionView
            revision={past.revision}
            type={question.question_type}
            heading={`버전 ${past.revision.version} 내용`}
          />
        </div>
      ) : null}
    </>
  );
}

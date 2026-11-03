'use client';

// QuestionViewer `manage` mode (QVIEW-01 call sites 4–5, UX7-BANK-2 "문제 상세", QPLAY-01-AC09/AC10,
// QOV-01-AC15): one question with its answers in a modal dialog over the panel or list that opened
// it — type, status, version, the active revision with its correct options, accepted answers,
// rubric and explanation, the source links into the PDF viewer and the revision history with a
// preview of an older revision. No submit UI and nothing is recorded; the opener's own actions go
// in `footer`. The opener reads the question (QuestionDetailDialog): its answers are never cached
// here.
import { Badge, Button, ModalDialog } from '@quiz/ui';
import Link from 'next/link';
import { useRef, useState, type ReactNode } from 'react';
import { getQuestionRevisionAction, type QuestionRevision } from '@/lib/questions/actions';
import {
  PUBLICATION_STATUS_LABELS,
  QUESTION_TYPE_LABELS,
  type QuestionDetail,
} from '@/lib/questions/form';
import { documentTitle, formatDateTime, pageText, sourceHref } from '../labels';
import { QuestionBody } from './question-body';
import styles from './question-viewer.module.css';

/** Which part the opener asked for: focus goes to its heading. */
export type DetailFocus = 'answers' | 'history';

export type ManageLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly question: QuestionDetail }
  | { readonly status: 'error'; readonly message: string };

export interface ManageViewerProps {
  readonly workspaceId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  /** The dialog description, e.g. "3장 1번 문제 · 객관식 · 1장". */
  readonly description?: string;
  readonly focus: DetailFocus;
  /** Where focus goes back on close (the opener's button), when it is still on the page. */
  readonly returnFocus?: HTMLElement | null;
  readonly load: ManageLoad;
  readonly onRetry: () => void;
  /** The workspace's documents, for the source titles. */
  readonly documents: readonly { readonly id: string; readonly title: string }[];
  /** Opener actions for the loaded question (the 보관·초안 문제 dialog's editor actions). */
  readonly footer?: (question: QuestionDetail) => ReactNode;
  /** Focus this highlight's mark in the explanation (`내 하이라이트` › `위치로 이동`). */
  readonly focusHighlight?: string | null;
}

export function ManageViewer({
  workspaceId,
  open,
  onClose,
  description,
  focus,
  returnFocus,
  load,
  onRetry,
  documents,
  footer,
  focusHighlight = null,
}: ManageViewerProps) {
  const historyRef = useRef<HTMLHeadingElement>(null);
  const question = load.status === 'ready' ? load.question : null;
  return (
    <ModalDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="문제 상세"
      description={description}
      onOpenAutoFocus={(event) => {
        // A highlight to go to takes focus once it is drawn (ExplanationText).
        if (focus !== 'history') return;
        event.preventDefault();
        historyRef.current?.focus();
      }}
      onCloseAutoFocus={(event) => {
        if (returnFocus?.isConnected) {
          event.preventDefault();
          returnFocus.focus();
        }
      }}
      footer={question && footer ? footer(question) : undefined}
    >
      <div className={styles.detail}>
        {load.status === 'error' ? (
          <div role="alert" className={styles.alert}>
            <p>{load.message}</p>
            <Button onClick={onRetry}>다시 시도</Button>
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
            <QuestionBody
              kind="revision"
              revision={question.revision}
              type={question.question_type}
              heading="문제"
              highlighting={
                // HILITE-01: the reader's highlights of the current explanation (not of drafts).
                question.publication_status !== 'DRAFT'
                  ? {
                      questionId: question.id,
                      revisionId: question.revision.id,
                      chapterTitle: question.chapter?.title ?? null,
                      focusId: focusHighlight,
                    }
                  : null
              }
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
  // Past revisions are immutable: cache each one by id. Only the latest selection's failure shows,
  // so a late response of an earlier click never replaces the preview or its error.
  const [loaded, setLoaded] = useState<ReadonlyMap<string, QuestionRevision>>(() => new Map());
  const [pastError, setPastError] = useState<{ id: string; message: string } | null>(null);
  const latest = useRef(selected);

  async function show(revisionId: string) {
    latest.current = revisionId;
    setSelected(revisionId);
    setPastError(null);
    if (revisionId === question.revision.id || loaded.has(revisionId)) return;
    const result = await getQuestionRevisionAction(workspaceId, question.id, revisionId);
    if (result.ok) {
      setLoaded((prev) => new Map(prev).set(revisionId, result.data));
    } else if (latest.current === revisionId) {
      setPastError({ id: revisionId, message: result.message });
    }
  }

  const past = selected === question.revision.id ? undefined : loaded.get(selected);
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
      {pastError && pastError.id === selected ? <p role="alert">{pastError.message}</p> : null}
      {past ? (
        <div className={styles.revisionPreview}>
          <QuestionBody
            kind="revision"
            revision={past}
            type={question.question_type}
            heading={`버전 ${past.version} 내용`}
          />
        </div>
      ) : null}
    </>
  );
}

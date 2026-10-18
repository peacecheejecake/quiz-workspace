'use client';

// WS-VIEW-01 published questions: one list item per CONFIRMED question; a click opens the
// read-only preview in a non-modal FloatingSidePanel with the options, the correct answer, the
// explanation and the source pages. There is no answer input, favourite, retry or edit control,
// and opening a question records nothing (the shared API has no write route at all).
import { Badge, Button, FloatingSidePanel } from '@quiz/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RevisionView } from '@/components/questions/question-detail';
import { NO_CHAPTER_TITLE, pageText } from '@/components/questions/labels';
import { QUESTION_TYPE_LABELS } from '@/lib/questions/form';
import type {
  SharedClient,
  SharedDocumentSummary,
  SharedQuestion,
  SharedQuestionList,
} from '@/lib/shared/client';
import { endsShareView, sharedFailureMessage } from '@/lib/shared/messages';
import { sharedDocumentHref } from '@/lib/shared/view-state';
import styles from './shared.module.css';

export interface SharedQuestionsProps {
  readonly shareId: string;
  readonly client: SharedClient;
  readonly documents: readonly SharedDocumentSummary[];
  readonly onUnavailable: () => void;
}

type ListState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly items: readonly SharedQuestion[] };

export function SharedQuestions({
  shareId,
  client,
  documents,
  onUnavailable,
}: SharedQuestionsProps) {
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [cursor, setCursor] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    client.questions(null, controller.signal).then(
      (page: SharedQuestionList) => {
        setList({ status: 'ready', items: page.items });
        setCursor(page.next_cursor);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (endsShareView(error)) onUnavailable();
        else setList({ status: 'error', message: sharedFailureMessage(error) });
      },
    );
    return () => controller.abort();
  }, [client, attempt, onUnavailable]);

  const loadMore = async () => {
    if (!cursor || list.status !== 'ready') return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await client.questions(cursor);
      const seen = new Set(list.items.map((q) => q.id));
      setList({
        status: 'ready',
        items: [...list.items, ...page.items.filter((q) => !seen.has(q.id))],
      });
      setCursor(page.next_cursor);
    } catch (error) {
      if (endsShareView(error)) onUnavailable();
      else setMoreError(sharedFailureMessage(error));
    } finally {
      setLoadingMore(false);
    }
  };

  const items = list.status === 'ready' ? list.items : [];
  const open = items.find((q) => q.id === openId) ?? null;

  return (
    <section className={styles.card} aria-labelledby="shared-questions-title">
      <h2 id="shared-questions-title" className={styles.cardTitle}>
        문제
      </h2>
      {list.status === 'loading' ? (
        <p className={styles.note} role="status">
          문제를 불러오는 중입니다…
        </p>
      ) : null}
      {list.status === 'error' ? (
        <div className={styles.alert} role="alert">
          <p>{list.message}</p>
          <Button
            size="sm"
            onClick={() => {
              setList({ status: 'loading' });
              setAttempt((n) => n + 1);
            }}
          >
            다시 시도
          </Button>
        </div>
      ) : null}
      {list.status === 'ready' && items.length === 0 ? (
        <p className={styles.note}>공유된 문제가 없습니다.</p>
      ) : null}
      {items.length > 0 ? (
        <ul className={styles.questionList} aria-label="문제 목록">
          {items.map((q, index) => (
            <li key={q.id} className={styles.questionItem}>
              <button
                type="button"
                className={`${styles.questionButton} qz-focus-ring`}
                aria-haspopup="dialog"
                aria-current={q.id === openId || undefined}
                onClick={() => setOpenId(q.id)}
              >
                <span className={styles.questionNumber}>{q.question_number ?? index + 1}</span>
                <span className={styles.questionStem}>{q.revision.stem}</span>
                <span className={styles.questionMeta}>
                  {QUESTION_TYPE_LABELS[q.question_type]} · {q.chapter?.title ?? NO_CHAPTER_TITLE}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {cursor && list.status === 'ready' ? (
        <div className={styles.more}>
          <Button size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? '불러오는 중…' : '문제 더 보기'}
          </Button>
          {moreError ? <p role="alert">{moreError}</p> : null}
        </div>
      ) : null}

      <SharedQuestionPanel
        shareId={shareId}
        question={open}
        documents={documents}
        onClose={() => setOpenId(null)}
      />
    </section>
  );
}

function SharedQuestionPanel({
  shareId,
  question,
  documents,
  onClose,
}: {
  readonly shareId: string;
  readonly question: SharedQuestion | null;
  readonly documents: readonly SharedDocumentSummary[];
  readonly onClose: () => void;
}) {
  return (
    <FloatingSidePanel
      modal={false}
      open={question !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={question?.question_number ? `${question.question_number}번 문제` : '문제 미리보기'}
      description={
        question
          ? `${QUESTION_TYPE_LABELS[question.question_type]} · ${question.chapter?.title ?? NO_CHAPTER_TITLE} · 조회 전용`
          : undefined
      }
      closeLabel="패널 닫기"
      mobileLayout="full"
    >
      {question ? (
        <div className={styles.panelBody}>
          <div className={styles.panelMeta}>
            <Badge>{QUESTION_TYPE_LABELS[question.question_type]}</Badge>
          </div>
          <RevisionView revision={question.revision} type={question.question_type} heading="문제" />
          <section className={styles.panelSection} aria-labelledby="shared-question-sources">
            <h3 id="shared-question-sources" className={styles.panelHeading}>
              출처
            </h3>
            {question.sources.length === 0 ? (
              <p className={styles.note}>연결된 출처가 없습니다.</p>
            ) : (
              <ul className={styles.sourceList}>
                {question.sources.map((source, i) => {
                  const doc = documents.find((d) => d.id === source.document_id);
                  const text = `${doc?.title ?? '출처 문서'} ${pageText(source) ?? ''}`.trim();
                  return (
                    <li key={`${source.document_id ?? 'none'}-${i}`}>
                      {doc ? (
                        <Link
                          href={sharedDocumentHref(shareId, doc.id, { page: source.page_start })}
                          className={`${styles.sourceLink} qz-focus-ring`}
                        >
                          {text}
                        </Link>
                      ) : (
                        text
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </FloatingSidePanel>
  );
}

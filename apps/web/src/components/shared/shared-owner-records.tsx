'use client';

// `공유자의 기록` (UX12-SHARE-AC07, docs/workspace-sharing.md §12): on a link whose owner opted in, the
// guest reads the owner's attempts and highlights in a modal panel. Read only: rows hold no action
// but opening the published question. The owner is only ever called 공유자; the API sends no
// identity. A link turned off meanwhile answers 404: the panel then says the records are gone.
import { Badge, Button, FloatingSidePanel, Skeleton } from '@quiz/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SharedApiError,
  type SharedClient,
  type SharedDocumentSummary,
  type SharedOwnerAttempt,
  type SharedOwnerHighlight,
  type SharedQuestion,
} from '@/lib/shared/client';
import { endsShareView, sharedFailureMessage } from '@/lib/shared/messages';
import { SharedQuestionPanel } from './shared-questions';
import styles from './shared.module.css';

export interface SharedOwnerRecordsProps {
  readonly shareId: string;
  readonly client: SharedClient;
  readonly documents: readonly SharedDocumentSummary[];
  readonly onUnavailable: () => void;
}

const TITLE = '공유자의 기록';
const RESULT_LABEL: Readonly<Record<SharedOwnerAttempt['result'], string>> = {
  correct: '정답',
  incorrect: '오답',
  pending: '채점 전',
};
const RESULT_TONE: Readonly<
  Record<SharedOwnerAttempt['result'], 'success' | 'danger' | 'neutral'>
> = { correct: 'success', incorrect: 'danger', pending: 'neutral' };
const COLOR_LABEL: Readonly<Record<SharedOwnerHighlight['color'], string>> = {
  yellow: '노랑',
  blue: '파랑',
  pink: '분홍',
};

export function SharedOwnerRecords({
  shareId,
  client,
  documents,
  onUnavailable,
}: SharedOwnerRecordsProps) {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  return (
    <section className={styles.card} aria-labelledby="shared-owner-records-title">
      <h2 id="shared-owner-records-title" className={styles.cardTitle}>
        {TITLE}
      </h2>
      <p className={styles.note}>이 Workspace를 공유한 사람의 풀이 이력과 하이라이트입니다.</p>
      <div>
        <Button ref={openerRef} size="sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>
          기록 보기
        </Button>
      </div>
      <FloatingSidePanel
        open={open}
        onOpenChange={setOpen}
        title={TITLE}
        description="읽기 전용 · 공유자가 이 링크에 공개한 기록입니다."
        closeLabel="공유자의 기록 닫기"
        mobileLayout="full"
      >
        {open ? (
          <RecordsContent
            shareId={shareId}
            client={client}
            documents={documents}
            onUnavailable={onUnavailable}
          />
        ) : null}
      </FloatingSidePanel>
    </section>
  );
}

function RecordsContent({ shareId, client, documents, onUnavailable }: SharedOwnerRecordsProps) {
  const [question, setQuestion] = useState<SharedQuestion | null>(null);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const attempts = useCallback(
    (cursor: string | null, signal: AbortSignal) => client.ownerAttempts(cursor, signal),
    [client],
  );
  const highlights = useCallback(
    (cursor: string | null, signal: AbortSignal) => client.ownerHighlights(cursor, signal),
    [client],
  );

  const openQuestion = async (questionId: string, trigger: HTMLElement) => {
    triggerRef.current = trigger;
    setQuestionError(null);
    try {
      setQuestion(await client.question(questionId));
    } catch (error) {
      if (endsShareView(error)) onUnavailable();
      else setQuestionError('문제를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
  };

  const covered = question !== null;
  return (
    <>
      <div className={styles.panelBody} inert={covered || undefined}>
        {questionError ? (
          <p className={styles.note} role="alert">
            {questionError}
          </p>
        ) : null}
        <RecordList
          heading="풀이 이력"
          empty="공개된 풀이 이력이 없습니다."
          load={attempts}
          onUnavailable={onUnavailable}
          renderItem={(attempt: SharedOwnerAttempt) => (
            <li key={attempt.id} className={styles.recordRow}>
              <QuestionButton
                question={attempt.question}
                onOpen={(trigger) => void openQuestion(attempt.question.question_id, trigger)}
              />
              <p className={styles.recordMeta}>
                <Badge tone={RESULT_TONE[attempt.result]}>{RESULT_LABEL[attempt.result]}</Badge>
                <span>{formatTime(attempt.submitted_at)}</span>
              </p>
            </li>
          )}
        />
        <RecordList
          heading="하이라이트"
          empty="공개된 하이라이트가 없습니다."
          load={highlights}
          onUnavailable={onUnavailable}
          renderItem={(highlight: SharedOwnerHighlight) => (
            <li key={highlight.id} className={styles.recordRow}>
              <blockquote className={styles.recordQuote} data-color={highlight.color}>
                {highlight.quote}
              </blockquote>
              {highlight.question ? (
                <QuestionButton
                  question={highlight.question}
                  onOpen={(trigger) => {
                    if (highlight.question) {
                      void openQuestion(highlight.question.question_id, trigger);
                    }
                  }}
                />
              ) : (
                <p className={styles.recordMeta}>
                  <span>정리 노트 · {highlight.chapter_title}</span>
                </p>
              )}
              <p className={styles.recordMeta}>
                <span>{COLOR_LABEL[highlight.color]}</span>
                <span>{formatTime(highlight.created_at)}</span>
              </p>
            </li>
          )}
        />
      </div>
      <SharedQuestionPanel
        shareId={shareId}
        question={question}
        documents={documents}
        onClose={() => setQuestion(null)}
        onCloseAutoFocus={(event) => {
          const trigger = triggerRef.current;
          triggerRef.current = null;
          if (trigger?.isConnected) {
            event.preventDefault();
            trigger.focus();
          }
        }}
      />
    </>
  );
}

function QuestionButton({
  question,
  onOpen,
}: {
  readonly question: SharedOwnerAttempt['question'];
  readonly onOpen: (trigger: HTMLElement) => void;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      borderless
      aria-haspopup="dialog"
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {question.number_label} · {question.stem_preview}
    </Button>
  );
}

interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

type ListState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'gone' }
  | {
      readonly status: 'ready';
      readonly items: readonly T[];
      readonly next: string | null;
      readonly loadingMore: boolean;
    };

function RecordList<T>({
  heading,
  empty,
  load,
  onUnavailable,
  renderItem,
}: {
  readonly heading: string;
  readonly empty: string;
  readonly load: (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>;
  readonly onUnavailable: () => void;
  readonly renderItem: (item: T) => React.ReactNode;
}) {
  const [state, setState] = useState<ListState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const moreController = useRef<AbortController | null>(null);

  const failed = useCallback(
    (error: unknown) => {
      if (endsShareView(error)) onUnavailable();
      else if (error instanceof SharedApiError && error.kind === 'notFound') {
        setState({ status: 'gone' });
      } else setState({ status: 'error', message: sharedFailureMessage(error) });
    },
    [onUnavailable],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(null, controller.signal).then(
      (page) =>
        setState({
          status: 'ready',
          items: page.items,
          next: page.next_cursor,
          loadingMore: false,
        }),
      (error: unknown) => {
        if (!controller.signal.aborted) failed(error);
      },
    );
    return () => {
      controller.abort();
      moreController.current?.abort();
    };
  }, [load, attempt, failed]);

  const loadMore = (cursor: string) => {
    setState((s) => (s.status === 'ready' ? { ...s, loadingMore: true } : s));
    const controller = new AbortController();
    moreController.current = controller;
    load(cursor, controller.signal).then(
      (page) =>
        setState((s) =>
          s.status === 'ready'
            ? {
                status: 'ready',
                items: [...s.items, ...page.items],
                next: page.next_cursor,
                loadingMore: false,
              }
            : s,
        ),
      (error: unknown) => {
        if (!controller.signal.aborted) failed(error);
      },
    );
  };

  return (
    <section className={styles.panelSection} aria-label={heading}>
      <h3 className={styles.panelHeading}>{heading}</h3>
      {state.status === 'loading' ? (
        <div aria-busy="true">
          <p className="qz-visually-hidden" role="status">
            {heading}을 불러오는 중입니다.
          </p>
          <Skeleton width="100%" height="3rem" shape="rect" />
        </div>
      ) : null}
      {state.status === 'gone' ? (
        <p className={styles.note}>공유자가 기록 공개를 중지했습니다.</p>
      ) : null}
      {state.status === 'error' ? (
        <div className={styles.alert} role="alert">
          <p>{state.message}</p>
          <Button
            size="sm"
            onClick={() => {
              setState({ status: 'loading' });
              setAttempt((n) => n + 1);
            }}
          >
            다시 시도
          </Button>
        </div>
      ) : null}
      {state.status === 'ready' && state.items.length === 0 ? (
        <p className={styles.note}>{empty}</p>
      ) : null}
      {state.status === 'ready' && state.items.length > 0 ? (
        <ul className={styles.recordList}>{state.items.map(renderItem)}</ul>
      ) : null}
      {state.status === 'ready' && state.next ? (
        <div>
          <Button
            size="sm"
            loading={state.loadingMore}
            onClick={() => {
              if (state.next) loadMore(state.next);
            }}
          >
            더 보기
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(date);
}

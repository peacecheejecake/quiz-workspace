'use client';

// WS-VIEW-01 `정리 노트` card and read-only panel (CHNOTE-01-AC04, docs/workspace-sharing.md §8):
// the card lists the chapters whose newest note matches its source questions (the API leaves out
// the rest); a chapter button opens the note in a non-modal panel
// (`/share/:id?panel=chapter-note&chapter=:chapterId`) with the same folded "정답·해설 포함"
// body. A guest gets no versions, status, errors or actions; a note that no longer matches its
// questions (404) shows only "정리 노트가 갱신 중이거나 없습니다.". Footnotes open the share page's
// read-only question panel.
import { Badge, Button, FloatingSidePanel, Skeleton } from '@quiz/ui';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ChapterNoteBody } from '@/components/questions/notes/chapter-note-body';
import noteStyles from '@/components/questions/notes/chapter-note.module.css';
import { metaLine, NOTE_TEXT } from '@/lib/notes/model';
import {
  SharedApiError,
  type SharedChapterNote,
  type SharedChapterNoteList,
  type SharedClient,
  type SharedDocumentSummary,
  type SharedQuestion,
} from '@/lib/shared/client';
import { endsShareView, sharedFailureMessage } from '@/lib/shared/messages';
import { sharedNoteChapterOf, withSharedNote } from '@/lib/shared/view-state';
import { SharedQuestionPanel } from './shared-questions';
import styles from './shared.module.css';

export interface SharedChapterNotesProps {
  readonly shareId: string;
  readonly client: SharedClient;
  readonly documents: readonly SharedDocumentSummary[];
  readonly onUnavailable: () => void;
}

type ListState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly list: SharedChapterNoteList };

export function SharedChapterNotes({
  shareId,
  client,
  documents,
  onUnavailable,
}: SharedChapterNotesProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const chapterId = sharedNoteChapterOf(searchParams);
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    client.chapterNotes(controller.signal).then(
      (next) => setList({ status: 'ready', list: next }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (endsShareView(error)) onUnavailable();
        else setList({ status: 'error', message: sharedFailureMessage(error) });
      },
    );
    return () => controller.abort();
  }, [client, attempt, onUnavailable]);

  const navigate = (next: string | null, push: boolean) => {
    const url = `${pathname}${withSharedNote(window.location.search, next)}`;
    if (push) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
  };

  const items = list.status === 'ready' ? list.list.items : [];
  const listedTitle = items.find((i) => i.chapter_id === chapterId)?.chapter_title;

  return (
    <section className={styles.card} aria-labelledby="shared-notes-title">
      <h2 id="shared-notes-title" className={styles.cardTitle}>
        {NOTE_TEXT.title}
      </h2>
      {list.status === 'loading' ? (
        <p className={styles.note} role="status">
          정리 노트를 불러오는 중입니다…
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
        <p className={styles.note}>볼 수 있는 정리 노트가 없습니다.</p>
      ) : null}
      {items.length > 0 ? (
        <ul className={noteStyles.chapterList}>
          {items.map((item) => (
            <li key={item.chapter_id}>
              <Button
                size="sm"
                variant="ghost"
                aria-haspopup="dialog"
                aria-current={item.chapter_id === chapterId || undefined}
                onClick={() => navigate(item.chapter_id, true)}
              >
                {item.chapter_title}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <FloatingSidePanel
        open={chapterId !== undefined}
        onOpenChange={(open) => {
          if (!open) navigate(null, false);
        }}
        modal={false}
        title={NOTE_TEXT.title}
        description={title ?? listedTitle ?? undefined}
        closeLabel="정리 노트 닫기"
        mobileLayout="full"
      >
        {chapterId ? (
          <SharedNoteContent
            key={chapterId}
            shareId={shareId}
            client={client}
            chapterId={chapterId}
            documents={documents}
            onTitle={setTitle}
            onUnavailable={onUnavailable}
          />
        ) : (
          <p className={noteStyles.note}>{NOTE_TEXT.sharedMissing}</p>
        )}
      </FloatingSidePanel>
    </section>
  );
}

type NoteLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'missing' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly note: SharedChapterNote };

function SharedNoteContent({
  shareId,
  client,
  chapterId,
  documents,
  onTitle,
  onUnavailable,
}: {
  readonly shareId: string;
  readonly client: SharedClient;
  readonly chapterId: string;
  readonly documents: readonly SharedDocumentSummary[];
  readonly onTitle: (title: string | null) => void;
  readonly onUnavailable: () => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [load, setLoad] = useState<NoteLoad>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [question, setQuestion] = useState<SharedQuestion | null>(null);
  const [questionError, setQuestionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    client.chapterNote(chapterId, controller.signal).then(
      (note) => {
        setLoad({ status: 'ready', note });
        onTitle(note.chapter_title);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (endsShareView(error)) onUnavailable();
        else if (error instanceof SharedApiError && error.kind === 'notFound') {
          setLoad({ status: 'missing' });
        } else setLoad({ status: 'error', message: sharedFailureMessage(error) });
      },
    );
    return () => controller.abort();
  }, [client, chapterId, attempt, onTitle, onUnavailable]);

  const openQuestion = async (questionId: string) => {
    setQuestionError(null);
    try {
      setQuestion(await client.question(questionId));
    } catch (error) {
      if (endsShareView(error)) onUnavailable();
      else setQuestionError('문제를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
  };

  if (load.status === 'loading') {
    return (
      <div className={noteStyles.content} aria-busy="true">
        <p className="qz-visually-hidden" role="status">
          정리 노트를 불러오는 중입니다.
        </p>
        <Skeleton width="40%" />
        <Skeleton width="100%" height="6rem" shape="rect" />
      </div>
    );
  }
  if (load.status === 'missing') {
    return <p className={noteStyles.note}>{NOTE_TEXT.sharedMissing}</p>;
  }
  if (load.status === 'error') {
    return (
      <div className={noteStyles.state}>
        <p className={noteStyles.note}>{load.message}</p>
        <Button
          size="sm"
          onClick={() => {
            setLoad({ status: 'loading' });
            setAttempt((n) => n + 1);
          }}
        >
          다시 불러오기
        </Button>
      </div>
    );
  }

  const { note } = load;
  return (
    <div className={noteStyles.content}>
      <div className={noteStyles.head}>
        <div className={noteStyles.badges}>
          <Badge tone="accent">{NOTE_TEXT.aiBadge}</Badge>
          {note.stale ? <Badge tone="warning">{NOTE_TEXT.stale}</Badge> : null}
        </div>
        <p className={noteStyles.meta}>{metaLine(note.question_count, note.created_at)}</p>
      </div>
      <ChapterNoteBody
        sections={note.sections}
        footnotes={note.footnotes}
        expanded={expanded}
        onExpandedChange={setExpanded}
        // The question opens in the page's read-only panel; the link stays on this view.
        questionHref={() => `${pathname}?${searchParams.toString()}`}
        onOpenQuestion={(questionId) => void openQuestion(questionId)}
      />
      {questionError ? <p className={noteStyles.note}>{questionError}</p> : null}
      <SharedQuestionPanel
        shareId={shareId}
        question={question}
        documents={documents}
        onClose={() => setQuestion(null)}
      />
    </div>
  );
}

'use client';

// CHNOTE-01 정리 노트 panel on the workspace home (`?panel=chapter-note&chapter=<id>`,
// docs/screens/chapter-notes.md): a non-modal FloatingSidePanel for one Heatmap chapter. It opens
// at once with a skeleton, then shows the note state: none yet (editors: the send notice and
// `정리 노트 만들기`), generating (polled; the previous note stays), failed (alert + reason,
// editors `다시 시도`), or the note — `AI 생성`, "문제 n개 기준 · <시각>", the stale badge, `버전`,
// `다시 만들기` — with its body folded behind "정답·해설 포함". Every state is text, never color
// alone. Opening a question (a footnote here or a Heatmap dot) folds the body again; the
// practice panel never carries the note.
import { Badge, Button, FloatingSidePanel, Select, Skeleton } from '@quiz/ui';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import {
  createChapterNote,
  getChapterNote,
  NOTE_FAILURE_MESSAGES,
  NoteApiError,
  type NoteFailureKind,
} from '@/lib/notes/client';
import {
  batchProgress,
  failureReason,
  isActive,
  metaLine,
  NOTE_TEXT,
  noteView,
  sendNotice,
  versionLabel,
  type ChapterNoteState,
} from '@/lib/notes/model';
import { openQuestionId, QUESTION_PARAM } from '@/lib/questions/overview-filters';
import { patchSearch } from '@/lib/workspaces/home';
import { newIdempotencyKey } from '@/lib/workspaces/idempotency';
import { ChapterNoteBody } from './chapter-note-body';
import styles from './chapter-note.module.css';

/** How often a queued/running generation is re-read. */
export const NOTE_POLL_MS = 1000;
/** Longest wait between re-reads after failed ones (doubling from NOTE_POLL_MS). */
export const NOTE_POLL_MAX_MS = 15_000;

/** Delay before the next re-read after `failures` failed ones in a row. */
export function notePollDelay(failures: number): number {
  return Math.min(NOTE_POLL_MS * 2 ** Math.min(failures, 10), NOTE_POLL_MAX_MS);
}

export interface ChapterNotePanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly raiseKey?: number;
  readonly container: HTMLElement | null;
  /** The note's chapter; null for a URL without a usable chapter id ("장을 찾을 수 없습니다."). */
  readonly chapterId: string | null;
  /** The Heatmap's title for the chapter, shown until the note state arrives. */
  readonly chapterTitle?: string;
  /** Owner/editor of an active workspace (creating and regenerating). */
  readonly canEdit: boolean;
  readonly screenId?: string;
  /**
   * Opens a cited question in the practice panel (`?question=`); `returnFocus` is where focus goes
   * when that panel closes (the disclosure: the footnote itself is folded away by then).
   */
  readonly onOpenQuestion: (questionId: string, returnFocus: HTMLElement | null) => void;
  /** The chapter's generation started or ended (the Heatmap header's "만드는 중"). */
  readonly onGeneratingChange?: (chapterId: string, generating: boolean) => void;
}

export function ChapterNotePanel({
  open,
  onOpenChange,
  raiseKey,
  container,
  chapterId,
  chapterTitle,
  canEdit,
  screenId,
  onOpenQuestion,
  onGeneratingChange,
}: ChapterNotePanelProps) {
  const [title, setTitle] = useState<string | null>(null);
  return (
    <FloatingSidePanel
      open={open}
      onOpenChange={onOpenChange}
      raiseKey={raiseKey}
      modal={false}
      // The practice panel (modal) folds this one: it must stay reachable meanwhile.
      staysExposedUnderModal
      container={container}
      title={NOTE_TEXT.title}
      description={title ?? chapterTitle ?? undefined}
      closeLabel="정리 노트 닫기"
      mobileLayout="full"
    >
      <div data-screen-id={screenId}>
        {chapterId ? (
          // A new chapter starts over (folded body, newest version).
          <NoteContent
            key={chapterId}
            chapterId={chapterId}
            canEdit={canEdit}
            onTitle={setTitle}
            onOpenQuestion={onOpenQuestion}
            onGeneratingChange={onGeneratingChange}
          />
        ) : (
          <p className={styles.note}>{NOTE_TEXT.notFound}</p>
        )}
      </div>
    </FloatingSidePanel>
  );
}

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly kind: NoteFailureKind }
  | { readonly status: 'ready'; readonly data: ChapterNoteState };

function NoteContent({
  chapterId,
  canEdit,
  onTitle,
  onOpenQuestion,
  onGeneratingChange,
}: {
  readonly chapterId: string;
  readonly canEdit: boolean;
  readonly onTitle: (title: string | null) => void;
  readonly onOpenQuestion: ChapterNotePanelProps['onOpenQuestion'];
  readonly onGeneratingChange: ChapterNotePanelProps['onGeneratingChange'];
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const reasonId = useId();
  const [version, setVersion] = useState<number | null>(null);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [reload, setReload] = useState(0);
  // Failed background re-reads in a row (the poll backs off and keeps going).
  const [pollFailures, setPollFailures] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const requestingRef = useRef(false);
  const disclosureRef = useRef<HTMLButtonElement>(null);

  // A practice panel opening (from a footnote or a Heatmap dot) folds the body again.
  const questionOpen = openQuestionId(searchParams);
  const [seenQuestion, setSeenQuestion] = useState(questionOpen);
  if (seenQuestion !== questionOpen) {
    setSeenQuestion(questionOpen);
    if (questionOpen) setExpanded(false);
  }

  const data = load.status === 'ready' ? load.data : null;
  const generating = isActive(data?.generation);

  useEffect(() => {
    const controller = new AbortController();
    getChapterNote(chapterId, version, controller.signal).then(
      (state) => {
        setPollFailures(0);
        setLoad({ status: 'ready', data: state });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const kind = error instanceof NoteApiError ? error.kind : 'failed';
        // A background poll that failed keeps the last state on screen and is retried.
        if (kind === 'failed') setPollFailures((n) => n + 1);
        setLoad((prev) =>
          prev.status === 'ready' && kind === 'failed' ? prev : { status: 'error', kind },
        );
      },
    );
    return () => controller.abort();
  }, [chapterId, version, reload]);

  // Poll while a generation is queued or running; a failed re-read is retried with backoff.
  useEffect(() => {
    if (!generating) return;
    const timer = window.setTimeout(() => setReload((n) => n + 1), notePollDelay(pollFailures));
    return () => window.clearTimeout(timer);
  }, [generating, data, pollFailures]);

  useEffect(() => {
    if (data) onTitle(data.chapter_title);
  }, [data, onTitle]);

  useEffect(() => {
    if (data) onGeneratingChange?.(chapterId, isActive(data.generation));
  }, [data, chapterId, onGeneratingChange]);

  // One Idempotency-Key per intended generation: a double press or a retry after a lost response
  // replays the same one; it is renewed once that request settles.
  const keyRef = useRef<string | null>(null);
  async function create() {
    if (requestingRef.current) return;
    requestingRef.current = true;
    setRequesting(true);
    setActionError(null);
    keyRef.current ??= newIdempotencyKey();
    try {
      const state = await createChapterNote(chapterId, keyRef.current);
      keyRef.current = null;
      setVersion(null);
      setLoad({ status: 'ready', data: state });
    } catch (error) {
      const kind = error instanceof NoteApiError ? error.kind : 'failed';
      if (kind !== 'failed') keyRef.current = null;
      if (kind === 'running' || kind === 'disabled' || kind === 'noQuestions') {
        setReload((n) => n + 1);
      } else {
        setActionError(NOTE_FAILURE_MESSAGES[kind]);
      }
    } finally {
      requestingRef.current = false;
      setRequesting(false);
    }
  }

  const questionHref = (questionId: string) =>
    `${pathname}${patchSearch(searchParams.toString(), { [QUESTION_PARAM]: questionId })}`;
  const openQuestion = (questionId: string) => {
    setExpanded(false);
    onOpenQuestion(questionId, disclosureRef.current);
  };

  if (load.status === 'loading') {
    return (
      <div className={styles.content} aria-busy="true">
        <p className="qz-visually-hidden" role="status">
          정리 노트를 불러오는 중입니다.
        </p>
        <Skeleton width="40%" />
        <Skeleton width="70%" />
        <Skeleton width="100%" height="6rem" shape="rect" />
      </div>
    );
  }

  if (load.status === 'error') {
    return (
      <div className={styles.content}>
        {load.kind === 'notFound' ? (
          <p className={styles.note}>{NOTE_TEXT.notFound}</p>
        ) : (
          <div className={styles.state}>
            <p className={styles.note}>{NOTE_FAILURE_MESSAGES[load.kind]}</p>
            <Button
              size="sm"
              onClick={() => {
                setLoad({ status: 'loading' });
                setReload((n) => n + 1);
              }}
            >
              다시 불러오기
            </Button>
          </div>
        )}
      </div>
    );
  }

  const state = load.data;
  const view = noteView(state, canEdit);
  const note = state.note;
  const progress = batchProgress(state.generation);
  const newest = state.versions[0]?.version;

  // `정리 노트 만들기` / `다시 만들기` / `다시 시도`: aria-disabled with the reason when this
  // environment cannot create notes (stored notes stay readable).
  const actionButton = (label: string, variant: 'primary' | 'secondary') => (
    <Button
      size="sm"
      variant={variant}
      className={styles.disabled}
      loading={requesting}
      aria-disabled={view.createDisabled || undefined}
      aria-describedby={view.createDisabled ? reasonId : undefined}
      onClick={view.createDisabled ? undefined : () => void create()}
    >
      {label}
    </Button>
  );
  const offReason =
    view.createDisabled && (view.canCreate || view.canRegenerate || view.canRetry) ? (
      <p id={reasonId} className={styles.hint}>
        {NOTE_TEXT.unavailable}
      </p>
    ) : null;

  return (
    <div className={styles.content}>
      {note ? (
        <div className={styles.head}>
          <div className={styles.badges}>
            <Badge tone="accent">{NOTE_TEXT.aiBadge}</Badge>
            {state.stale ? <Badge tone="warning">{NOTE_TEXT.stale}</Badge> : null}
          </div>
          <p className={styles.meta}>{metaLine(note.question_count, note.created_at)}</p>
          {state.versions.length >= 2 ? (
            <Select
              label="버전"
              options={state.versions.map((v) => ({
                value: String(v.version),
                label: versionLabel(v, v.version === newest),
              }))}
              value={String(note.version)}
              onValueChange={(value) => {
                const k = Number(value);
                if (!Number.isInteger(k)) return;
                setVersion(k === newest ? null : k);
              }}
            />
          ) : null}
          {view.previous ? <p className={styles.previous}>{NOTE_TEXT.previous}</p> : null}
          {view.canRegenerate ? (
            <div className={styles.actions}>{actionButton('다시 만들기', 'secondary')}</div>
          ) : null}
          {view.canRegenerate ? offReason : null}
        </div>
      ) : view.kind === 'noQuestions' ? (
        <p className={styles.note}>{NOTE_TEXT.noQuestions}</p>
      ) : !view.generating && !view.failed ? (
        <div className={styles.state}>
          <p className={styles.status}>{NOTE_TEXT.empty}</p>
          {view.canCreate ? (
            <>
              <p className={styles.hint}>{sendNotice(state.confirmed_question_count)}</p>
              {actionButton('정리 노트 만들기', 'primary')}
              {offReason}
            </>
          ) : null}
        </div>
      ) : null}

      {view.generating ? (
        <p className={styles.status} role="status">
          {NOTE_TEXT.generating}
          {progress ? ` (${progress})` : ''}
        </p>
      ) : null}

      {view.failed ? (
        <div className={styles.alert} role="alert">
          <p className={styles.alertTitle}>{NOTE_TEXT.failed}</p>
          <p>{failureReason(state.generation?.error_code)}</p>
          {view.canRetry ? (
            <>
              {actionButton('다시 시도', 'secondary')}
              {offReason}
            </>
          ) : null}
        </div>
      ) : null}

      {actionError ? (
        <p className={styles.note} role="alert">
          {actionError}
        </p>
      ) : null}

      {note ? (
        <ChapterNoteBody
          sections={note.sections}
          footnotes={note.footnotes}
          expanded={expanded}
          onExpandedChange={setExpanded}
          disclosureRef={disclosureRef}
          questionHref={questionHref}
          onOpenQuestion={openQuestion}
        />
      ) : null}
    </div>
  );
}

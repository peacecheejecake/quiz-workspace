'use client';

// UX7-BANK-2 보관·초안 문제 (docs/screens/questions-overview.md "보관·초안 문제 dialog", QOV-01-AC15):
// the body of the home's floating dialog (`?panel=inactive-questions`). It brings back the retired
// QBANK-01 page's status filters for the questions the heatmap never shows — 초안 (DRAFT) and
// 보관됨 (ARCHIVED), `전체` = both — with its 50-row "더 보기" paging and its detail (the 문제 상세
// dialog). Editors of a non-archived workspace get the bank's status actions: 보관 해제 (archived →
// confirmed) and 확정 (draft → confirmed) on the rows and in the detail, plus 편집 and 삭제 there.
// A changed question leaves the list; the server actions revalidate the home, so the heatmap
// follows. Everyone else reads only; FastAPI re-checks every write.
import { Badge, Button, ConfirmDialog, EmptyState, Select, useToast } from '@quiz/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  deleteQuestionAction,
  listInactiveQuestionsAction,
  setQuestionStatusAction,
  type InactiveFilter,
} from '@/lib/questions/actions';
import {
  PUBLICATION_STATUS_LABELS,
  QUESTION_TYPE_LABELS,
  type Question,
  type QuestionDetail,
} from '@/lib/questions/form';
import { QUESTION_FAILURE_MESSAGES } from '@/lib/questions/problems';
import { QuestionDetailDialog, type DetailTarget } from '../detail/question-detail-dialog';
import { HomeQuestionEditor } from '../home-question-editor';
import { NO_CHAPTER_TITLE } from '../labels';
import type { EditorTarget } from '../question-editor';
import styles from './inactive-questions.module.css';
import { displayStem } from '@/lib/questions/display-stem';

export type InactiveReadOnly = 'viewer' | 'archived' | null;

const FILTER_OPTIONS: readonly { value: InactiveFilter; label: string }[] = [
  { value: 'INACTIVE', label: '전체' },
  { value: 'DRAFT', label: '초안' },
  { value: 'ARCHIVED', label: '보관됨' },
];

const EMPTY_TEXT: Readonly<Record<InactiveFilter, string>> = {
  INACTIVE: '보관하거나 초안인 문제가 없습니다',
  DRAFT: '초안 문제가 없습니다',
  ARCHIVED: '보관된 문제가 없습니다',
};

const READ_ONLY_TEXT: Readonly<Record<Exclude<InactiveReadOnly, null>, string>> = {
  viewer: '보기 권한으로는 문제를 볼 수만 있습니다.',
  archived: '보관된 Workspace는 읽기 전용입니다.',
};

type ListState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly items: readonly Question[];
      readonly cursor: string | null;
    };

/** "3번 문제" or the first words of the stem. */
function questionName(question: Question): string {
  if (question.question_number) return `${question.question_number}번 문제`;
  const stem = displayStem(question.revision.stem).replace(/\s+/g, ' ').trim();
  return stem.length > 30 ? `${stem.slice(0, 30)}…` : stem;
}

function describe(question: Question): string {
  return `${questionName(question)} · ${QUESTION_TYPE_LABELS[question.question_type]} · ${
    question.chapter?.title ?? NO_CHAPTER_TITLE
  }`;
}

/** The status action of a row: back to the heatmap. */
function restoreLabel(question: Question): string | null {
  if (question.publication_status === 'ARCHIVED') return '보관 해제';
  if (question.publication_status === 'DRAFT') return '확정';
  return null;
}

export function InactiveQuestions({
  workspaceId,
  readOnly,
  documents,
  refreshKey = 0,
}: {
  readonly workspaceId: string;
  readonly readOnly: InactiveReadOnly;
  readonly documents: readonly { readonly id: string; readonly title: string }[];
  /**
   * Bumped by the home when questions changed elsewhere (the practice panel archived, deleted or
   * edited one): the open list re-reads its first page in place.
   */
  readonly refreshKey?: number;
}) {
  const { toast } = useToast();
  const canEdit = readOnly === null;
  const [filter, setFilter] = useState<InactiveFilter>('INACTIVE');
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [reload, setReload] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  // List generation: a response for an older filter (or before a reload) is dropped.
  const generation = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  /** A new first page: for another filter, or the same one again (다시 시도, a stale row). */
  function restart(next: InactiveFilter = filter) {
    setList({ status: 'loading' });
    setLoadingMore(false);
    setFilter(next);
    setReload((n) => n + 1);
  }

  // A home-level change (refreshKey) restarts the list through the same reset as 다시 시도, so
  // a pending 더 보기 of the old list can never leave paging disabled.
  const [seenRefreshKey, setSeenRefreshKey] = useState(refreshKey);
  if (seenRefreshKey !== refreshKey) {
    setSeenRefreshKey(refreshKey);
    restart();
  }

  useEffect(() => {
    const requested = ++generation.current;
    listInactiveQuestionsAction(workspaceId, filter, null).then(
      (result) => {
        if (requested !== generation.current) return;
        setList(
          result.ok
            ? { status: 'ready', items: result.data.items, cursor: result.data.nextCursor }
            : { status: 'error', message: result.message },
        );
      },
      () => {
        if (requested === generation.current) {
          setList({ status: 'error', message: QUESTION_FAILURE_MESSAGES.unavailable });
        }
      },
    );
  }, [workspaceId, filter, reload]);

  async function loadMore(cursor = list.status === 'ready' ? list.cursor : null) {
    if (!cursor || loadingMore) return;
    const requested = generation.current;
    setLoadingMore(true);
    try {
      const result = await listInactiveQuestionsAction(workspaceId, filter, cursor);
      if (requested !== generation.current) return;
      if (!result.ok) {
        toast({ tone: 'error', title: result.message });
        return;
      }
      setList((prev) => {
        if (prev.status !== 'ready') return prev;
        const seen = new Set(prev.items.map((q) => q.id));
        return {
          status: 'ready',
          items: [...prev.items, ...result.data.items.filter((q) => !seen.has(q.id))],
          cursor: result.data.nextCursor,
        };
      });
    } catch {
      if (requested === generation.current) {
        toast({ tone: 'error', title: QUESTION_FAILURE_MESSAGES.unavailable });
      }
    } finally {
      if (requested === generation.current) setLoadingMore(false);
    }
  }

  // --- detail, status changes, editor, delete ------------------------------------------------
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [detailReload, setDetailReload] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ target: EditorTarget | null; session: number }>({
    target: null,
    session: 0,
  });
  const [confirmDelete, setConfirmDelete] = useState<Question | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Focus after a row leaves the list: the next row's question, else the filter.
  const focusAfter = useRef<number | null>(null);
  useLayoutEffect(() => {
    const index = focusAfter.current;
    if (index === null || list.status !== 'ready') return;
    focusAfter.current = null;
    const root = listRef.current;
    const buttons = root?.querySelectorAll<HTMLElement>('[data-row-open]');
    const target =
      buttons?.[Math.min(index, buttons.length - 1)] ??
      root?.parentElement?.querySelector<HTMLElement>('[role="combobox"]');
    target?.focus();
  });

  function removeRow(questionId: string) {
    // The last loaded row left while more remain on the server: fetch the next page at once.
    if (list.status === 'ready' && list.cursor && list.items.every((q) => q.id === questionId)) {
      void loadMore(list.cursor);
    }
    setList((prev) => {
      if (prev.status !== 'ready') return prev;
      const index = prev.items.findIndex((q) => q.id === questionId);
      if (index >= 0) focusAfter.current = index;
      return { ...prev, items: prev.items.filter((q) => q.id !== questionId) };
    });
  }

  function replaceRow(question: Question) {
    setList((prev) =>
      prev.status === 'ready'
        ? { ...prev, items: prev.items.map((q) => (q.id === question.id ? question : q)) }
        : prev,
    );
  }

  async function restore(question: Question) {
    if (busyId) return;
    const wasDraft = question.publication_status === 'DRAFT';
    setBusyId(question.id);
    try {
      const result = await setQuestionStatusAction(
        workspaceId,
        question.id,
        question.revision.id,
        'CONFIRMED',
      );
      if (!result.ok) {
        toast({ tone: 'error', title: result.message });
        if (result.kind === 'staleRevision' || result.kind === 'notFound') {
          setDetail(null);
          restart();
        }
        return;
      }
      setDetail((d) => (d?.questionId === question.id ? null : d));
      removeRow(question.id);
      toast({
        tone: 'success',
        title: wasDraft ? '문제를 확정했습니다.' : '문제를 보관 해제했습니다.',
      });
    } catch {
      toast({ tone: 'error', title: QUESTION_FAILURE_MESSAGES.unavailable });
    } finally {
      setBusyId(null);
    }
  }

  async function runDelete() {
    const question = confirmDelete;
    if (!question || deleting) return;
    setDeleting(true);
    try {
      const result = await deleteQuestionAction(workspaceId, question.id);
      if (!result.ok) {
        toast({ tone: 'error', title: result.message });
        return;
      }
      setConfirmDelete(null);
      setDetail(null);
      removeRow(question.id);
      toast({ tone: 'success', title: '문제를 삭제했습니다.' });
    } catch {
      toast({ tone: 'error', title: QUESTION_FAILURE_MESSAGES.unavailable });
    } finally {
      setDeleting(false);
    }
  }

  function detailFooter(question: QuestionDetail) {
    if (!canEdit) return null;
    const label = restoreLabel(question);
    return (
      <div className={styles.actions}>
        <Button onClick={() => setConfirmDelete(question)}>삭제</Button>
        <Button
          onClick={() => {
            setDetail(null);
            setEditor((prev) => ({
              target: { mode: 'edit', question },
              session: prev.session + 1,
            }));
          }}
        >
          편집
        </Button>
        {label ? (
          <Button
            variant="primary"
            loading={busyId === question.id}
            onClick={() => void restore(question)}
          >
            {label}
          </Button>
        ) : null}
      </div>
    );
  }

  const busy = list.status === 'loading';
  return (
    <div className={styles.body}>
      {readOnly ? <p className={styles.readOnly}>{READ_ONLY_TEXT[readOnly]}</p> : null}
      <div className={styles.toolbar}>
        <Select
          label="상태"
          options={FILTER_OPTIONS}
          value={filter}
          onValueChange={(value) => {
            const next = FILTER_OPTIONS.find((o) => o.value === value);
            if (next && next.value !== filter) restart(next.value);
          }}
        />
      </div>

      <div ref={listRef} aria-busy={busy || undefined}>
        {list.status === 'loading' ? (
          <p className={styles.status} role="status">
            문제를 불러오는 중입니다.
          </p>
        ) : list.status === 'error' ? (
          <div role="alert" className={styles.alert}>
            <p>문제 목록을 불러오지 못했습니다. {list.message}</p>
            <Button onClick={() => restart()}>다시 시도</Button>
          </div>
        ) : list.items.length === 0 && !list.cursor ? (
          <EmptyState headingLevel={3} title={EMPTY_TEXT[filter]} />
        ) : (
          <>
            <p className="qz-visually-hidden" role="status">
              문제 {list.items.length}개
            </p>
            <ul className={styles.list} aria-label="문제 목록">
              {list.items.map((question) => {
                const label = canEdit ? restoreLabel(question) : null;
                return (
                  <li key={question.id} className={styles.item}>
                    <div className={styles.itemMain}>
                      <div className={styles.meta}>
                        {question.question_number ? (
                          <span>{question.question_number}번</span>
                        ) : null}
                        <Badge>{QUESTION_TYPE_LABELS[question.question_type]}</Badge>
                        <Badge tone="warning">
                          {PUBLICATION_STATUS_LABELS[question.publication_status]}
                        </Badge>
                        <span>{question.chapter?.title ?? NO_CHAPTER_TITLE}</span>
                      </div>
                      <button
                        type="button"
                        className={styles.stemButton}
                        aria-haspopup="dialog"
                        data-row-open=""
                        onClick={(event) =>
                          setDetail({
                            questionId: question.id,
                            focus: 'answers',
                            returnFocus: event.currentTarget,
                            description: describe(question),
                          })
                        }
                      >
                        {displayStem(question.revision.stem)}
                      </button>
                    </div>
                    {label ? (
                      <div className={styles.itemActions}>
                        <Button
                          size="sm"
                          loading={busyId === question.id}
                          disabled={busyId !== null && busyId !== question.id}
                          onClick={() => void restore(question)}
                        >
                          {label}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {list.cursor ? (
              <div className={styles.more}>
                <Button onClick={() => void loadMore()} loading={loadingMore}>
                  더 보기
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <QuestionDetailDialog
        workspaceId={workspaceId}
        target={detail}
        onClose={() => setDetail(null)}
        documents={documents}
        footer={canEdit ? detailFooter : undefined}
        reloadKey={detailReload}
      />

      {canEdit ? (
        <>
          <HomeQuestionEditor
            workspaceId={workspaceId}
            target={editor.target}
            session={editor.session}
            onClose={() => setEditor((prev) => ({ ...prev, target: null }))}
            onSaved={(question, mode) => {
              if (mode !== 'edit') return;
              replaceRow(question);
              setDetailReload((n) => n + 1);
            }}
          />
          <ConfirmDialog
            open={confirmDelete !== null}
            onOpenChange={(open) => {
              if (!open && !deleting) setConfirmDelete(null);
            }}
            title="문제를 삭제할까요?"
            description="이 목록에서 사라집니다. 지난 풀이 기록은 이력으로 남습니다."
            confirmLabel="삭제"
            onConfirm={() => void runDelete()}
            loading={deleting}
          />
        </>
      ) : null}
    </div>
  );
}

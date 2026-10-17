'use client';

// QOV-01 Questions Heatmap 홈 (docs/screens/questions-overview.md, questions.md §1–§3, §7): one dot
// per CONFIRMED question grouped by chapter, the always-visible legend, status counts, filters
// mirrored in the URL with the overview API's parameter names, and the practice panel opened from
// a dot (`?question=<id>`, deep link + back/forward). Hover/focus previews never record a view:
// only opening the panel (a practice session) does. Viewers practise their own state; archived
// workspaces are read-only.
import {
  Button,
  EmptyState,
  HeatmapLegend,
  Input,
  PageHeader,
  QuestionHeatmap,
  QUESTION_DOT_STATUSES,
  questionStatusLabels,
  questionTypeLabels,
  Select,
  StatusSummary,
  useToast,
  type QuestionDotStatus,
  type QuestionType,
} from '@quiz/ui';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from 'react';
import type { ChapterChoice, OverviewItem, QuestionOverview } from '@/lib/questions/overview-data';
import {
  EMPTY_OVERVIEW_FILTERS,
  isOverviewFiltered,
  openQuestionId,
  OVERVIEW_SEARCH_MAX,
  overviewSearch,
  QUESTION_PARAM,
  type OverviewFilters,
} from '@/lib/questions/overview-filters';
import { setMyStateAction } from '@/lib/questions/practice-actions';
import { QUESTION_FAILURE_MESSAGES, type QuestionFailureKind } from '@/lib/questions/problems';
import { PracticePanel, type PracticeQuestion } from '../practice/practice-panel';
import {
  applyOverrides,
  heatmapChapters,
  optimisticStatus,
  placedTitle,
  placeQuestions,
  withOverride,
  type PlacedQuestion,
  type StudyOverride,
  type StudyPatch,
} from './overview-model';
import styles from './questions-overview.module.css';

export type OverviewReadOnly = 'viewer' | 'archived' | null;

export interface QuestionsOverviewProps {
  readonly workspaceId: string;
  /** `viewer`: no import/generate links, practice allowed. `archived`: read-only panel. */
  readonly readOnly: OverviewReadOnly;
  readonly filters: OverviewFilters;
  readonly overview: QuestionOverview;
  readonly chapterChoices: readonly ChapterChoice[];
  readonly failure: QuestionFailureKind | null;
  /** Screen id of the practice panel (`data-screen-id`, docs/screens/index.md). */
  readonly panelScreenId?: string;
}

const ALL = '__all__';
const TYPES: readonly QuestionType[] = ['MCQ', 'SHORT_ANSWER', 'ESSAY'];

/** `[data-question-id="<id>"]` inside the heatmap: where focus returns after the panel. */
export function focusQuestionDot(root: ParentNode, questionId: string): boolean {
  const id = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(questionId) : questionId;
  const dot = root.querySelector<HTMLElement>(`[data-question-id="${id}"]`);
  if (!dot) return false;
  dot.focus();
  return true;
}

export function QuestionsOverview({
  workspaceId,
  readOnly,
  filters,
  overview,
  chapterChoices,
  failure,
  panelScreenId,
}: QuestionsOverviewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [navigating, startNavigation] = useTransition();
  const canAuthor = readOnly === null;

  // Filters as last chosen: quick successive changes build on each other before the URL (and the
  // server render) catch up; a new server render with other filters resets them.
  const filtersKey = overviewSearch(filters);
  const [rendered, setRendered] = useState({ filtersKey, q: filters.q });
  const [view, setView] = useState(filters);
  const [search, setSearch] = useState(filters.q);
  if (rendered.filtersKey !== filtersKey) {
    setRendered({ filtersKey, q: filters.q });
    setView(filters);
    if (rendered.q !== filters.q) setSearch(filters.q);
  }

  // Optimistic study-state changes until the revalidated overview arrives.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, StudyOverride>>(new Map());
  const serverItems = overview.items;
  const latestItems = useRef(serverItems);
  useLayoutEffect(() => {
    latestItems.current = serverItems;
  }, [serverItems]);
  const mutationSeq = useRef(new Map<string, number>());
  const overridesRef = useRef(overrides);
  useLayoutEffect(() => {
    overridesRef.current = overrides;
  }, [overrides]);

  const items = useMemo(() => applyOverrides(serverItems, overrides), [serverItems, overrides]);
  const placed = useMemo(
    () => placeQuestions(overview.chapters, items),
    [overview.chapters, items],
  );
  const chapters = useMemo(() => heatmapChapters(placed), [placed]);

  // The practice panel follows `?question=`. A question that leaves the filtered list while open
  // (e.g. un-favorited under the favorites filter) stays in the panel until it is closed.
  const openId = openQuestionId(searchParams);
  const found = openId ? (placed.find((p) => p.item.question_id === openId) ?? null) : null;
  const [pinned, setPinned] = useState<PlacedQuestion | null>(found);
  if (found && found !== pinned) setPinned(found);
  const openPlaced = found ?? (pinned && pinned.item.question_id === openId ? pinned : null);
  const openedId = openPlaced?.item.question_id ?? null;
  const lastOpened = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (openedId) lastOpened.current = openedId;
  }, [openedId]);

  const panelQuestion = useMemo<PracticeQuestion | null>(() => {
    if (!openPlaced) return null;
    // A pinned question (no longer in the list) still shows its local changes.
    const item = found
      ? openPlaced.item
      : withOverride(openPlaced.item, overrides.get(openPlaced.item.question_id), serverItems);
    return {
      id: item.question_id,
      title: placedTitle(openPlaced),
      chapterTitle: openPlaced.chapterTitle,
      questionType: item.question_type,
      preview: item.preview,
      isFavorite: item.is_favorite,
      needsRetry: item.needs_retry,
    };
  }, [openPlaced, found, overrides, serverItems]);

  const heatmapRef = useRef<HTMLDivElement>(null);

  function setQuestionParam(questionId: string | null) {
    const params = new URLSearchParams(window.location.search);
    if (questionId) params.set(QUESTION_PARAM, questionId);
    else params.delete(QUESTION_PARAM);
    const query = params.toString();
    // A history entry per open/close: back/forward reopen or close the panel. Next.js syncs
    // `useSearchParams` with pushState without a server round trip.
    window.history.pushState(null, '', `${pathname}${query ? `?${query}` : ''}`);
  }

  function navigate(patch: Partial<OverviewFilters>) {
    const next = { ...view, ...patch };
    setView(next);
    startNavigation(() => {
      router.replace(`${pathname}${overviewSearch(next)}`, { scroll: false });
    });
  }

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ q: search.trim().slice(0, OVERVIEW_SEARCH_MAX) });
  }

  function toggleStatus(status: QuestionDotStatus) {
    const wanted = new Set(view.status);
    if (wanted.has(status)) wanted.delete(status);
    else wanted.add(status);
    navigate({ status: QUESTION_DOT_STATUSES.filter((s) => wanted.has(s)) });
  }

  const putOverride = useCallback(
    (questionId: string, seq: number, value: StudyOverride | null) => {
      if (mutationSeq.current.get(questionId) !== seq) return; // a newer change owns it
      setOverrides((prev) => {
        const next = new Map(prev);
        if (value) next.set(questionId, value);
        else next.delete(questionId);
        return next;
      });
    },
    [],
  );

  function nextSeq(questionId: string): number {
    const seq = (mutationSeq.current.get(questionId) ?? 0) + 1;
    mutationSeq.current.set(questionId, seq);
    return seq;
  }

  function currentItem(questionId: string): OverviewItem | undefined {
    return (
      items.find((i) => i.question_id === questionId) ??
      (pinned?.item.question_id === questionId
        ? withOverride(pinned.item, overrides.get(questionId), serverItems)
        : undefined)
    );
  }

  async function changeFlags(
    questionId: string,
    flags: { is_favorite?: boolean; needs_retry?: boolean },
  ) {
    const item = currentItem(questionId);
    if (!item) return;
    const seq = nextSeq(questionId);
    const optimistic: StudyPatch = {
      is_favorite: item.is_favorite,
      needs_retry: item.needs_retry,
      last_graded_result: item.last_graded_result,
      ...flags,
      status: optimisticStatus(item, flags),
    };
    putOverride(questionId, seq, { patch: optimistic, settledOn: null });
    const result = await setMyStateAction(workspaceId, questionId, flags);
    if (!result.ok) {
      putOverride(questionId, seq, null);
      toast({ tone: 'error', title: result.message });
      return;
    }
    const { status, is_favorite, needs_retry, last_graded_result } = result.data;
    putOverride(questionId, seq, {
      patch: { status, is_favorite, needs_retry, last_graded_result },
      settledOn: latestItems.current,
    });
  }

  const markViewed = useCallback(
    (questionId: string) => {
      const item = latestItems.current.find((i) => i.question_id === questionId);
      if (!item || item.status !== 'unseen') return;
      // A flag change in flight already carries the server's status; don't race it.
      if (overridesRef.current.has(questionId)) return;
      const seq = (mutationSeq.current.get(questionId) ?? 0) + 1;
      mutationSeq.current.set(questionId, seq);
      putOverride(questionId, seq, {
        patch: { status: 'viewed' },
        settledOn: latestItems.current,
      });
    },
    [putOverride],
  );

  const filtered = isOverviewFiltered(filters);
  const chapterOptions = [
    { value: ALL, label: '전체 챕터' },
    ...chapterChoices.map((c) => ({ value: c.value, label: c.title })),
  ];

  return (
    <div className={styles.screen}>
      <PageHeader
        title="문제 Heatmap"
        description="문제 하나가 점 하나입니다. 점을 눌러 바로 풀어 보세요."
        actions={
          <>
            <Button asChild>
              <Link href={`/workspaces/${workspaceId}/questions/bank`}>문제은행</Link>
            </Button>
            {canAuthor ? (
              <>
                <Button asChild>
                  <Link href={`/workspaces/${workspaceId}/questions/import`}>PDF 가져오기</Link>
                </Button>
                <Button asChild variant="primary">
                  <Link href={`/workspaces/${workspaceId}/questions/generate`}>문제 생성</Link>
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <div className={styles.filters}>
        <form role="search" className={styles.searchForm} onSubmit={onSearch}>
          <Input
            type="search"
            label="문제 검색"
            placeholder="문제 내용으로 검색"
            value={search}
            maxLength={OVERVIEW_SEARCH_MAX}
            onChange={(e) => setSearch(e.target.value)}
            autoComplete="off"
          />
          <Button type="submit">검색</Button>
        </form>
        <Select
          label="챕터"
          options={chapterOptions}
          value={view.chapter ?? ALL}
          onValueChange={(value) => navigate({ chapter: value === ALL ? null : value })}
        />
        <Select
          label="유형"
          options={[
            { value: ALL, label: '전체 유형' },
            ...TYPES.map((type) => ({ value: type, label: questionTypeLabels[type] })),
          ]}
          value={view.type ?? ALL}
          onValueChange={(value) =>
            navigate({ type: value === ALL ? null : (value as QuestionType) })
          }
        />
      </div>

      <div className={styles.stateFilters} role="group" aria-label="상태 필터">
        {QUESTION_DOT_STATUSES.map((status) => (
          <Button
            key={status}
            size="sm"
            aria-pressed={view.status.includes(status)}
            data-status={status}
            className={styles.chip}
            onClick={() => toggleStatus(status)}
          >
            <span className={styles.swatch} data-status={status} aria-hidden="true" />
            {questionStatusLabels[status]}
          </Button>
        ))}
        <Button
          size="sm"
          aria-pressed={view.favorite === true}
          className={styles.chip}
          onClick={() => navigate({ favorite: view.favorite === true ? null : true })}
        >
          즐겨찾기만
        </Button>
        <Button
          size="sm"
          aria-pressed={view.retry === true}
          className={styles.chip}
          onClick={() => navigate({ retry: view.retry === true ? null : true })}
        >
          다시 풀기만
        </Button>
        {filtered ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSearch('');
              navigate(EMPTY_OVERVIEW_FILTERS);
            }}
          >
            필터 초기화
          </Button>
        ) : null}
      </div>

      <StatusSummary counts={overview.counts} />
      <p className={styles.inFilter} role="status">
        {navigating ? '문제를 불러오는 중입니다.' : `현재 필터의 문제 ${items.length}개`}
      </p>
      <HeatmapLegend className={styles.legend} />

      {failure ? (
        <div role="alert" className={styles.loadError}>
          <p>문제 Heatmap을 불러오지 못했습니다. {QUESTION_FAILURE_MESSAGES[failure]}</p>
          <Button onClick={() => startNavigation(() => router.refresh())}>다시 시도</Button>
        </div>
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState
            title="조건에 맞는 문제가 없습니다"
            description="검색어나 필터를 바꿔 보세요."
            action={
              <Button
                onClick={() => {
                  setSearch('');
                  navigate(EMPTY_OVERVIEW_FILTERS);
                }}
              >
                필터 초기화
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="확정된 문제가 없습니다"
            description={
              canAuthor
                ? '문제를 직접 등록하거나 문제 PDF에서 가져오면 여기에 점으로 표시됩니다.'
                : '아직 이 Workspace에 확정된 문제가 없습니다.'
            }
            action={
              canAuthor ? (
                <div className={styles.emptyActions}>
                  <Button asChild variant="primary">
                    <Link href={`/workspaces/${workspaceId}/questions/bank`}>문제 등록</Link>
                  </Button>
                  <Button asChild>
                    <Link href={`/workspaces/${workspaceId}/questions/import`}>PDF 가져오기</Link>
                  </Button>
                </div>
              ) : null
            }
          />
        )
      ) : (
        <div ref={heatmapRef} className={styles.heatmap} aria-busy={navigating || undefined}>
          <QuestionHeatmap
            chapters={chapters}
            selectedQuestionId={openPlaced?.item.question_id ?? null}
            headingLevel={2}
            onOpen={(questionId) => setQuestionParam(questionId)}
          />
        </div>
      )}

      <PracticePanel
        workspaceId={workspaceId}
        question={panelQuestion}
        readOnly={readOnly === 'archived'}
        screenId={panelScreenId}
        onClose={() => setQuestionParam(null)}
        onFlagsChange={(questionId, flags) => void changeFlags(questionId, flags)}
        onViewed={markViewed}
        onCloseAutoFocus={(event) => {
          const id = lastOpened.current;
          if (id && heatmapRef.current && focusQuestionDot(heatmapRef.current, id)) {
            event.preventDefault();
          }
        }}
      />
    </div>
  );
}

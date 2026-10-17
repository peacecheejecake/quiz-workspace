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
  useEffect,
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
import { lookupOverviewQuestionAction, setMyStateAction } from '@/lib/questions/practice-actions';
import { QUESTION_FAILURE_MESSAGES, type QuestionFailureKind } from '@/lib/questions/problems';
import { PracticePanel, type PracticeQuestion } from '../practice/practice-panel';
import {
  applyOverrides,
  heatmapChapters,
  optimisticStatus,
  placedTitle,
  placeQuestions,
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
  /** `?question=` resolved outside the current filters by the server render (deep link). */
  readonly requested?: PlacedQuestion | null;
}

const ALL = '__all__';
const TYPES: readonly QuestionType[] = ['MCQ', 'SHORT_ANSWER', 'ESSAY'];

function dotOf(root: ParentNode, questionId: string): HTMLElement | null {
  const id = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(questionId) : questionId;
  return root.querySelector<HTMLElement>(`[data-question-id="${id}"]`);
}

/**
 * Focus after the practice panel closes: the dot that opened it; if that dot left the heatmap
 * (filtered out meanwhile, or a deep link outside the filters), the nearest surviving dot in the
 * heatmap order the panel was opened on, else the heatmap's tab stop, else `fallback` (a stable
 * control, e.g. the search box, for an empty heatmap). Returns the focused element.
 */
export function focusAfterPanel(
  root: ParentNode,
  openedId: string | null,
  order: readonly string[],
  fallback: HTMLElement | null,
): HTMLElement | null {
  const candidates: string[] = [];
  if (openedId) {
    candidates.push(openedId);
    const at = order.indexOf(openedId);
    if (at >= 0) {
      for (let d = 1; d < order.length; d += 1) {
        const after = order[at + d];
        const before = order[at - d];
        if (after !== undefined) candidates.push(after);
        if (before !== undefined) candidates.push(before);
        if (after === undefined && before === undefined) break;
      }
    }
  }
  let target: HTMLElement | null = null;
  for (const id of candidates) {
    target = dotOf(root, id);
    if (target) break;
  }
  target ??=
    root.querySelector<HTMLElement>('[data-question-id][tabindex="0"]') ??
    root.querySelector<HTMLElement>('[data-question-id]') ??
    fallback;
  target?.focus();
  return target;
}

export function QuestionsOverview({
  workspaceId,
  readOnly,
  filters,
  overview,
  chapterChoices,
  failure,
  panelScreenId,
  requested = null,
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

  // The practice panel follows `?question=`, independently of the filters: a question the
  // filtered list does not show (deep link under other filters, or one that left the list while
  // open, e.g. un-favorited under the favorites filter) is resolved without the filters —
  // by the server render (`requested`) or, after client-side navigation, a lookup action.
  const openId = openQuestionId(searchParams);
  const found = openId ? (placed.find((p) => p.item.question_id === openId) ?? null) : null;
  const [outside, setOutside] = useState<ReadonlyMap<string, PlacedQuestion>>(() =>
    requested ? new Map([[requested.item.question_id, requested]]) : new Map(),
  );
  const [seenRequested, setSeenRequested] = useState(requested);
  if (requested !== seenRequested) {
    setSeenRequested(requested);
    if (requested) setOutside((prev) => new Map(prev).set(requested.item.question_id, requested));
  }
  const [pinned, setPinned] = useState<PlacedQuestion | null>(found);
  if (found && found !== pinned) setPinned(found);
  const openPlaced =
    found ??
    (openId ? outside.get(openId) : undefined) ??
    (pinned && pinned.item.question_id === openId ? pinned : null);
  const openedId = openPlaced?.item.question_id ?? null;

  const lookedUp = useRef(new Set<string>());
  const needsLookup = openId !== null && openPlaced === null;
  useEffect(() => {
    if (!needsLookup || !openId || lookedUp.current.has(openId)) return;
    lookedUp.current.add(openId);
    lookupOverviewQuestionAction(workspaceId, openId).then(
      (result) => {
        const placedQuestion = result.ok ? result.data : null;
        if (placedQuestion) setOutside((prev) => new Map(prev).set(openId, placedQuestion));
      },
      () => {
        // Transport failure: the panel stays closed; a later navigation may retry.
        lookedUp.current.delete(openId);
      },
    );
  }, [needsLookup, openId, workspaceId]);

  // Where focus returns on close: the opening dot and the heatmap order it was opened on.
  const lastOpened = useRef<string | null>(null);
  const openOrder = useRef<readonly string[]>([]);
  const placedRef = useRef(placed);
  useLayoutEffect(() => {
    placedRef.current = placed;
  }, [placed]);
  useLayoutEffect(() => {
    if (!openedId) return;
    lastOpened.current = openedId;
    openOrder.current = placedRef.current.map((p) => p.item.question_id);
  }, [openedId]);

  const panelQuestion = useMemo<PracticeQuestion | null>(() => {
    if (!openPlaced) return null;
    // The panel toggles show the CONFIRMED study state (server item + settled changes), so their
    // label flips once the change is saved; the dot alone is optimistic. While a change is in
    // flight the toggles are busy. Outside the list the server overview can never catch up, so
    // a settled change always applies there.
    const id = openPlaced.item.question_id;
    const override = overrides.get(id);
    const pending = override?.settledOn === null;
    const serverItem = found ? serverItems.find((i) => i.question_id === id) : undefined;
    const base = serverItem ?? openPlaced.item;
    const settled =
      override && !pending && (!serverItem || override.settledOn === serverItems)
        ? override.patch
        : undefined;
    const item = { ...base, ...settled };
    return {
      id: item.question_id,
      title: placedTitle(openPlaced),
      chapterTitle: openPlaced.chapterTitle,
      questionType: item.question_type,
      preview: item.preview,
      isFavorite: item.is_favorite,
      needsRetry: item.needs_retry,
      savingFlags: pending,
    };
  }, [openPlaced, found, overrides, serverItems]);

  const screenRef = useRef<HTMLDivElement>(null);

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
    const listed = items.find((i) => i.question_id === questionId);
    if (listed) return listed;
    return openPlaced?.item.question_id === questionId
      ? { ...openPlaced.item, ...overrides.get(questionId)?.patch }
      : undefined;
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
    let result: Awaited<ReturnType<typeof setMyStateAction>>;
    try {
      result = await setMyStateAction(workspaceId, questionId, flags);
    } catch {
      // The request itself failed (network): roll this change back.
      result = { ok: false, kind: 'unavailable', message: QUESTION_FAILURE_MESSAGES.unavailable };
    }
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
    <div ref={screenRef} className={styles.screen}>
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
        <div className={styles.heatmap} aria-busy={navigating || undefined}>
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
          const root = screenRef.current;
          if (!root) return;
          const search = root.querySelector<HTMLElement>('input[type="search"]');
          if (focusAfterPanel(root, lastOpened.current, openOrder.current, search)) {
            event.preventDefault();
          }
        }}
      />
    </div>
  );
}

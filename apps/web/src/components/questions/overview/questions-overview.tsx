'use client';

// QOV-01 문제 영역 of the workspace home (docs/screens/questions-overview.md, questions.md §1–§3,
// §7): one dot per CONFIRMED question grouped by chapter, a collapsible status filter (collapsed by
// default; no legend or status summary since UX3c — state is in each dot's label, its preview and
// the filter's text), filters mirrored in the URL with the overview API's parameter names, and the
// practice panel opened from a dot (`?question=<id>`, deep link + back/forward). The home owns the
// filter state (search box and chapter/type live in its header). Hover/focus previews never record
// a view: only opening the panel (a practice session) does. Viewers practise their own state;
// archived workspaces are read-only.
import {
  Button,
  ChevronDownIcon,
  ChevronUpIcon,
  EmptyState,
  QuestionHeatmap,
  QUESTION_DOT_STATUSES,
  questionStatusLabels,
  useToast,
  type QuestionDotStatus,
} from '@quiz/ui';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
import type { OverviewItem, QuestionOverview } from '@/lib/questions/overview-data';
import {
  isOverviewFiltered,
  openQuestionId,
  QUESTION_PARAM,
  type OverviewFilters,
} from '@/lib/questions/overview-filters';
import { lookupOverviewQuestionAction, setMyStateAction } from '@/lib/questions/practice-actions';
import { QUESTION_FAILURE_MESSAGES, type QuestionFailureKind } from '@/lib/questions/problems';
import { PracticePanel, type PracticeQuestion } from '../practice/practice-panel';
import { neighbors, type AttemptResult } from '../practice/practice-model';
import {
  applyOverrides,
  flagsPatch,
  gradedPatch,
  heatmapChapters,
  optimisticStatus,
  placedTitle,
  placeQuestions,
  type Grading,
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
  /** The filters the server rendered `overview` with. */
  readonly filters: OverviewFilters;
  /** The filters as last chosen (ahead of the URL while a navigation is pending). */
  readonly view: OverviewFilters;
  /** A filter navigation is in flight. */
  readonly navigating: boolean;
  readonly onFiltersChange: (patch: Partial<OverviewFilters>) => void;
  /** Clears every filter, the search text included. */
  readonly onResetFilters: () => void;
  readonly overview: QuestionOverview;
  readonly failure: QuestionFailureKind | null;
  /** Toolbar actions on the right (문제 PDF 관리, 문제 생성). */
  readonly actions?: ReactNode;
  /** Screen id of the practice panel (`data-screen-id`, docs/screens/index.md). */
  readonly panelScreenId?: string;
  /** `?question=` resolved outside the current filters by the server render (deep link). */
  readonly requested?: PlacedQuestion | null;
}

/**
 * Whether a failed deep-link lookup may succeed when retried. `notFound`, `forbidden`,
 * `archived` and `invalid` are answers about the question; the rest (`unavailable`: 5xx,
 * network, timeout, unexpected conflicts) are transient.
 */
export function isRetryableLookupFailure(kind: QuestionFailureKind): boolean {
  return !['notFound', 'forbidden', 'archived', 'invalid', 'unauthenticated'].includes(kind);
}

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
  view,
  navigating,
  onFiltersChange,
  onResetFilters,
  overview,
  failure,
  actions,
  panelScreenId,
  requested = null,
}: QuestionsOverviewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [reloading, startReload] = useTransition();
  const canAuthor = readOnly === null;
  // QOV-01-AC08: the status filter is collapsed until asked for.
  const [statusOpen, setStatusOpen] = useState(false);
  const statusRegionId = useId();

  // Optimistic study-state changes until the revalidated overview arrives.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, StudyOverride>>(new Map());
  const serverItems = overview.items;
  const latestItems = useRef(serverItems);
  useLayoutEffect(() => {
    latestItems.current = serverItems;
  }, [serverItems]);
  // Study state changed since the server rendered `overview` (no action revalidates it).
  const staleOverview = useRef(false);
  // Grading results of this screen's submissions, until the server's overview catches up.
  const gradings = useRef(new Map<string, Grading>());
  useLayoutEffect(() => {
    staleOverview.current = false;
    gradings.current.clear();
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
  const itemsRef = useRef(items);
  useLayoutEffect(() => {
    itemsRef.current = items;
  }, [items]);

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
    // Only a definitive answer (found, or not a question of this workspace) is cached; a
    // transient failure (5xx, network, timeout) is forgotten so a later navigation retries.
    const transient = () => {
      lookedUp.current.delete(openId);
      toast({ tone: 'error', title: '문제를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    };
    lookupOverviewQuestionAction(workspaceId, openId).then((result) => {
      if (!result.ok) {
        if (isRetryableLookupFailure(result.kind)) transient();
        return;
      }
      const placedQuestion = result.data;
      if (placedQuestion) setOutside((prev) => new Map(prev).set(openId, placedQuestion));
    }, transient);
  }, [needsLookup, openId, workspaceId, toast]);

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

  // Previous/next follow the heatmap order under the current filters.
  const panelNeighbors = useMemo(
    () =>
      neighbors(
        placed.map((p) => p.item.question_id),
        openedId,
      ),
    [placed, openedId],
  );

  const screenRef = useRef<HTMLElement>(null);

  function setQuestionParam(questionId: string | null) {
    const params = new URLSearchParams(window.location.search);
    if (questionId) params.set(QUESTION_PARAM, questionId);
    else params.delete(QUESTION_PARAM);
    const query = params.toString();
    // A history entry per open/close/previous/next: back/forward reopen or close the panel.
    // Next.js syncs `useSearchParams` with pushState.
    window.history.pushState(null, '', `${pathname}${query ? `?${query}` : ''}`);
  }

  function toggleStatus(status: QuestionDotStatus) {
    const wanted = new Set(view.status);
    if (wanted.has(status)) wanted.delete(status);
    else wanted.add(status);
    onFiltersChange({ status: QUESTION_DOT_STATUSES.filter((s) => wanted.has(s)) });
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
      is_pending_grading: item.is_pending_grading,
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
    staleOverview.current = true;
    // A submission settled while this request was in flight wins over the response's grading.
    const grading = gradings.current.get(questionId) ?? {
      last_graded_result: result.data.last_graded_result,
      is_pending_grading: item.is_pending_grading,
    };
    putOverride(questionId, seq, {
      patch: flagsPatch(result.data, grading),
      settledOn: latestItems.current,
    });
  }

  const markViewed = useCallback(
    (questionId: string) => {
      const item = latestItems.current.find((i) => i.question_id === questionId);
      if (!item || item.status !== 'unseen') return;
      staleOverview.current = true;
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

  /**
   * The dot shows a submission's result at once (the overview is refreshed when the panel
   * closes). A flag change of the same question that is still current is kept.
   */
  function markGraded(questionId: string, result: AttemptResult) {
    const listed = itemsRef.current.find((i) => i.question_id === questionId);
    const existing = overridesRef.current.get(questionId);
    const live =
      existing && (existing.settledOn === null || existing.settledOn === latestItems.current)
        ? existing
        : undefined;
    const item =
      listed ??
      (openPlaced?.item.question_id === questionId
        ? { ...openPlaced.item, ...live?.patch }
        : undefined);
    if (!item) return;
    staleOverview.current = true;
    const graded = gradedPatch(item, result);
    gradings.current.set(questionId, {
      last_graded_result: graded.last_graded_result ?? null,
      is_pending_grading: graded.is_pending_grading ?? false,
    });
    const patch = { ...live?.patch, ...graded };
    if (live?.settledOn === null) {
      // A flag change is in flight: it owns the sequence and settles with the server's state.
      putOverride(questionId, mutationSeq.current.get(questionId) ?? 0, {
        patch,
        settledOn: null,
      });
      return;
    }
    putOverride(questionId, nextSeq(questionId), { patch, settledOn: latestItems.current });
  }

  // Whenever the panel closes (close button, Escape, browser Back), reload the overview if study
  // state changed while it was open: no practice action revalidates it. A refresh lost to a
  // quick reopen is retried on the next close.
  const wasOpen = useRef(openId !== null);
  useEffect(() => {
    const open = openId !== null;
    if (wasOpen.current && !open && staleOverview.current) router.refresh();
    wasOpen.current = open;
  }, [openId, router]);

  const filtered = isOverviewFiltered(filters);
  const stateFiltered = view.status.length > 0 || view.favorite !== null || view.retry !== null;
  const busy = navigating || reloading;

  return (
    <section ref={screenRef} className={styles.screen} aria-labelledby={`${statusRegionId}-title`}>
      <h2 id={`${statusRegionId}-title`} className="qz-visually-hidden">
        문제
      </h2>
      <div className={styles.toolbar}>
        <div className={styles.toolbarStart}>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={statusOpen}
            aria-controls={statusRegionId}
            data-filtered={stateFiltered || undefined}
            onClick={() => setStatusOpen((open) => !open)}
          >
            상태 필터
            {statusOpen ? (
              <ChevronUpIcon width={16} height={16} aria-hidden="true" />
            ) : (
              <ChevronDownIcon width={16} height={16} aria-hidden="true" />
            )}
          </Button>
          <p className={styles.inFilter} role="status">
            {busy
              ? '문제를 불러오는 중입니다.'
              : `${stateFiltered && !statusOpen ? '상태 필터 적용 중 · ' : ''}현재 필터의 문제 ${items.length}개`}
          </p>
        </div>
        {actions ? <div className={styles.toolbarActions}>{actions}</div> : null}
      </div>

      <div
        id={statusRegionId}
        className={styles.stateFilters}
        role="group"
        aria-label="상태 필터"
        hidden={!statusOpen}
      >
        {QUESTION_DOT_STATUSES.map((status) => (
          <Button
            key={status}
            size="sm"
            aria-pressed={view.status.includes(status)}
            data-status={status}
            onClick={() => toggleStatus(status)}
          >
            <span className={styles.swatch} data-status={status} aria-hidden="true" />
            {questionStatusLabels[status]}
          </Button>
        ))}
        <Button
          size="sm"
          aria-pressed={view.favorite === true}
          onClick={() => onFiltersChange({ favorite: view.favorite === true ? null : true })}
        >
          즐겨찾기만
        </Button>
        <Button
          size="sm"
          aria-pressed={view.retry === true}
          onClick={() => onFiltersChange({ retry: view.retry === true ? null : true })}
        >
          다시 풀기만
        </Button>
        {filtered ? (
          <Button size="sm" variant="ghost" onClick={onResetFilters}>
            필터 초기화
          </Button>
        ) : null}
      </div>

      {failure ? (
        <div role="alert" className={styles.loadError}>
          <p>문제 Heatmap을 불러오지 못했습니다. {QUESTION_FAILURE_MESSAGES[failure]}</p>
          <Button onClick={() => startReload(() => router.refresh())}>다시 시도</Button>
        </div>
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState
            title="조건에 맞는 문제가 없습니다"
            description="검색어나 필터를 바꿔 보세요."
            action={<Button onClick={onResetFilters}>필터 초기화</Button>}
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
                <Button asChild variant="primary">
                  <Link href={`/workspaces/${workspaceId}/questions/bank`}>문제 등록</Link>
                </Button>
              ) : null
            }
          />
        )
      ) : (
        <div className={styles.heatmap} aria-busy={busy || undefined}>
          <QuestionHeatmap
            chapters={chapters}
            selectedQuestionId={openPlaced?.item.question_id ?? null}
            headingLevel={3}
            onOpen={(questionId) => setQuestionParam(questionId)}
          />
        </div>
      )}

      <PracticePanel
        workspaceId={workspaceId}
        question={panelQuestion}
        readOnly={readOnly === 'archived'}
        screenId={panelScreenId}
        neighbors={panelNeighbors}
        onNavigate={(questionId) => setQuestionParam(questionId)}
        onClose={() => setQuestionParam(null)}
        onGraded={markGraded}
        onFlagsChange={(questionId, flags) => void changeFlags(questionId, flags)}
        onViewed={markViewed}
        onCloseAutoFocus={(event) => {
          const root = screenRef.current;
          if (!root) return;
          // An empty heatmap falls back to the status filter toggle (a stable control).
          const toggle = root.querySelector<HTMLElement>('button[aria-controls]');
          if (focusAfterPanel(root, lastOpened.current, openOrder.current, toggle)) {
            event.preventDefault();
          }
        }}
      />
    </section>
  );
}

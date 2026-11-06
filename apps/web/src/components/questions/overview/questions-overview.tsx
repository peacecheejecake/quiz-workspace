'use client';

// QOV-01 문제 영역 of the workspace home (docs/screens/questions-overview.md, questions.md §1–§3,
// §7): one dot per CONFIRMED question grouped by chapter, a collapsible status filter (collapsed by
// default; no legend or status summary since UX3c — state is in each dot's label, its preview and
// the filter's text), filters mirrored in the URL with the overview API's parameter names, and the
// practice panel opened from a dot (`?question=<id>`, deep link + back/forward). The home owns the
// filter state (search box and chapter/type live in its header). Hover/focus previews never record
// a view: only opening the panel (a practice session) does. Viewers practise their own state;
// archived workspaces are read-only.
// UX7-BANK (the retired QBANK-01's editing, docs/screens/questions-bank.md): editors open the 문제
// 등록 editor from the empty state (the home owns `?panel=question-create`), and the practice
// panel's 문제 관리 menu edits (new revision; the panel then practises it) or deletes (after a
// confirmation; the panel closes) the open question. Both server actions revalidate the home, so
// the heatmap follows; the API decides who may.
// UX7-BANK-2: the panel's header menu also reads the full question for every member (정답·해설 보기
// / 수정 이력·출처: the 문제 상세 dialog over the panel; the practice session stays answer-free), and
// editors archive the open question (보관, after a confirmation; the panel closes and the dot
// leaves; it comes back from the home's 보관·초안 문제 dialog).
// QVIEW-W: the practice panel is QuestionViewer `practice`; the home's 모의고사 range run
// (`?practice=`, QVIEW-01) is QuestionViewer `sequence`, rendered here so it shares the panel's
// 문제 관리 / 문제 정보 menu, its dialogs and the Heatmap refresh after studying.
import {
  Button,
  ConfirmDialog,
  EmptyState,
  QuestionHeatmap,
  questionTypeLabels,
  focusQuestionDotQuietly,
  useToast,
  type HeatmapChapter,
} from '@quiz/ui';
import { QuestionLineSkeleton } from '@/components/questions/question-skeleton';
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
  type RefObject,
} from 'react';
import {
  deleteQuestionAction,
  getQuestionAction,
  setQuestionStatusAction,
} from '@/lib/questions/actions';
import type { OverviewItem, QuestionOverview } from '@/lib/questions/overview-data';
import {
  isOverviewFiltered,
  openQuestionId,
  QUESTION_PARAM,
  type OverviewFilters,
} from '@/lib/questions/overview-filters';
import {
  lookupOverviewQuestionAction,
  setMyStateAction,
  type MyState,
} from '@/lib/questions/practice-actions';
import { parseRunState, type RunUrlState } from '@/lib/questions/practice-runs';
import { QUESTION_FAILURE_MESSAGES, type QuestionFailureKind } from '@/lib/questions/problems';
import { QuestionDetailDialog, type DetailTarget } from '../detail/question-detail-dialog';
import { HomeQuestionEditor } from '../home-question-editor';
import { QuestionManageMenu } from '../practice/question-manage-menu';
import { useHomeRun } from '../mock-exams/mock-run';
import type { EditorTarget } from '../question-editor';
import { neighbors, type AttemptResult } from '../viewer/practice-model';
import {
  QuestionViewer,
  type Invalidation,
  type PracticeQuestion,
} from '../viewer/question-viewer';
import { observedPracticeEpoch, practiceResetVersion } from '@/lib/questions/practice-reset-events';
import { useFlagSync } from '../viewer/use-flag-sync';
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
  /** `viewer`: no import links, practice allowed. `archived`: read-only panel. */
  readonly readOnly: OverviewReadOnly;
  /** The filters the server rendered `overview` with. */
  readonly filters: OverviewFilters;
  /** A filter navigation is in flight. */
  readonly navigating: boolean;
  /** Clears every filter, the search text included. */
  readonly onResetFilters: () => void;
  readonly overview: QuestionOverview;
  readonly failure: QuestionFailureKind | null;
  /** Screen id of the practice panel (`data-screen-id`, docs/screens/index.md). */
  readonly panelScreenId?: string;
  /** `?question=` resolved outside the current filters by the server render (deep link). */
  readonly requested?: PlacedQuestion | null;
  /** Controls at the end of each chapter group header (CHNOTE-01 정리 노트). */
  /** `hasNote`: the chapter can have a 정리 노트, so it has a document (UX12-CHAPTERADD). */
  readonly chapterActions?: (
    chapter: HeatmapChapter,
    context: { readonly hasNote: boolean },
  ) => ReactNode;
  /**
   * Where focus goes when the practice panel closes, when set by whoever opened it (a 정리 노트
   * footnote: the note's disclosure). Cleared on close; otherwise focus returns to the dot.
   */
  readonly practiceReturnFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Writes the practice panel's `?question=` (an id on open and previous/next, null on close);
   * the workspace home keeps its dialog history consistent (UX7-BACK). Without it, a new entry.
   */
  readonly onQuestionChange?: (questionId: string | null) => void;
  /** `?panel=question-create` (owned by the home): the 문제 등록 editor is open. */
  readonly createOpen?: boolean;
  /**
   * The home's dialogs listed before the practice or run panel are still opening (HOMEDLG-01: a
   * deep link's modal layers mount one at a time, in URL order): keep those panels closed meanwhile.
   */
  readonly holdPanels?: boolean;
  /**
   * The home's dialog container (inside <main>): the 문제 등록 editor is portalled there with the
   * home's other modal dialogs, so a dialog stacked over it stays exposed (HOMEDLG-01).
   */
  readonly dialogContainer?: HTMLElement | null;
  readonly onCreateOpenChange?: (open: boolean) => void;
  /** The workspace's documents, for the 문제 상세 dialog's source titles (UX7-BANK-2). */
  readonly documents?: readonly { readonly id: string; readonly title: string }[];
  /** A question was archived, deleted or edited here (the home re-reads open lists, UX7-BANK-2). */
  readonly onQuestionsChanged?: () => void;
  /** Study state changed here (viewed, graded, favorite/retry toggled; QSEARCH-CACHE). */
  readonly onStudyStateChanged?: () => void;
  /** Retries a failed overview read (client BFF or SSR refresh; QSEARCH-CACHE). */
  readonly onRetry?: () => void;
  /**
   * The range run panel (`?practice=`, QVIEW-01) moves to another step or position; the home
   * keeps its dialog history consistent. Without it (and onRunClose) there is no run panel.
   */
  readonly onRunNavigate?: (state: RunUrlState, how: 'push' | 'replace') => void;
  readonly onRunClose?: () => void;
}

const NO_DOCUMENTS: readonly { readonly id: string; readonly title: string }[] = [];

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
 * control, e.g. the search box, for an empty heatmap). Never opens the dot's preview. Returns the
 * focused element.
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
  if (target) focusQuestionDotQuietly(target);
  return target;
}

type TouchField = 'is_favorite' | 'needs_retry' | 'grading';

export function QuestionsOverview({
  workspaceId,
  readOnly,
  filters,
  navigating,
  onResetFilters,
  overview,
  failure,
  panelScreenId,
  requested = null,
  chapterActions,
  practiceReturnFocusRef,
  onQuestionChange,
  createOpen = false,
  holdPanels = false,
  dialogContainer,
  onCreateOpenChange,
  documents = NO_DOCUMENTS,
  onQuestionsChanged,
  onStudyStateChanged,
  onRetry,
  onRunNavigate,
  onRunClose,
}: QuestionsOverviewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [reloading, startReload] = useTransition();
  const canAuthor = readOnly === null;
  const titleId = useId();

  // Optimistic study-state changes until the revalidated overview arrives.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, StudyOverride>>(new Map());
  const serverItems = overview.items;
  const latestItems = useRef(serverItems);
  useLayoutEffect(() => {
    latestItems.current = serverItems;
  }, [serverItems]);
  // Study state changed since the server rendered `overview` (no action revalidates it).
  const staleOverview = useRef(false);
  const markStale = useCallback(() => {
    staleOverview.current = true;
    onStudyStateChanged?.();
  }, [onStudyStateChanged]);
  // Grading results of this screen's submissions, until the server's overview catches up.
  const gradings = useRef(new Map<string, Grading>());
  useLayoutEffect(() => {
    staleOverview.current = false;
    gradings.current.clear();
  }, [serverItems]);
  const mutationSeq = useRef(new Map<string, number>());
  // Per field of a question, when this screen last changed it (a press, a rollback, a submission):
  // a state read from the server that started earlier must not overwrite it (rereadState).
  const fieldClock = useRef(0);
  const fieldTouched = useRef(new Map<string, Partial<Record<TouchField, number>>>());
  function touch(questionId: string, ...fields: TouchField[]) {
    fieldClock.current += 1;
    const entry = fieldTouched.current.get(questionId) ?? {};
    for (const field of fields) entry[field] = fieldClock.current;
    fieldTouched.current.set(questionId, entry);
  }
  const overridesRef = useRef(overrides);
  useLayoutEffect(() => {
    overridesRef.current = overrides;
  }, [overrides]);

  const items = useMemo(() => applyOverrides(serverItems, overrides), [serverItems, overrides]);
  const placed = useMemo(
    () => placeQuestions(overview.chapters, items),
    [overview.chapters, items],
  );
  const workspaceChapters = useMemo(
    () => new Set(overview.chapters.filter((c) => c.id && !c.document_id).map((c) => c.id)),
    [overview.chapters],
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
  // A question deleted or archived here never reopens from the local state (browser Back restores
  // its `?question=`): it is treated as closed, like an unknown id — unless a newer server overview
  // than the one on screen at removal lists it again (archived, then restored from the 보관·초안
  // 문제 dialog).
  const [removed, setRemoved] = useState<ReadonlyMap<string, readonly OverviewItem[]>>(
    () => new Map(),
  );
  const urlOpenId = openQuestionId(searchParams);
  const listed = urlOpenId ? (placed.find((p) => p.item.question_id === urlOpenId) ?? null) : null;
  const removedOn = urlOpenId ? removed.get(urlOpenId) : undefined;
  const blocked = removedOn !== undefined && (!listed || removedOn === serverItems);
  const openId = urlOpenId && !blocked ? urlOpenId : null;
  const found = openId ? listed : null;
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
    // The panel toggles show the same study state as the dot (UX9-RETRY-OPT): a change in flight
    // at once, a settled one until the server overview moves on. Outside the list the server
    // overview can never catch up, so a settled change always applies there.
    const id = openPlaced.item.question_id;
    const override = overrides.get(id);
    const serverItem = found ? serverItems.find((i) => i.question_id === id) : undefined;
    const base = serverItem ?? openPlaced.item;
    const live =
      override && (override.settledOn === null || !serverItem || override.settledOn === serverItems)
        ? override.patch
        : undefined;
    const item = { ...base, ...live };
    return {
      id: item.question_id,
      title: placedTitle(openPlaced),
      chapterTitle: openPlaced.chapterTitle,
      questionType: item.question_type,
      preview: item.preview,
      isFavorite: item.is_favorite,
      needsRetry: item.needs_retry,
      lastGradedResult: item.last_graded_result,
      isPendingGrading: item.is_pending_grading,
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
    if (onQuestionChange) {
      onQuestionChange(questionId);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (questionId) params.set(QUESTION_PARAM, questionId);
    else params.delete(QUESTION_PARAM);
    const query = params.toString();
    // A history entry per open/close/previous/next: back/forward reopen or close the panel.
    // Next.js syncs `useSearchParams` with pushState.
    window.history.pushState(null, '', `${pathname}${query ? `?${query}` : ''}`);
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

  // UX9-RETRY-OPT: the toggles and the dot show a press at once; my-state requests of a question
  // run one at a time (presses in between are coalesced), and a failure rolls back only the
  // fields it carried. A question being saved is remembered by id, so its save settles (and a
  // failure rolls back) even once it is no longer open or listed (a deep link outside the
  // filters, then another question).
  const savingItems = useRef(new Map<string, OverviewItem>());
  const flagSync = useFlagSync<MyState>(
    (questionId, patch) => {
      const epoch = observedPracticeEpoch(workspaceId, questionId);
      return epoch === undefined
        ? Promise.resolve({
            ok: false,
            kind: 'unavailable',
            message: QUESTION_FAILURE_MESSAGES.unavailable,
          })
        : setMyStateAction(workspaceId, questionId, patch, epoch);
    },
    (questionId, event) => {
      const item = currentItem(questionId) ?? savingItems.current.get(questionId);
      if (event.type === 'failed') {
        toast({ tone: 'error', title: event.message });
        // The rollback changes only the fields whose shown value it restores.
        touch(
          questionId,
          ...(['is_favorite', 'needs_retry'] as const).filter(
            (field) => !item || item[field] !== event.flags[field],
          ),
        );
      }
      // A stale screen offered `다시 풀기`: read the question's state again (hides the toggle).
      if (event.type === 'failed' && event.message === QUESTION_FAILURE_MESSAGES.retryNotAllowed) {
        void rereadState(questionId);
      }
      if (!item) return;
      const saved =
        event.type === 'saved' ? event.result : event.type === 'failed' ? event.saved : null;
      if (saved) markStale();
      const pending = event.type === 'change' || (event.type === 'failed' && event.pending);
      if (pending || !saved) {
        const patch: StudyPatch = {
          ...event.flags,
          last_graded_result: item.last_graded_result,
          is_pending_grading: item.is_pending_grading,
          status: optimisticStatus(item, event.flags),
        };
        putOverride(questionId, nextSeq(questionId), {
          patch,
          settledOn: pending ? null : latestItems.current,
        });
        if (pending) savingItems.current.set(questionId, { ...item, ...patch });
        else savingItems.current.delete(questionId);
        return;
      }
      savingItems.current.delete(questionId);
      // A submission settled while a request was in flight wins over the response's grading.
      const grading = gradings.current.get(questionId) ?? {
        last_graded_result: saved.last_graded_result,
        is_pending_grading: item.is_pending_grading,
      };
      putOverride(questionId, nextSeq(questionId), {
        patch: flagsPatch(saved, grading),
        settledOn: latestItems.current,
      });
    },
    workspaceId,
  );

  /**
   * RETRY-CORRECT: the server refused `다시 풀기`; show the question's real state. Per field
   * (favorite, retry flag, grading) the server's value is taken only if this screen did not
   * change that field after the lookup started; a local incorrect grading also means no retry.
   */
  async function rereadState(questionId: string) {
    // Let the failure handler that called this finish its own rollback first, then stamp.
    await Promise.resolve();
    const stamp = fieldClock.current;
    const resetVersion = practiceResetVersion(workspaceId, questionId);
    const found = await lookupOverviewQuestionAction(workspaceId, questionId);
    if (practiceResetVersion(workspaceId, questionId) !== resetVersion || !found.ok || !found.data)
      return;
    const { item } = found.data;
    markStale();
    const touched = fieldTouched.current.get(questionId);
    const changed = (field: TouchField) => (touched?.[field] ?? 0) > stamp;
    const local = overridesRef.current.get(questionId);
    const grading: Grading = changed('grading')
      ? (gradings.current.get(questionId) ?? {
          last_graded_result: local?.patch.last_graded_result ?? item.last_graded_result,
          is_pending_grading: local?.patch.is_pending_grading ?? item.is_pending_grading,
        })
      : {
          last_graded_result: item.last_graded_result,
          is_pending_grading: item.is_pending_grading,
        };
    const needsRetry =
      changed('grading') && grading.last_graded_result === 'incorrect'
        ? false
        : changed('needs_retry')
          ? (local?.patch.needs_retry ?? item.needs_retry)
          : item.needs_retry;
    const patch = flagsPatch(
      {
        // A submission made meanwhile means the question was opened, whatever the lookup saw.
        status: item.status === 'unseen' && changed('grading') ? 'viewed' : item.status,
        is_favorite: changed('is_favorite')
          ? (local?.patch.is_favorite ?? item.is_favorite)
          : item.is_favorite,
        needs_retry: needsRetry,
        last_graded_result: grading.last_graded_result,
      },
      grading,
    );
    if (changed('grading') || changed('is_favorite') || changed('needs_retry')) {
      // Newer local changes own the sequence (an in-flight save still settles it).
      putOverride(questionId, mutationSeq.current.get(questionId) ?? 0, {
        patch,
        // null = a save is still in flight: keep it so a refresh does not drop the override
        settledOn: local ? local.settledOn : latestItems.current,
      });
    } else {
      putOverride(questionId, nextSeq(questionId), { patch, settledOn: latestItems.current });
    }
  }

  function changeFlags(
    questionId: string,
    flags: { is_favorite?: boolean; needs_retry?: boolean },
  ) {
    const item = currentItem(questionId) ?? savingItems.current.get(questionId);
    if (!item) return;
    onStudyStateChanged?.();
    touch(
      questionId,
      ...(['is_favorite', 'needs_retry'] as const).filter((field) => flags[field] !== undefined),
    );
    flagSync.toggle(
      questionId,
      { is_favorite: item.is_favorite, needs_retry: item.needs_retry },
      flags,
    );
  }

  const markViewed = useCallback(
    (questionId: string) => {
      const item = latestItems.current.find((i) => i.question_id === questionId);
      if (!item || item.status !== 'unseen') {
        if (openPlaced?.item.question_id === questionId && openPlaced.item.status === 'unseen') {
          markStale();
        }
        return;
      }
      markStale();
      // A flag change in flight already carries the server's status; don't race it.
      if (overridesRef.current.has(questionId)) return;
      const seq = (mutationSeq.current.get(questionId) ?? 0) + 1;
      mutationSeq.current.set(questionId, seq);
      putOverride(questionId, seq, {
        patch: { status: 'viewed' },
        settledOn: latestItems.current,
      });
    },
    [markStale, openPlaced, putOverride],
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
    markStale();
    touch(questionId, 'grading', ...(result === 'incorrect' ? (['needs_retry'] as const) : []));
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

  // The range run panel (QVIEW-01): its positions record views and attempts like the practice
  // panel, so the Heatmap is read again once it closes.
  const runState = onRunNavigate && onRunClose ? parseRunState(searchParams) : null;
  const runOpen = runState !== null;
  // A mock exam's 풀기 (MOCK-01) runs in the same panel with its own source (mock-run.ts).
  const homeRun = useHomeRun(workspaceId, runState);
  const bankRun = homeRun.source === 'bank';
  const wasRunOpen = useRef(runOpen);
  useEffect(() => {
    if (wasRunOpen.current && !runOpen && staleOverview.current) router.refresh();
    wasRunOpen.current = runOpen;
  }, [runOpen, router]);

  // --- 문제 등록 / 편집 / 삭제 (UX7-BANK) ----------------------------------------------------------
  const [editing, setEditing] = useState<Extract<EditorTarget, { mode: 'edit' }> | null>(null);
  const [editorSession, setEditorSession] = useState(0);
  const [createSeen, setCreateSeen] = useState(false);
  const creating = canAuthor && createOpen;
  if (creating !== createSeen) {
    setCreateSeen(creating);
    if (creating) setEditorSession((n) => n + 1);
  }
  const editorTarget: EditorTarget | null = editing ?? (creating ? { mode: 'create' } : null);
  const [invalidated, setInvalidated] = useState<Invalidation | null>(null);
  const invalidate = (questionId: string) =>
    setInvalidated((prev) => ({ questionId, seq: (prev?.seq ?? 0) + 1 }));
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [detail, setDetail] = useState<DetailTarget | null>(null);

  async function startEdit(questionId: string) {
    if (loadingEdit) return;
    setLoadingEdit(true);
    try {
      // The full question (answers included) is read only now, for the editor: the practice
      // session itself never carries it (QPLAY-01-AC01).
      const result = await getQuestionAction(workspaceId, questionId);
      if (!result.ok) {
        toast({ tone: 'error', title: result.message });
        return;
      }
      setEditorSession((n) => n + 1);
      setEditing({ mode: 'edit', question: result.data });
    } catch {
      toast({ tone: 'error', title: QUESTION_FAILURE_MESSAGES.unavailable });
    } finally {
      setLoadingEdit(false);
    }
  }

  function closeEditor() {
    if (editing) setEditing(null);
    else onCreateOpenChange?.(false);
  }

  async function runDelete() {
    const questionId = confirmDelete;
    if (!questionId || deleting) return;
    setDeleting(true);
    try {
      const result = await deleteQuestionAction(workspaceId, questionId);
      if (!result.ok) {
        toast({ tone: 'error', title: result.message });
        return;
      }
      setConfirmDelete(null);
      removeOpen(questionId);
      toast({ tone: 'success', title: '문제를 삭제했습니다.' });
    } catch {
      toast({ tone: 'error', title: QUESTION_FAILURE_MESSAGES.unavailable });
    } finally {
      setDeleting(false);
    }
  }

  /** The question left the heatmap (deleted, archived): forget it and close its panel. */
  function removeOpen(questionId: string) {
    onQuestionsChanged?.();
    setRemoved((prev) => new Map(prev).set(questionId, latestItems.current));
    invalidate(questionId);
    // After the action's refreshed overview: closing first could let that refresh restore
    // `?question=` (practice-actions.ts).
    if (openQuestionId(new URLSearchParams(window.location.search)) === questionId) {
      setQuestionParam(null);
    }
  }

  async function runArchive() {
    const questionId = confirmArchive;
    if (!questionId || archiving) return;
    setArchiving(true);
    try {
      // The status change is based on the question's current revision, read now.
      const current = await getQuestionAction(workspaceId, questionId);
      const result = current.ok
        ? await setQuestionStatusAction(
            workspaceId,
            questionId,
            current.data.revision.id,
            'ARCHIVED',
          )
        : current;
      if (!result.ok) {
        toast({ tone: 'error', title: result.message });
        return;
      }
      setConfirmArchive(null);
      removeOpen(questionId);
      toast({ tone: 'success', title: '문제를 보관했습니다.' });
    } catch {
      toast({ tone: 'error', title: QUESTION_FAILURE_MESSAGES.unavailable });
    } finally {
      setArchiving(false);
    }
  }

  const filtered = isOverviewFiltered(filters);
  const busy = navigating || reloading;

  return (
    <section ref={screenRef} className={styles.screen} aria-labelledby={titleId}>
      <h2 id={titleId} className="qz-visually-hidden">
        문제
      </h2>
      <p className={styles.inFilter} role="status">
        {busy ? <QuestionLineSkeleton /> : ''}
      </p>

      {failure ? (
        <div role="alert" className={styles.loadError}>
          <p>문제 Heatmap을 불러오지 못했습니다. {QUESTION_FAILURE_MESSAGES[failure]}</p>
          <Button onClick={() => (onRetry ? onRetry() : startReload(() => router.refresh()))}>
            다시 시도
          </Button>
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
                <Button
                  variant="primary"
                  aria-haspopup="dialog"
                  onClick={() => onCreateOpenChange?.(true)}
                >
                  문제 등록
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
            renderChapterActions={
              chapterActions &&
              ((chapter) =>
                chapterActions(chapter, { hasNote: !workspaceChapters.has(chapter.id) }))
            }
            onOpen={(questionId) => {
              if (practiceReturnFocusRef) practiceReturnFocusRef.current = null;
              setQuestionParam(questionId);
            }}
          />
        </div>
      )}

      <QuestionViewer
        mode="practice"
        workspaceId={workspaceId}
        question={holdPanels ? null : panelQuestion}
        readOnly={readOnly === 'archived'}
        screenId={panelScreenId}
        neighbors={panelNeighbors}
        onNavigate={(questionId) => setQuestionParam(questionId)}
        onClose={() => setQuestionParam(null)}
        onGraded={markGraded}
        onReset={(questionId) => {
          invalidate(questionId);
          markStale();
          savingItems.current.delete(questionId);
          gradings.current.delete(questionId);
          putOverride(questionId, nextSeq(questionId), {
            patch: {
              status: 'unseen',
              is_favorite: false,
              needs_retry: false,
              last_graded_result: null,
              is_pending_grading: false,
            },
            settledOn: latestItems.current,
          });
        }}
        onFlagsChange={changeFlags}
        onViewed={markViewed}
        invalidated={invalidated}
        headerExtra={({ onShowSource }) =>
          panelQuestion ? (
            <QuestionManageMenu
              busy={loadingEdit || deleting || archiving}
              onShowSource={onShowSource}
              onShowDetail={(focus, trigger) =>
                setDetail({
                  questionId: panelQuestion.id,
                  focus,
                  returnFocus: trigger,
                  description: `${panelQuestion.title} · ${questionTypeLabels[panelQuestion.questionType]} · ${panelQuestion.chapterTitle}`,
                })
              }
              manage={
                canAuthor
                  ? {
                      onEdit: () => void startEdit(panelQuestion.id),
                      onArchive: () => setConfirmArchive(panelQuestion.id),
                      onDelete: () => setConfirmDelete(panelQuestion.id),
                    }
                  : null
              }
            />
          ) : null
        }
        onCloseAutoFocus={(event) => {
          const requestedFocus = practiceReturnFocusRef?.current ?? null;
          if (practiceReturnFocusRef) practiceReturnFocusRef.current = null;
          if (requestedFocus?.isConnected) {
            requestedFocus.focus();
            event.preventDefault();
            return;
          }
          const root = screenRef.current;
          if (!root) return;
          // An empty heatmap falls back to the home's 필터 button, on the sticky line.
          const toggle = document.querySelector<HTMLElement>('[data-home-filter]');
          if (focusAfterPanel(root, lastOpened.current, openOrder.current, toggle)) {
            event.preventDefault();
          }
        }}
      />

      {onRunNavigate && onRunClose ? (
        <QuestionViewer
          mode="sequence"
          workspaceId={workspaceId}
          state={holdPanels ? null : runState}
          archived={readOnly === 'archived'}
          onNavigate={onRunNavigate}
          onClose={onRunClose}
          source={homeRun.source}
          client={homeRun.client}
          {...(homeRun.pickerTitle ? { pickerTitle: homeRun.pickerTitle } : {})}
          onViewed={(questionId) => {
            if (!bankRun) return;
            markStale();
            markViewed(questionId);
          }}
          onGraded={(questionId, result) => {
            if (!bankRun) return;
            markStale();
            markGraded(questionId, result);
          }}
          onFlagsSaved={() => {
            markStale();
          }}
          onFlagsFailed={(message) => toast({ tone: 'error', title: message })}
          invalidated={invalidated}
          headerExtra={(q, { onShowSource }) => (
            <QuestionManageMenu
              busy={loadingEdit || deleting || archiving}
              onShowSource={onShowSource}
              onShowDetail={(focus, trigger) =>
                setDetail({
                  questionId: q.questionId,
                  focus,
                  returnFocus: trigger,
                  description: `${q.title} · ${questionTypeLabels[q.questionType]} · ${q.chapterTitle}`,
                })
              }
              manage={
                canAuthor
                  ? {
                      onEdit: () => void startEdit(q.questionId),
                      onArchive: () => setConfirmArchive(q.questionId),
                      onDelete: () => setConfirmDelete(q.questionId),
                    }
                  : null
              }
            />
          )}
        />
      ) : null}

      <QuestionDetailDialog
        workspaceId={workspaceId}
        target={detail}
        onClose={() => setDetail(null)}
        documents={documents}
      />

      {canAuthor ? (
        <>
          <HomeQuestionEditor
            // 문제 등록 is a home dialog: with the home's other dialogs, so one stacked over it stays
            // exposed (HOMEDLG-01-AC02). 문제 편집 opens from the practice panel (portalled to
            // <body>): the home's container is hidden behind that panel, so it portals to <body>.
            container={editorTarget?.mode === 'create' ? dialogContainer : undefined}
            workspaceId={workspaceId}
            target={editorTarget}
            session={editorSession}
            onClose={closeEditor}
            onSaved={(question, mode) => {
              // The saved question's sessions are pinned to its old revision: forget them, and
              // practise the new one if the panel still shows it (not whatever is open now).
              if (mode === 'edit') invalidate(question.id);
              onQuestionsChanged?.();
            }}
          />
          <ConfirmDialog
            open={confirmDelete !== null}
            onOpenChange={(open) => {
              if (!open && !deleting) setConfirmDelete(null);
            }}
            title="문제를 삭제할까요?"
            description="Heatmap에서 사라집니다. 지난 풀이 기록은 이력으로 남습니다."
            confirmLabel="삭제"
            onConfirm={() => void runDelete()}
            loading={deleting}
          />
          <ConfirmDialog
            open={confirmArchive !== null}
            onOpenChange={(open) => {
              if (!open && !archiving) setConfirmArchive(null);
            }}
            title="문제를 보관할까요?"
            description="Heatmap에서 빠집니다. 문제 › 보관·초안 문제에서 보관 해제할 수 있고, 지난 풀이 기록은 그대로 남습니다."
            confirmLabel="보관"
            onConfirm={() => void runArchive()}
            loading={archiving}
          />
        </>
      ) : null}
    </section>
  );
}

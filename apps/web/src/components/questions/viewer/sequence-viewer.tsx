'use client';

import { GroupedResults } from './grouped-results';

// QuestionViewer `sequence` mode (QVIEW-01 call sites 7–8, docs/screens/question-viewer.md,
// questions.md §12): a range run in a modal Floating Side Panel, in three steps of one dialog.
//   range    QuestionRangePicker (`전체 선택`, chapters, filters) + `무작위 순서` (off, never
//            remembered) + `시작` (disabled with the reason while nothing is selected). The server
//            resolves the range into a fixed, ordered run (QVIEW-01-C01/C02).
//   solve    one position at a time: the title names the question ("12번"; mock "문제 k") and
//            takes focus on every move, a progress bar with "n문제 중 k번째" (also announced), the
//            QuestionBody, `제출` → result + answers + explanation, `다음` / `결과 보기`, `이전`,
//            `건너뛰기`. A submitted position shows its answer and result read-only (one submission
//            per position; `처음부터 다시` starts a new run). Opening a position opens its practice
//            session, which records the view; nothing before a submission carries an answer (C03).
//   results  "맞음 x · 틀림 y · 채점 대기 z · 건너뜀 w", the per-position results (a row reopens that
//            position read-only), `처음부터 다시` (a new run of the same questions and order
//            setting) and `닫기`.
// The URL is the screen's (`?practice=…`, practice-runs.ts): `시작`, `결과 보기` and `처음부터 다시`
// replace the history entry, moving between positions pushes one (QOV-01-AC14). Closing (Escape,
// 닫기) asks nothing: every submission is saved already. `bank` runs carry the study toggles and the
// screen's 문제 관리 / 문제 정보 menu (`headerExtra`); `mock` runs carry neither, but
// `질문하기` (ASK-01, the question attached with its session).
import { Button, Checkbox, FloatingSidePanel, ProgressBar, questionTypeLabels } from '@quiz/ui';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useOptionalPracticeReturn } from '@/components/practice-return/practice-return-provider';
import { AskQuestionButton } from '@/components/ask/ask-launcher';
import { AiExplanation } from '@/components/questions/ai-explanation/ai-explanation';
import { RelatedSources } from '@/components/questions/related-sources/related-sources';
import type { AskAttachmentInput } from '@/lib/ask/client';
import {
  lookupOverviewQuestionAction,
  selfGradePracticeAction,
  setMyStateAction,
  submitPracticeAction,
  type MyState,
  type PracticeSession,
  type PracticeSubmission,
  type SelfGradeResult,
  type StudyActionResult,
  type SubmitResult,
} from '@/lib/questions/practice-actions';
import { createPracticeRunApi } from '@/lib/questions/practice-run-client';
import { RUN_FAILURE_MESSAGES, type RunActionResult } from '@/lib/questions/practice-run-problems';
import {
  PRACTICE_RUN_MAX,
  positionLabel,
  progressText,
  restartRange,
  summaryText,
  type PracticeRun,
  type RunItem,
  type RunRange,
  type RunResultItem,
  type RunResults,
  type RunSource,
  type RunUrlState,
} from '@/lib/questions/practice-runs';
import type { QuestionOverview } from '@/lib/questions/overview-data';
import {
  observedPracticeEpoch,
  practiceResetVersion,
  rememberPracticeEpoch,
  subscribePracticeResets,
} from '@/lib/questions/practice-reset-events';
import { QUESTION_FAILURE_MESSAGES } from '@/lib/questions/problems';
import {
  canSubmit,
  EMPTY_ANSWER,
  submitBody,
  type AttemptResult,
  type GradeResult,
  type PracticeAnswer,
} from './practice-model';
import { NavButton } from './nav-button';
import { SelfGradeButtons, StudyToggles, type Invalidation } from './practice-viewer';
import {
  QuestionBody,
  QuestionStem,
  type AnswerQuestion,
  type RevealedAnswers,
} from './question-body';
import { SeparateRetry } from './separate-retry';
import { QuestionRangePicker } from './question-range-picker';
import {
  QuestionFigures,
  QuestionSourceButton,
  QuestionSourceDialog,
  useQuestionSource,
  type QuestionSourceControls,
} from './question-source-preview';
import {
  EMPTY_RANGE_FILTERS,
  allIds,
  keepVisible,
  rangeGroups,
  rangeRequest,
  type RangeFilterState,
  type RangeGroup,
} from './range-model';
import styles from './question-viewer.module.css';
import { useFlagSync } from './use-flag-sync';

/** The question a run position shows, for the screen's header menu. */
export interface RunQuestionInfo {
  readonly questionId: string;
  readonly title: string;
  readonly questionType: keyof typeof questionTypeLabels;
  readonly chapterTitle: string;
}

export interface StudyFlags {
  readonly is_favorite: boolean;
  readonly needs_retry: boolean;
}

/** `다시 풀기` is offered only while the last graded result is correct (RETRY-CORRECT). */
export interface StudyGrading {
  readonly last_graded_result?: 'correct' | 'incorrect' | null;
  /** The latest submission waits for self-grading: `다시 풀기` stays hidden until it is graded. */
  readonly is_pending_grading?: boolean;
}

/**
 * Everything a run reads and writes. `bank` runs use the server actions (bankRunClient); a mock
 * exam run (MOCK-P/MOCK-W) brings its own sessions and has no study flags.
 */
export interface RunClient {
  listRange(
    filters: RangeFilterState,
  ): Promise<RunActionResult<Pick<QuestionOverview, 'chapters' | 'items'>>>;
  create(range: RunRange, randomOrder: boolean, key: string): Promise<RunActionResult<PracticeRun>>;
  getRun(runId: string): Promise<RunActionResult<PracticeRun>>;
  getItem(runId: string, position: number): Promise<RunActionResult<RunItem>>;
  openSession(
    questionId: string,
    runId: string,
    position: number,
    key: string,
    expectedResetEpoch?: number | null,
  ): Promise<RunActionResult<PracticeSession>>;
  submit(sessionId: string, answer: PracticeSubmission): Promise<StudyActionResult<SubmitResult>>;
  selfGrade(sessionId: string, grade: GradeResult): Promise<StudyActionResult<SelfGradeResult>>;
  finish(runId: string): Promise<RunActionResult<PracticeRun>>;
  results(runId: string, offset: number): Promise<RunActionResult<RunResults>>;
  /** The caller's favorite / retry flags and last graded result of a bank question (null: unknown). */
  flags?(questionId: string): Promise<(StudyFlags & StudyGrading) | null>;
  setFlags?(questionId: string, flags: Partial<StudyFlags>): Promise<StudyActionResult<MyState>>;
}

/** The bank run client: this workspace's BFF routes and the practice panel's actions. */
export function bankRunClient(workspaceId: string): RunClient {
  const api = createPracticeRunApi(workspaceId);
  return {
    listRange: (filters) => api.rangeQuestions(filters),
    create: (range, randomOrder, key) => api.create(range, randomOrder, key),
    getRun: (runId) => api.getRun(runId),
    getItem: (runId, position) => api.getItem(runId, position),
    openSession: (questionId, runId, position, key, epoch) =>
      api.openSession(questionId, runId, position, key, epoch),
    submit: (sessionId, answer) => submitPracticeAction(workspaceId, sessionId, answer),
    selfGrade: (sessionId, grade) => selfGradePracticeAction(workspaceId, sessionId, grade),
    finish: (runId) => api.finish(runId),
    results: (runId, offset) => api.results(runId, offset),
    flags: async (questionId) => {
      const found = await lookupOverviewQuestionAction(workspaceId, questionId);
      if (!found.ok || !found.data) return null;
      return {
        is_favorite: found.data.item.is_favorite,
        needs_retry: found.data.item.needs_retry,
        last_graded_result: found.data.item.last_graded_result,
        is_pending_grading: found.data.item.is_pending_grading,
      };
    },
    setFlags: (questionId, flags) => {
      const epoch = observedPracticeEpoch(workspaceId, questionId);
      return epoch === undefined
        ? Promise.resolve({
            ok: false,
            kind: 'unavailable',
            message: QUESTION_FAILURE_MESSAGES.unavailable,
          })
        : setMyStateAction(workspaceId, questionId, flags, epoch);
    },
  };
}

export interface SequenceViewerProps {
  readonly workspaceId: string;
  /** The run panel's URL state; null = closed. */
  readonly state: RunUrlState | null;
  /** Archived workspace: everything can be read and started, nothing submitted (C05). */
  readonly archived: boolean;
  /** `bank` (registered questions) or `mock` (a mock exam's own questions). */
  readonly source?: RunSource;
  /** The range step's title (mock: "<모의고사 이름> 풀기"). */
  readonly pickerTitle?: string;
  readonly onNavigate: (state: RunUrlState, how: 'push' | 'replace') => void;
  readonly onClose: () => void;
  /** A position's session was opened: the server recorded the view (bank). */
  readonly onViewed?: (questionId: string) => void;
  /** A position was submitted (`pending`) or graded (bank). */
  readonly onGraded?: (questionId: string, result: AttemptResult) => void;
  /** A position's favorite / retry flags were saved (bank). */
  readonly onFlagsSaved?: (questionId: string, flags: StudyFlags) => void;
  /** Saving a position's favorite / retry flags failed (bank): the toggles rolled back. */
  readonly onFlagsFailed?: (message: string) => void;
  /** Header controls after the study toggles (bank: the screen's 문제 관리 / 문제 정보 menu). */
  readonly headerExtra?: (question: RunQuestionInfo, source: QuestionSourceControls) => ReactNode;
  /** A question edited, archived or deleted meanwhile: its position is read again. */
  readonly invalidated?: Invalidation | null;
  readonly client?: RunClient;
  readonly screenId?: string;
  readonly onCloseAutoFocus?: ComponentProps<typeof FloatingSidePanel>['onCloseAutoFocus'];
}

type Load<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'error'; readonly kind: string; readonly message: string };

interface Keyed<T> {
  readonly key: string;
  readonly load: Load<T>;
}

function newKey(): string {
  return crypto.randomUUID();
}

function fromResult<T>(result: RunActionResult<T>): Load<T> {
  return result.ok
    ? { status: 'ready', data: result.data }
    : { status: 'error', kind: result.kind, message: result.message };
}

const LOADING: Load<never> = { status: 'loading' };
const LOAD_FAILED: Load<never> = {
  status: 'error',
  kind: 'unavailable',
  message: RUN_FAILURE_MESSAGES.unavailable,
};

/** Runs `read` for `key` (null: nothing to read) and keeps its result under that key. */
function useKeyedLoad<T>(
  key: string | null,
  read: () => Promise<RunActionResult<T>>,
): Load<T> | null {
  const [state, setState] = useState<Keyed<T> | null>(null);
  const readRef = useRef(read);
  useLayoutEffect(() => {
    readRef.current = read;
  });
  useEffect(() => {
    if (key === null) return;
    let live = true;
    readRef.current().then(
      (result) => {
        if (live) setState({ key, load: fromResult(result) });
      },
      () => {
        if (live) setState({ key, load: LOAD_FAILED });
      },
    );
    return () => {
      live = false;
    };
  }, [key]);
  if (key === null) return null;
  // Stable objects: callers compare loads by identity to react to a new result once.
  return state?.key === key ? state.load : LOADING;
}

/**
 * The Idempotency-Key of one creation request (QVIEW-01-C01): kept while the same payload is
 * retried — a failure may be a lost response of a run the server created, which a retry with the
 * same key recovers — and new for another payload or after a confirmed success. A success retires
 * only its own key (a newer request's stays), also when its answer is no longer shown.
 */
function useRequestKey() {
  const ref = useRef<{ readonly payload: string; readonly key: string } | null>(null);
  return {
    keyFor(payload: string): string {
      if (ref.current?.payload !== payload) ref.current = { payload, key: newKey() };
      return ref.current.key;
    },
    succeeded(key: string): void {
      if (ref.current?.key === key) ref.current = null;
    },
  };
}

export function SequenceViewer({
  workspaceId,
  state,
  archived,
  source = 'bank',
  pickerTitle = '문제 풀기',
  onNavigate,
  onClose,
  onViewed,
  onGraded,
  onFlagsSaved,
  onFlagsFailed,
  headerExtra,
  invalidated = null,
  client: givenClient,
  screenId,
  onCloseAutoFocus,
}: SequenceViewerProps) {
  const [defaultClient] = useState(() => bankRunClient(workspaceId));
  const client = givenClient ?? defaultClient;
  // The last state keeps rendering while the panel animates closed.
  const [shown, setShown] = useState(state);
  if (state && state !== shown) setShown(state);
  const view = state ?? shown;
  const open = state !== null;
  const [resetVersion, setResetVersion] = useState(0);
  useLayoutEffect(() => {
    if (!open || source !== 'bank') return;
    return subscribePracticeResets(workspaceId, () => setResetVersion((n) => n + 1));
  }, [open, source, workspaceId]);

  const titleRef = useRef<HTMLHeadingElement>(null);
  const bankReturnFocus = useRef<HTMLElement | null>(null);
  const stepKey =
    view === null
      ? 'closed'
      : view.step === 'solve'
        ? `solve:${view.runId}:${view.position}`
        : view.step === 'results'
          ? `results:${view.runId}`
          : view.step;
  useEffect(() => {
    // Every new step or position names itself: focus its title (QVIEW-01 접근성).
    if (open) titleRef.current?.focus();
  }, [open, stepKey]);

  useEffect(() => {
    if (!open || view?.step !== 'solve') return;
    const focusTitle = (event: Event) => {
      const opener = (event as CustomEvent<unknown>).detail;
      bankReturnFocus.current = opener instanceof HTMLElement ? opener : null;
      titleRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener('quiz:bank-run-transition', focusTitle);
    return () => window.removeEventListener('quiz:bank-run-transition', focusTitle);
  }, [open, view?.step]);

  // The results step finishes the run: a position read afterwards reads the run again.
  const [runVersion, setRunVersion] = useState(0);
  const [inResults, setInResults] = useState(false);
  const resultsNow = open && view?.step === 'results';
  if (resultsNow !== inResults) {
    setInResults(resultsNow);
    if (resultsNow) setRunVersion((n) => n + 1);
  }

  const picker = usePickerStep({
    active: open && view?.step === 'picker',
    resetVersion,
    client,
    source,
    onStarted: (runId) => onNavigate({ step: 'solve', runId, position: 1 }, 'replace'),
  });
  const solve = useSolveStep({
    workspaceId,
    view: view?.step === 'solve' ? view : null,
    runVersion,
    resetVersion,
    open,
    client,
    source,
    archived,
    invalidated,
    onViewed,
    onGraded,
    onFlagsSaved,
    onFlagsFailed,
    onNavigate,
  });
  const results = useResultsStep({
    runId: open && view?.step === 'results' ? view.runId : null,
    resetVersion,
    client,
    source,
    invalidated,
    onNavigate,
    onClose,
  });

  let title: string = pickerTitle;
  let description: string | undefined;
  let body: ReactNode = null;
  let footer: ReactNode = undefined;
  let header: ReactNode = undefined;
  if (view?.step === 'picker') {
    body = picker.body;
    footer = picker.footer;
  } else if (view?.step === 'solve') {
    title = solve.title ?? pickerTitle;
    description = solve.description;
    body = solve.body;
    footer = solve.footer;
    const info = solve.question;
    if (solve.attachment) {
      // ASK-01 "문제 쪽 진입점": a mock exam question's `질문하기` (hint before its submission,
      // full after — the server decides from the session). The bank's run has none.
      header = <AskQuestionButton attachment={solve.attachment} />;
    } else if (info && source === 'bank') {
      header = (
        <>
          {!archived && solve.flags ? (
            <StudyToggles
              favorite={solve.flags.is_favorite}
              retry={solve.flags.needs_retry}
              retryAvailable={solve.lastGraded === 'correct' && !solve.pendingGrading}
              onChange={solve.changeFlags}
            />
          ) : null}
          {headerExtra?.(info, { onShowSource: solve.onShowSource })}
        </>
      );
    }
  } else if (view?.step === 'results') {
    title = '풀이 결과';
    body = results.body;
    footer = results.footer;
  } else if (view?.step === 'missing') {
    body = <NotFound />;
  }

  return (
    <FloatingSidePanel
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      titleRef={titleRef}
      description={description}
      closeLabel="패널 닫기"
      onOpenAutoFocus={(event) => {
        if (titleRef.current) {
          event.preventDefault();
          titleRef.current.focus({ preventScroll: true });
        }
      }}
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event);
        if (event.defaultPrevented) return;
        const target = bankReturnFocus.current;
        bankReturnFocus.current = null;
        const active = document.activeElement;
        const dialog = titleRef.current?.closest('[role=dialog]');
        const focusLost = !active || active === document.body || !!dialog?.contains(active);
        if (target?.isConnected && focusLost) {
          event.preventDefault();
          target.focus({ preventScroll: true });
        }
      }}
      headerActions={header}
      footer={footer ? <div className={styles.footer}>{footer}</div> : undefined}
      scrollKey={stepKey}
    >
      {view ? (
        <div className={styles.body} data-screen-id={screenId}>
          {body}
        </div>
      ) : null}
    </FloatingSidePanel>
  );
}

function NotFound() {
  return (
    <p className={styles.notice} role="alert">
      {RUN_FAILURE_MESSAGES.notFound}
    </p>
  );
}

// --- range step -------------------------------------------------------------------------------

function usePickerStep({
  active,
  resetVersion,
  client,
  source,
  onStarted,
}: {
  readonly active: boolean;
  readonly resetVersion: number;
  readonly client: RunClient;
  readonly source: RunSource;
  readonly onStarted: (runId: string) => void;
}): { body: ReactNode; footer: ReactNode } {
  // Each opening of the range step starts over: no filter, nothing selected, 무작위 순서 off.
  const [opening, setOpening] = useState(0);
  const [wasActive, setWasActive] = useState(false);
  const [filters, setFilters] = useState<RangeFilterState>(EMPTY_RANGE_FILTERS);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [random, setRandom] = useState(false);
  const [retry, setRetry] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) {
      setOpening((n) => n + 1);
      setFilters(EMPTY_RANGE_FILTERS);
      setSelected(new Set());
      setRandom(false);
      setStartError(null);
      setStarting(false);
    }
  }

  const filtersKey = JSON.stringify(filters);
  const load = useKeyedLoad(
    active ? `${opening}:${filtersKey}:${retry}:${resetVersion}` : null,
    () => client.listRange(filters),
  );
  // The last groups stay shown while the next filters load.
  const [groups, setGroups] = useState<{
    opening: number;
    resetVersion: number;
    groups: RangeGroup[];
  } | null>(null);
  const [seenLoad, setSeenLoad] = useState(load);
  if (load !== seenLoad) {
    setSeenLoad(load);
    if (load?.status === 'ready') {
      const next = rangeGroups(load.data, source);
      const first = groups?.opening !== opening;
      setGroups({ opening, resetVersion, groups: next });
      // A filter hides questions: they leave the selection. A mock exam starts all selected.
      setSelected((prev) =>
        first && source === 'mock' ? new Set(allIds(next)) : keepVisible(prev, next),
      );
    }
  }
  const shownGroups =
    groups?.opening === opening && groups.resetVersion === resetVersion ? groups.groups : null;
  const busy = load?.status === 'loading';

  const request = shownGroups ? rangeRequest(shownGroups, selected, filters, source) : null;
  const count = shownGroups ? keepVisible(selected, shownGroups).size : 0;
  const tooLarge = count > PRACTICE_RUN_MAX;
  const reason =
    count === 0 ? '풀 문제를 고르세요' : tooLarge ? RUN_FAILURE_MESSAGES.tooLarge : null;
  const startKey = useRequestKey();
  const reasonId = useId();
  // The opening a 시작 belongs to: a run created after the panel closed (or for an earlier
  // opening) is not started — the dismissed panel stays closed.
  const liveOpening = useRef<number | null>(null);
  useLayoutEffect(() => {
    liveOpening.current = active ? opening : null;
  });

  async function start() {
    if (!request || tooLarge || starting || busy) return;
    const token = opening;
    // A new opening is a new 문제 풀기 (a new run, QVIEW-01 "도중에 닫기"): its own key.
    const key = startKey.keyFor(JSON.stringify([token, request, random]));
    setStarting(true);
    setStartError(null);
    let result: RunActionResult<PracticeRun>;
    try {
      result = await client.create(request, random, key);
    } catch {
      result = { ok: false, kind: 'unavailable', message: RUN_FAILURE_MESSAGES.unavailable };
    }
    if (result.ok) startKey.succeeded(key);
    if (liveOpening.current !== token) return;
    setStarting(false);
    if (result.ok) {
      onStarted(result.data.id);
    } else {
      setStartError(result.message);
    }
  }

  const error = load?.status === 'error' ? load.message : null;
  const body = (
    <>
      <QuestionRangePicker
        groups={error ? null : shownGroups}
        busy={busy}
        error={error}
        onRetry={() => setRetry((n) => n + 1)}
        selected={selected}
        onSelectedChange={(next) => {
          setSelected(next);
          setStartError(null);
        }}
        {...(source === 'bank'
          ? {
              filters,
              onFiltersChange: (next: RangeFilterState) => {
                setFilters(next);
                setStartError(null);
              },
            }
          : {})}
      />
      <Checkbox
        label="무작위 순서"
        checked={random}
        onCheckedChange={(checked) => setRandom(checked === true)}
      />
      {startError ? (
        <p role="alert" className={styles.error}>
          {startError}
        </p>
      ) : null}
    </>
  );
  const footer = (
    <>
      <Button
        variant="primary"
        loading={starting}
        disabled={!request || tooLarge || busy}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => void start()}
      >
        시작
      </Button>
      {reason ? (
        <p id={reasonId} className={styles.hint}>
          {reason}
        </p>
      ) : null}
    </>
  );
  return { body, footer };
}

// --- solve step -------------------------------------------------------------------------------

interface WorkState {
  readonly workId: string | null;
  readonly answer: PracticeAnswer;
  readonly busy: 'submit' | 'grade' | null;
  readonly outcome: SubmitResult | null;
  readonly selfGrade: GradeResult | null;
  readonly error: string | null;
}

function freshWork(workId: string | null): WorkState {
  return { workId, answer: EMPTY_ANSWER, busy: null, outcome: null, selfGrade: null, error: null };
}

function attemptAnswer(item: RunItem): PracticeAnswer {
  const submitted = item.attempt?.submitted_answer;
  return {
    selected: submitted?.selected_option_ids ?? [],
    text: submitted?.answer_text ?? '',
  };
}

function itemQuestion(item: RunItem): AnswerQuestion {
  return {
    question_type: item.question_type ?? 'MCQ',
    is_multi_answer: item.is_multi_answer ?? false,
    options: item.options,
    displayed_option_ids: item.options.map((o) => o.id),
  };
}

function useSolveStep({
  workspaceId,
  view,
  runVersion,
  resetVersion,
  open,
  client,
  source,
  archived,
  invalidated,
  onViewed,
  onGraded,
  onFlagsSaved,
  onFlagsFailed,
  onNavigate,
}: {
  readonly workspaceId: string;
  readonly view: Extract<RunUrlState, { step: 'solve' }> | null;
  /** Bumped when the run may have changed elsewhere (finished by its results step). */
  readonly runVersion: number;
  readonly resetVersion: number;
  readonly open: boolean;
  readonly client: RunClient;
  readonly source: RunSource;
  readonly archived: boolean;
  readonly invalidated: Invalidation | null;
  readonly onViewed: ((questionId: string) => void) | undefined;
  readonly onGraded: ((questionId: string, result: AttemptResult) => void) | undefined;
  readonly onFlagsSaved: ((questionId: string, flags: StudyFlags) => void) | undefined;
  readonly onFlagsFailed: ((message: string) => void) | undefined;
  readonly onNavigate: (state: RunUrlState, how: 'push' | 'replace') => void;
}) {
  const active = open && view !== null;
  const runId = view?.runId ?? null;
  const position = view?.position ?? 1;
  const [runSeq, setRunSeq] = useState(0);
  const [itemSeq, setItemSeq] = useState(0);
  const [retryTarget, setRetryTarget] = useState<{ key: string; questionId: string } | null>(null);
  const recordReturn = useOptionalPracticeReturn()?.recordActivity;
  if (retryTarget && (!active || retryTarget.key !== `${runId}:${position}`)) setRetryTarget(null);

  // An edited / archived / deleted question on screen is read again.
  const [seenInvalidation, setSeenInvalidation] = useState(invalidated);
  const invalidating = invalidated !== seenInvalidation;

  const runLoad = useKeyedLoad(
    active && runId ? `${runId}:${runVersion}:${runSeq}:${resetVersion}` : null,
    () => client.getRun(runId ?? ''),
  );
  const run = runLoad?.status === 'ready' ? runLoad.data : null;
  const itemKey = active && runId ? `${runId}:${position}:${itemSeq}:${resetVersion}` : null;
  const itemLoad = useKeyedLoad(itemKey, () => client.getItem(runId ?? '', position));
  const item = itemLoad?.status === 'ready' ? itemLoad.data : null;
  // QSRC-01: bank questions and `보기 섞기` mock questions with an imported source.
  const sourcePreview = useQuestionSource(
    item?.question_id
      ? { kind: source === 'mock' ? 'mock' : 'question', id: item.question_id }
      : null,
  );
  const returnable = !!run && !!item?.available && !!item.question_id;
  useEffect(() => {
    if (active && runId && returnable)
      recordReturn?.({ kind: 'run', workspaceId, runId, position });
  }, [active, runId, position, workspaceId, returnable, recordReturn]);
  useLayoutEffect(() => {
    if (source === 'bank' && item?.question_id && item.reset_epoch != null) {
      rememberPracticeEpoch(workspaceId, item.question_id, item.reset_epoch);
    }
  }, [source, item, workspaceId]);
  if (invalidating) {
    setSeenInvalidation(invalidated);
    if (invalidated && item?.question_id?.toLowerCase() === invalidated.questionId.toLowerCase()) {
      setItemSeq((n) => n + 1);
    }
  }

  // The position's practice session (records the view), unless it was submitted, the run is
  // finished or the workspace is archived (the API refuses those: 409 / 403).
  const sessionWanted =
    item !== null &&
    run !== null &&
    item.available &&
    item.question_id !== null &&
    item.attempt === null &&
    run.finished_at === null &&
    !archived;
  const [sessionOpening, setSessionOpening] = useState<{ itemKey: string; key: string } | null>(
    null,
  );
  if (sessionWanted && itemKey && sessionOpening?.itemKey !== itemKey) {
    setSessionOpening({ itemKey, key: newKey() });
  }
  const opening = sessionWanted && sessionOpening?.itemKey === itemKey ? sessionOpening : null;
  const questionId = item?.question_id ?? null;
  // 다시 시도 after a failed opening asks again with the same key (one session per opening).
  const [sessionRetry, setSessionRetry] = useState(0);
  const sessionLoad = useKeyedLoad(
    opening ? `${opening.itemKey}:${opening.key}:${sessionRetry}` : null,
    () =>
      client.openSession(
        questionId ?? '',
        runId ?? '',
        position,
        opening?.key ?? '',
        item?.reset_epoch,
      ),
  );
  const session = sessionLoad?.status === 'ready' ? sessionLoad.data : null;
  const sessionId = session?.id ?? null;
  const sessionQuestion = session?.question_id ?? null;
  const onViewedRef = useRef(onViewed);
  useLayoutEffect(() => {
    onViewedRef.current = onViewed;
  });
  useEffect(() => {
    // The session opened: the server recorded the view (the Heatmap dot shows it at once).
    if (sessionId && sessionQuestion) onViewedRef.current?.(sessionQuestion);
  }, [sessionId, sessionQuestion]);
  const sessionKind = sessionLoad?.status === 'error' ? sessionLoad.kind : null;
  // Submitted elsewhere (another tab) or the run ended meanwhile: read what the server has, once
  // per failed opening.
  const [seenSessionLoad, setSeenSessionLoad] = useState(sessionLoad);
  if (sessionLoad !== seenSessionLoad) {
    setSeenSessionLoad(sessionLoad);
    if (sessionKind === 'alreadySubmitted') setItemSeq((n) => n + 1);
    if (sessionKind === 'finished') setRunSeq((n) => n + 1);
  }

  const workId = item && itemKey ? `${itemKey}:${session?.id ?? 'none'}` : null;
  const [workState, setWorkState] = useState<WorkState>(() => freshWork(null));
  const work = workId && workState.workId === workId ? workState : freshWork(workId);
  const liveWork = useRef<string | null>(null);
  useLayoutEffect(() => {
    liveWork.current = workId;
  }, [workId]);
  function updateWork(id: string, patch: (w: WorkState) => Partial<WorkState>) {
    if (liveWork.current !== id) return;
    setWorkState((prev) => {
      const base = prev.workId === id ? prev : freshWork(id);
      return { ...base, ...patch(base) };
    });
  }

  // Study flags of the question on screen (bank): read with the position, saved through my-state.
  // UX9-RETRY-OPT: a press shows at once and is saved in the background (FlagSync, serialized per
  // question); a failure rolls its fields back and is reported.
  const [flags, setFlags] = useState<{ questionId: string; flags: StudyFlags } | null>(null);
  // Re-reads only the study flags / eligibility (a refused `다시 풀기`), never the position: the
  // answer being typed and the open session stay.
  const [flagsSeq, setFlagsSeq] = useState(0);
  // Counts gradings made in this panel: a lookup started before one must not undo it.
  const gradeGen = useRef(0);
  const flagSync = useFlagSync<MyState>(
    (qid, patch) =>
      client.setFlags
        ? client.setFlags(qid, patch)
        : Promise.resolve({ ok: false, message: QUESTION_FAILURE_MESSAGES.unavailable }),
    (qid, event) => {
      const saved =
        event.type === 'saved' ? event.result : event.type === 'failed' ? event.saved : null;
      if (saved) {
        onFlagsSaved?.(qid, { is_favorite: saved.is_favorite, needs_retry: saved.needs_retry });
      }
      if (event.type === 'failed') {
        onFlagsFailed?.(event.message);
        // A stale panel offered `다시 풀기`: read the question's state again (hides the toggle).
        if (event.message === QUESTION_FAILURE_MESSAGES.retryNotAllowed) setFlagsSeq((n) => n + 1);
      }
      setFlags((prev) =>
        prev?.questionId !== qid ? prev : { questionId: qid, flags: event.flags },
      );
    },
    workspaceId,
  );
  // The last graded result of the question on screen: read with the flags, replaced by a result
  // graded here. An incorrect one also turns the flag off (the server does).
  const [lastGraded, setLastGraded] = useState<{
    questionId: string;
    result: 'correct' | 'incorrect' | null;
    /** The latest submission is not graded yet (the previous result stays). */
    pending: boolean;
    /** Graded in this panel (true) or read from the server (false). */
    local: boolean;
    /** `gradeGen` when it was graded here; a lookup started at or after it is newer. */
    gen: number;
  } | null>(null);
  function gradedHere(qid: string, result: 'correct' | 'incorrect') {
    gradeGen.current += 1;
    setLastGraded({ questionId: qid, result, pending: false, local: true, gen: gradeGen.current });
    if (result === 'incorrect') {
      setFlags((prev) =>
        prev?.questionId === qid
          ? { questionId: qid, flags: { ...prev.flags, needs_retry: false } }
          : prev,
      );
    }
  }
  function pendingHere(qid: string) {
    gradeGen.current += 1;
    const gen = gradeGen.current;
    setLastGraded((prev) => ({
      questionId: qid,
      result: prev?.questionId === qid ? prev.result : null,
      pending: true,
      local: true,
      gen,
    }));
  }
  const flagsWanted = source === 'bank' && !archived && client.flags ? questionId : null;
  const flagsLoad = useKeyedLoad(
    flagsWanted ? `${flagsWanted}:${itemSeq}:${flagsSeq}:${resetVersion}` : null,
    async () => {
      const started = gradeGen.current;
      const found = (await client.flags?.(flagsWanted ?? '')) ?? null;
      return found
        ? { ok: true as const, data: { ...found, started } }
        : { ok: false as const, kind: 'unavailable' as const, message: '' };
    },
  );
  const [seenFlags, setSeenFlags] = useState(flagsLoad);
  if (flagsLoad !== seenFlags) {
    setSeenFlags(flagsLoad);
    if (flagsLoad?.status === 'ready' && flagsWanted) {
      // A change still being saved wins over a read made before it.
      const active = flagSync.active(flagsWanted) ?? flagsLoad.data;
      // A grading made here is newer than a lookup that started before it (a delayed first
      // response must not bring back an older result): it wins over that lookup's. A lookup
      // started after it (the refresh of a refused `다시 풀기`) is the server's newer truth.
      const local =
        lastGraded?.questionId === flagsWanted &&
        lastGraded.local &&
        lastGraded.gen > flagsLoad.data.started
          ? lastGraded
          : null;
      setFlags({
        questionId: flagsWanted,
        flags: {
          is_favorite: active.is_favorite,
          needs_retry: local?.result === 'incorrect' ? false : active.needs_retry,
        },
      });
      setLastGraded(
        local ?? {
          questionId: flagsWanted,
          result: flagsLoad.data.last_graded_result ?? null,
          pending: flagsLoad.data.is_pending_grading ?? false,
          local: false,
          gen: 0,
        },
      );
    }
  }
  const shownFlags = flags && flags.questionId === questionId ? flags.flags : null;
  function changeFlags(patch: Partial<StudyFlags>) {
    if (!questionId || !shownFlags || !client.setFlags) return;
    flagSync.toggle(questionId, shownFlags, patch);
  }

  const formId = useId();
  const resultRef = useRef<HTMLElement>(null);
  const outcomeId = work.outcome?.attempt_id ?? null;
  const submittedHere = useRef<string | null>(null);
  useEffect(() => {
    // The submit button leaves: keep focus in the panel, on the result. Coming back to a submitted
    // position stays at the top (UX12-VIEW-AC06).
    if (outcomeId && outcomeId === submittedHere.current) {
      submittedHere.current = null;
      resultRef.current?.focus();
    }
  }, [outcomeId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !workId || work.busy || work.outcome || archived) return;
    if (!canSubmit(session, work.answer)) return;
    const qid = session.question_id;
    const version = practiceResetVersion(workspaceId, qid);
    updateWork(workId, () => ({ busy: 'submit', error: null }));
    let result: StudyActionResult<SubmitResult>;
    try {
      result = await client.submit(session.id, submitBody(session, work.answer));
    } catch {
      result = { ok: false, kind: 'unavailable', message: '제출하지 못했습니다. 다시 시도하세요.' };
    }
    if (practiceResetVersion(workspaceId, qid) !== version) return;
    if (result.ok) {
      if (result.data.result === 'pending') pendingHere(qid);
      else gradedHere(qid, result.data.result);
      onGraded?.(qid, result.data.result);
    } else if (runId) {
      // The answer may have been recorded and only the response lost (or another tab submitted
      // it): when the position now has an attempt, show what the server kept.
      const again = await client.getItem(runId, position).catch(() => null);
      if (liveWork.current === workId && again?.ok && again.data.attempt) {
        setItemSeq((n) => n + 1);
        return;
      }
    }
    if (result.ok) submittedHere.current = result.data.attempt_id;
    updateWork(workId, () =>
      result.ok
        ? { busy: null, outcome: result.data }
        : {
            busy: null,
            error:
              result.kind === 'unavailable'
                ? '제출하지 못했습니다. 다시 시도하세요.'
                : result.message,
          },
    );
  }

  // A pending submission (now, or an earlier one of this position) is graded by the user.
  const pendingSessionId =
    work.outcome?.result === 'pending' && work.selfGrade === null
      ? (session?.id ?? null)
      : !work.outcome && item?.session_state === 'pending_grade' && work.selfGrade === null
        ? item.practice_session_id
        : null;
  async function selfGrade(grade: GradeResult) {
    if (!pendingSessionId || !workId || work.busy || !questionId) return;
    const qid = questionId;
    const version = practiceResetVersion(workspaceId, qid);
    updateWork(workId, () => ({ busy: 'grade', error: null }));
    let ok = false;
    let message: string = QUESTION_FAILURE_MESSAGES.unavailable;
    try {
      const result = await client.selfGrade(pendingSessionId, grade);
      ok = result.ok;
      if (!result.ok) message = result.message;
    } catch {
      // network failure: keep the pending result and let the user try again
    }
    if (practiceResetVersion(workspaceId, qid) !== version) return;
    if (ok) gradedHere(qid, grade);
    if (ok) onGraded?.(qid, grade);
    updateWork(workId, () =>
      ok ? { busy: null, selfGrade: grade } : { busy: null, error: message },
    );
  }

  if (!view) {
    return {
      title: null,
      description: undefined,
      body: null,
      footer: undefined,
      question: null,
      attachment: null,
      onShowSource: null,
      flags: null,
      changeFlags: () => undefined,
    };
  }

  const total = run?.total ?? item?.total ?? null;
  const last = total !== null && position >= total;
  // A submission or a self-grade in flight holds the position: finishing the run under it would
  // refuse the answer (409 practice-run-finished) and count it as skipped.
  const holding = work.busy !== null;
  const go = (to: number) => {
    if (!holding) onNavigate({ step: 'solve', runId: view.runId, position: to }, 'push');
  };
  const toResults = () => {
    if (!holding) onNavigate({ step: 'results', runId: view.runId }, 'replace');
  };
  const forward = () => (last ? toResults() : go(position + 1));

  const revealed: RevealedAnswers | null = work.outcome ?? item?.attempt ?? null;
  const answered = revealed !== null;
  const finished = run?.finished_at != null;
  const unavailable = item !== null && !item.available;
  const answer = work.outcome || !item?.attempt ? work.answer : attemptAnswer(item);
  const shownQuestion: AnswerQuestion | null = session ?? (item ? itemQuestion(item) : null);
  const canAnswer = !answered && !finished && !unavailable;

  const progress =
    total !== null ? (
      <div className={styles.progress}>
        <ProgressBar
          label="진행"
          value={Math.round((Math.min(position, total) / Math.max(total, 1)) * 100)}
          valueText={progressText(position, total)}
        />
        <p className={styles.progressText} aria-live="polite">
          {progressText(position, total)}
        </p>
      </div>
    ) : null;

  // AIEXPL-01: under a submitted position's result (also one reopened read-only through 이전 or
  // the results list), with that position's submitted session; never before a submission.
  const answeredSessionId = answered ? (session?.id ?? item?.practice_session_id ?? null) : null;
  const explained = item?.question_id ?? null;
  const explanation =
    answeredSessionId && explained && shownQuestion ? (
      <AiExplanation
        workspaceId={workspaceId}
        target={{ kind: source === 'mock' ? 'mock' : 'question', id: explained }}
        gate={
          source === 'mock'
            ? { mock_practice_session_id: answeredSessionId }
            : { practice_session_id: answeredSessionId }
        }
        options={shownQuestion.options}
        askAttachment={
          source === 'mock'
            ? {
                kind: 'mock_exam_question',
                view: 'practice',
                mock_exam_question_id: explained,
                mock_practice_session_id: answeredSessionId,
              }
            : {
                kind: 'question',
                view: 'practice',
                question_id: explained,
                practice_session_id: answeredSessionId,
              }
        }
      />
    ) : null;
  // RELSRC-01: under the AI 해설, with the same submitted session (never before a submission).
  const related =
    answeredSessionId && explained && shownQuestion ? (
      <RelatedSources
        workspaceId={workspaceId}
        target={{ kind: source === 'mock' ? 'mock' : 'question', id: explained }}
        gate={
          source === 'mock'
            ? { mock_practice_session_id: answeredSessionId }
            : { practice_session_id: answeredSessionId }
        }
      />
    ) : null;

  let content: ReactNode;
  if (runLoad?.status === 'error' || itemLoad?.status === 'error') {
    const failure = runLoad?.status === 'error' ? runLoad : itemLoad;
    content =
      failure?.status === 'error' && failure.kind === 'notFound' ? (
        <NotFound />
      ) : (
        <div role="alert" className={styles.error}>
          <p>{failure?.status === 'error' ? failure.message : RUN_FAILURE_MESSAGES.unavailable}</p>
          {failure?.status === 'error' && failure.kind === 'reset' ? (
            <Button
              onClick={() =>
                onNavigate({ step: 'picker', source: 'bank', mockExamId: null }, 'replace')
              }
            >
              새 풀이 시작
            </Button>
          ) : (
            <Button
              onClick={() => {
                setRunSeq((n) => n + 1);
                setItemSeq((n) => n + 1);
              }}
            >
              다시 시도
            </Button>
          )}
        </div>
      );
  } else if (!item || !run) {
    content = (
      <div aria-busy="true">
        <p className={styles.loading}>문제를 불러오는 중입니다…</p>
      </div>
    );
  } else if (unavailable) {
    content = <p className={styles.notice}>이 문제는 더 이상 풀 수 없습니다.</p>;
  } else if (!shownQuestion || (sessionWanted && !session && sessionLoad?.status !== 'error')) {
    content = (
      <div aria-busy="true">
        <QuestionStem stem={item.stem ?? ''} />
        <p className={styles.loading}>문제를 불러오는 중입니다…</p>
      </div>
    );
  } else {
    content = (
      <>
        {archived && canAnswer ? (
          <p className={styles.notice}>{RUN_FAILURE_MESSAGES.archived}</p>
        ) : null}
        {finished && !answered ? <p className={styles.notice}>건너뛴 문제입니다.</p> : null}
        {sessionLoad?.status === 'error' &&
        sessionKind !== 'alreadySubmitted' &&
        sessionKind !== 'finished' ? (
          <div role="alert" className={styles.error}>
            <p>{sessionLoad.message}</p>
            {sessionKind === 'reset' ? (
              <Button
                onClick={() =>
                  onNavigate({ step: 'picker', source: 'bank', mockExamId: null }, 'replace')
                }
              >
                새 풀이 시작
              </Button>
            ) : (
              <Button onClick={() => setSessionRetry((n) => n + 1)}>다시 시도</Button>
            )}
          </div>
        ) : null}
        {item.question_id ? <QuestionSourceButton source={sourcePreview} /> : null}
        <form
          id={formId}
          className={styles.form}
          onSubmit={(e) => void submit(e)}
          aria-busy={work.busy !== null || undefined}
          noValidate
        >
          <QuestionBody
            kind="answer"
            stem={session?.stem ?? item.stem ?? ''}
            question={shownQuestion}
            figures={item.question_id ? <QuestionFigures source={sourcePreview} /> : null}
            answer={answer}
            disabled={!canAnswer || work.busy !== null}
            onAnswerChange={(next) => {
              if (workId && canAnswer) updateWork(workId, () => ({ answer: next }));
            }}
            outcome={revealed}
            selfGrade={work.selfGrade}
            error={work.error}
            resultRef={resultRef}
            highlighting={
              source === 'bank' && item.question_id
                ? {
                    questionId: item.question_id,
                    revisionId: session?.question_revision_id ?? null,
                    chapterTitle: item.chapter_title ?? null,
                  }
                : null
            }
          />
        </form>
        {explanation}
        {related}
      </>
    );
  }

  const footer = (
    <>
      {item && run && canAnswer && shownQuestion ? (
        <Button
          type="submit"
          form={formId}
          variant="primary"
          loading={work.busy === 'submit'}
          disabled={archived || !session || !canSubmit(session, work.answer)}
        >
          제출
        </Button>
      ) : null}
      {pendingSessionId ? (
        <SelfGradeButtons busy={work.busy === 'grade'} onGrade={(g) => void selfGrade(g)} />
      ) : null}
      {item?.available && item.question_id && run && !archived ? (
        <Button
          disabled={holding}
          onClick={() =>
            setRetryTarget({ key: `${runId}:${position}`, questionId: item.question_id ?? '' })
          }
        >
          다시 풀기
        </Button>
      ) : null}
      <nav className={styles.nav} aria-label="문제 이동">
        <NavButton
          direction="previous"
          label="이전"
          unavailable={position <= 1 || holding}
          onClick={() => go(position - 1)}
        />
        {/* Always a way forward, also while the position loads (it is skipped then). */}
        {total === null ? null : last ? (
          <Button
            variant={!item || !run || canAnswer ? 'secondary' : 'primary'}
            disabled={holding}
            onClick={toResults}
          >
            결과 보기
          </Button>
        ) : !item || !run || canAnswer ? (
          <NavButton direction="next" label="건너뛰기" unavailable={holding} onClick={forward} />
        ) : (
          <NavButton
            direction="next"
            label="다음"
            variant="primary"
            unavailable={holding}
            onClick={forward}
          />
        )}
      </nav>
    </>
  );

  const title = item && item.available ? positionLabel(item, source) : null;
  const question: RunQuestionInfo | null =
    item && item.available && item.question_id && title
      ? {
          questionId: item.question_id,
          title,
          questionType: item.question_type ?? 'MCQ',
          chapterTitle: item.chapter_title ?? '챕터 없음',
        }
      : null;
  // The mock exam position's practice session (open, or the submitted one), with the answer chosen
  // so far; a question no longer in the mock exam (or a deleted mock exam) has none.
  const mockSessionId = session?.id ?? item?.practice_session_id ?? null;
  const attachment: AskAttachmentInput | null =
    source === 'mock' && question && mockSessionId
      ? {
          kind: 'mock_exam_question',
          view: 'practice',
          mock_exam_question_id: question.questionId,
          mock_practice_session_id: mockSessionId,
          selected_option_ids: answered ? [] : answer.selected.slice(0, 50),
        }
      : null;
  return {
    title,
    description: question
      ? `${questionTypeLabels[question.questionType]} · ${question.chapterTitle}`
      : undefined,
    body: (
      <>
        {progress}
        {content}
        {/* Outside `content`: the header menu opens it in every state of the position. */}
        <QuestionSourceDialog source={sourcePreview} />
        {retryTarget && retryTarget.key === `${runId}:${position}` && active ? (
          <SeparateRetry
            workspaceId={workspaceId}
            questionId={retryTarget.questionId}
            source={source}
            runId={view.runId}
            position={position}
            resetEpoch={item?.reset_epoch ?? null}
            onGraded={(qid, result) => {
              if (result === 'pending') pendingHere(qid);
              else gradedHere(qid, result);
              onGraded?.(qid, result);
            }}
            onClose={() => setRetryTarget(null)}
          />
        ) : null}
      </>
    ),
    footer,
    question,
    attachment,
    onShowSource: sourcePreview.onShowSource,
    flags: shownFlags,
    lastGraded: lastGraded && lastGraded.questionId === questionId ? lastGraded.result : null,
    pendingGrading: lastGraded?.questionId === questionId && lastGraded.pending,
    changeFlags,
  };
}

// --- results step -----------------------------------------------------------------------------

interface ResultsData {
  readonly run: PracticeRun;
  readonly items: readonly RunResultItem[];
  readonly total: number;
}

async function readResults(
  client: RunClient,
  runId: string,
): Promise<RunActionResult<ResultsData>> {
  // `결과 보기` ends the run (idempotent): the positions not submitted count as skipped.
  const finished = await client.finish(runId);
  if (!finished.ok) return finished;
  const page = await client.results(runId, 0);
  if (!page.ok) return page;
  return { ok: true, data: { run: finished.data, items: page.data.items, total: page.data.total } };
}

function useResultsStep({
  runId,
  resetVersion,
  client,
  source,
  invalidated,
  onNavigate,
  onClose,
}: {
  readonly runId: string | null;
  readonly resetVersion: number;
  readonly client: RunClient;
  readonly source: RunSource;
  readonly invalidated: Invalidation | null;
  readonly onNavigate: (state: RunUrlState, how: 'push' | 'replace') => void;
  readonly onClose: () => void;
}): { body: ReactNode; footer: ReactNode } {
  const [retry, setRetry] = useState(0);
  const invalidationSeq = source === 'bank' ? (invalidated?.seq ?? 0) : 0;
  const load = useKeyedLoad(
    runId ? `${runId}:${retry}:${invalidationSeq}:${resetVersion}` : null,
    () => readResults(client, runId ?? ''),
  );
  const data = load?.status === 'ready' ? load.data : null;
  const [more, setMore] = useState<{
    runId: string;
    seq: number;
    resetVersion: number;
    items: RunResultItem[];
  } | null>(null);
  const extra =
    more &&
    more.runId === runId &&
    more.seq === invalidationSeq &&
    more.resetVersion === resetVersion
      ? more.items
      : [];
  const items = data ? [...data.items, ...extra] : [];
  const [loadingMore, setLoadingMore] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restartKey = useRequestKey();
  // Each showing of the results step: an answer that arrives after it closed (or after it showed
  // again) is dropped — a late 처음부터 다시 never reopens a dismissed panel.
  const [visit, setVisit] = useState(0);
  const [seenRunId, setSeenRunId] = useState(runId);
  if (runId !== seenRunId) {
    setSeenRunId(runId);
    if (runId) {
      setVisit((n) => n + 1);
      setError(null);
      setRestarting(false);
      setLoadingMore(false);
    }
  }
  const liveVisit = useRef<number | null>(null);
  useLayoutEffect(() => {
    liveVisit.current = runId ? visit : null;
  });

  async function loadMore() {
    if (!data || !runId || loadingMore) return;
    const token = visit;
    setLoadingMore(true);
    const page = await client.results(runId, items.length).catch(() => null);
    if (liveVisit.current !== token) return;
    setLoadingMore(false);
    if (page?.ok)
      setMore({ runId, seq: invalidationSeq, resetVersion, items: [...extra, ...page.data.items] });
    else setError(page?.message ?? RUN_FAILURE_MESSAGES.unavailable);
  }

  async function restart() {
    if (!data || !runId || restarting) return;
    const token = visit;
    setRestarting(true);
    setError(null);
    let failure: string | null = null;
    let started: string | null = null;
    try {
      // The same questions (those still available) and the same order setting, as a new run.
      const all = [...items];
      while (all.length < data.total) {
        const page = await client.results(runId, all.length);
        if (!page.ok) throw new Error(page.message);
        if (page.data.items.length === 0) break;
        all.push(...page.data.items);
      }
      const range = restartRange(all);
      const key = restartKey.keyFor(JSON.stringify([token, range, data.run.random_order]));
      const created = await client.create(range, data.run.random_order, key);
      if (created.ok) {
        restartKey.succeeded(key);
        started = created.data.id;
      } else {
        failure = created.message;
      }
    } catch {
      failure = RUN_FAILURE_MESSAGES.unavailable;
    }
    if (liveVisit.current !== token) return;
    setRestarting(false);
    if (started) onNavigate({ step: 'solve', runId: started, position: 1 }, 'replace');
    else setError(failure);
  }

  let body: ReactNode;
  if (load?.status === 'error') {
    body =
      load.kind === 'notFound' ? (
        <NotFound />
      ) : (
        <div role="alert" className={styles.error}>
          <p>{load.message}</p>
          <Button onClick={() => setRetry((n) => n + 1)}>다시 시도</Button>
        </div>
      );
  } else if (!data) {
    body = (
      <div aria-busy="true">
        <p className={styles.loading}>결과를 불러오는 중입니다…</p>
      </div>
    );
  } else {
    body = (
      <>
        <p className={styles.summary}>{summaryText(data.run.summary)}</p>
        <GroupedResults
          items={items}
          source={source}
          onSelect={(position) => {
            if (runId) onNavigate({ step: 'solve', runId, position }, 'push');
          }}
        />
        {items.length < data.total ? (
          <Button size="sm" loading={loadingMore} onClick={() => void loadMore()}>
            결과 더 보기
          </Button>
        ) : null}
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </>
    );
  }
  const footer = (
    <div className={styles.stepActions}>
      <Button
        variant="primary"
        loading={restarting}
        disabled={!data}
        onClick={() => void restart()}
      >
        처음부터 다시
      </Button>
      <Button onClick={onClose}>닫기</Button>
    </div>
  );
  return { body, footer: data || load?.status === 'error' ? footer : undefined };
}

'use client';

// QuestionViewer `practice` mode (QVIEW-01 call sites 1–3: a Heatmap marker or `?question=`, the
// history dialog's attempt links, a 정리 노트 footnote; QPLAY-01, questions.md §3.2/§4,
// design-system §5.1): one question in a modal Floating Side Panel. Opening it starts a practice
// session, which is what records the view (never the hover preview). The session carries no
// answers: the correct options, accepted answers, rubric and explanation arrive only with the
// submit result. Essays and ungradable short answers stay pending until the user grades them
// (맞음/틀림). Previous/next follow the heatmap order and are URL changes owned by the screen;
// Escape/close return focus to the dot (the screen decides).
// UX7-CACHE (QPLAY-01-AC06): the open, answer-free sessions this viewer started are kept in memory
// (lib/questions/practice-cache.ts); a session whose submission started is never reused.
// UX12-OPEN: every opening is one `practice-open` call. It confirms the latest result and reuses
// the cached session or opens one in one transaction; nothing can be answered before it returns.
// UX7-BANK: editors get the screen's 문제 관리 menu (`headerExtra`) in the header; after an edit
// the screen invalidates that question (`invalidated`) and the viewer, if it still shows it,
// opens a session of the new revision (the cached session of the old revision is dropped).
// UX7-BANK-2: the header menu's 정답·해설 보기 opens a separate read-only dialog over the panel; the
// session on screen (and an answer being chosen) stays as it is and nothing is recorded.
import {
  Button,
  ConfirmDialog,
  FavoriteToggle,
  FloatingSidePanel,
  RetryToggle,
  questionTypeLabels,
} from '@quiz/ui';
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
import {
  resetPracticeAction,
  selfGradePracticeAction,
  submitPracticeAction,
  type PracticeSession,
  type StudyActionResult,
  type SubmitResult,
} from '@/lib/questions/practice-actions';
import { useOptionalPracticeReturn } from '@/components/practice-return/practice-return-provider';
import { AiExplanation } from '@/components/questions/ai-explanation/ai-explanation';
import { RelatedSources } from '@/components/questions/related-sources/related-sources';
import { PracticeSessionCache } from '@/lib/questions/practice-cache';
import { openQuestionPractice } from '@/lib/questions/practice-open-client';
import {
  measurePracticeOpen,
  PRACTICE_NAVIGATION_PAUSE_MS,
  PRACTICE_OPEN_MEASURE,
} from '@/lib/questions/practice-open-timing';
import {
  practiceResetVersion,
  rememberPracticeEpoch,
  publishPracticeReset,
  subscribePracticeResets,
} from '@/lib/questions/practice-reset-events';
import { QUESTION_FAILURE_MESSAGES } from '@/lib/questions/problems';
import {
  canSubmit,
  EMPTY_ANSWER,
  submitBody,
  type AttemptResult,
  type GradeResult,
  type Neighbors,
  type PracticeAnswer,
} from './practice-model';
import { QuestionBody, QuestionStem } from './question-body';
import { AnotherTryButton, QuestionNav } from './question-footer';
import {
  QuestionFigures,
  QuestionSourceButton,
  QuestionSourceDialog,
  useQuestionSource,
  type QuestionSourceControls,
} from './question-source-preview';
import styles from './question-viewer.module.css';

export interface PracticeQuestion {
  readonly id: string;
  /** `12번 문제`: names the dialog (same title as the dot's preview). */
  readonly title: string;
  readonly chapterTitle: string;
  readonly questionType: keyof typeof questionTypeLabels;
  /** Overview preview (first lines of the stem), shown until the session arrives. */
  readonly preview: string;
  readonly isFavorite: boolean;
  /** The flags to show: a change being saved shows at once (UX9-RETRY-OPT, optimistic). */
  readonly needsRetry: boolean;
  /** The last graded result: `다시 풀기` is offered only after a correct one (RETRY-CORRECT). */
  readonly lastGradedResult: 'correct' | 'incorrect' | null;
  /** The latest submission waits for self-grading: the toggle stays hidden until it is graded. */
  readonly isPendingGrading: boolean;
}

export interface PracticeViewerProps {
  readonly workspaceId: string;
  /** The open question; null = closed. */
  readonly question: PracticeQuestion | null;
  /** Archived workspace: no session, no study-state changes (the API refuses them too). */
  readonly readOnly: boolean;
  /** `data-screen-id` of the panel body (QPLAY-01). */
  readonly screenId?: string;
  /** Previous/next question ids in the heatmap order (null = none). */
  readonly neighbors?: Neighbors;
  readonly onNavigate?: (questionId: string) => void;
  readonly onClose: () => void;
  /** Favorite / retry toggled in the header. */
  readonly onFlagsChange: (
    questionId: string,
    flags: { is_favorite?: boolean; needs_retry?: boolean },
  ) => void;
  /** A session was opened: the server recorded the view. */
  readonly onReset?: (questionId: string) => void;
  readonly onViewed: (questionId: string) => void;
  /** An answer was submitted (`pending`) or graded (auto or self). */
  readonly onGraded?: (questionId: string, result: AttemptResult) => void;
  /** Where focus goes when the panel closes (the opening dot). */
  readonly onCloseAutoFocus?: ComponentProps<typeof FloatingSidePanel>['onCloseAutoFocus'];
  /**
   * Header controls after the study toggles (UX7-BANK: the editors' 문제 관리 menu; UX7-BANK-2:
   * everyone else's 문제 정보 menu, shown in archived workspaces too).
   */
  readonly headerExtra?: (source: QuestionSourceControls) => ReactNode;
  /**
   * UX7-BANK: a question whose cached session must never be shown again (edited or deleted);
   * a new `seq` invalidates `questionId` once.
   */
  readonly invalidated?: Invalidation | null;
}

export interface Invalidation {
  readonly questionId: string;
  readonly seq: number;
}

type SessionState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly session: PracticeSession;
      readonly prior?: { outcome: SubmitResult; answer: PracticeAnswer };
      readonly previousRevision?: boolean;
    }
  | { readonly status: 'error'; readonly message: string };

interface Opening {
  readonly questionId: string | null;
  /** Idempotency key of this opening: a re-run effect (Strict Mode, retry) reuses it. */
  readonly key: string;
  /** The open session to reuse if the server confirms it is current. */
  readonly cached: PracticeSession | null;
  readonly forceNew?: boolean;
  /** Reached from another question: passed over quickly, it must not count as viewed. */
  readonly afterNavigation?: boolean;
}

/** The answering state of one session in one opening. */
interface Work {
  /** `${opening key}:${session id}`: a re-opened (cached) session starts with an empty answer. */
  readonly workId: string | null;
  readonly answer: PracticeAnswer;
  readonly busy: 'submit' | 'grade' | null;
  readonly outcome: SubmitResult | null;
  readonly selfGrade: GradeResult | null;
  readonly error: string | null;
}

function freshWork(workId: string | null): Work {
  return {
    workId,
    answer: EMPTY_ANSWER,
    busy: null,
    outcome: null,
    selfGrade: null,
    error: null,
  };
}

function newKey(): string {
  return crypto.randomUUID();
}

const NO_NEIGHBORS: Neighbors = { previous: null, next: null };

export function PracticeViewer({
  workspaceId,
  question,
  readOnly,
  screenId,
  neighbors = NO_NEIGHBORS,
  onNavigate,
  onClose,
  onFlagsChange,
  onViewed,
  onReset,
  onGraded,
  onCloseAutoFocus,
  headerExtra,
  invalidated = null,
}: PracticeViewerProps) {
  const questionId = question?.id ?? null;
  const returnControl = useOptionalPracticeReturn();
  const recordActivity = returnControl?.recordActivity;
  // The last open question keeps rendering while the panel animates closed.
  const [shown, setShown] = useState(question);
  if (question && question !== shown) setShown(question);
  const source = useQuestionSource(questionId ? { kind: 'question', id: questionId } : null);
  const extra = headerExtra?.({ onShowSource: source.onShowSource });

  // One cache per workspace: another workspace starts empty (the old one is dropped).
  const [cache, setCache] = useState(() => new PracticeSessionCache(workspaceId));
  const scoped = cache.workspaceId === workspaceId.toLowerCase();
  if (!scoped) setCache(new PracticeSessionCache(workspaceId));

  const liveWork = useRef<string | null>(null);
  // The question whose reset is closing the panel: nothing may open it again on the way out, or
  // the new session's view would bring back what the reset cleared (UX10-QVIEW-AC04).
  const resetClosing = useRef<string | null>(null);
  useEffect(
    () =>
      subscribePracticeResets(workspaceId, (id) => {
        const stale = cache.get(id);
        if (stale) cache.dropSession(stale.id);
        if (id === questionId) resetClosing.current = id;
        onReset?.(id);
        if (id === questionId) {
          liveWork.current = null;
          onClose();
        }
      }),
    [cache, workspaceId, questionId, onReset, onClose],
  );

  // Forget an invalidated question's cached session before anything reads the cache; when it is
  // the question on screen, it is opened again (a session of its new revision).
  const [seenInvalidation, setSeenInvalidation] = useState(invalidated);
  const invalidating = invalidated !== seenInvalidation;
  if (invalidating) {
    setSeenInvalidation(invalidated);
    const stale = invalidated ? cache.get(invalidated.questionId) : null;
    if (stale) cache.dropSession(stale.id);
  }
  const reopen =
    invalidating &&
    invalidated !== null &&
    questionId !== null &&
    invalidated.questionId.toLowerCase() === questionId.toLowerCase();

  const [opening, setOpening] = useState<Opening>(() => ({
    questionId,
    key: newKey(),
    cached: cache.get(questionId),
  }));
  if (opening.questionId !== questionId || reopen) {
    setOpening({
      questionId,
      key: newKey(),
      cached: scoped ? cache.get(questionId) : null,
      afterNavigation:
        opening.questionId !== null && questionId !== null && opening.questionId !== questionId,
    });
  }
  const [session, setSession] = useState<SessionState & { readonly key: string | null }>({
    status: 'loading',
    key: null,
  });

  useEffect(() => {
    const id = opening.questionId;
    if (!id) resetClosing.current = null;
    if (!id || readOnly || resetClosing.current === id) return;
    let current = true;
    const key = opening.key;
    const startedAt = performance.now();
    const open = async () => {
      const resetVersion = practiceResetVersion(workspaceId, id);
      const held =
        opening.cached && cache.get(id)?.id === opening.cached.id ? opening.cached : null;
      const opened = await openQuestionPractice(workspaceId, id, key, {
        forceNew: opening.forceNew,
        ...(held && !opening.forceNew
          ? {
              cached: {
                sessionId: held.id,
                baselineAttemptId: cache.baselineAttemptId(id) ?? null,
              },
            }
          : {}),
      });
      measurePracticeOpen(PRACTICE_OPEN_MEASURE, startedAt);
      if (!current || practiceResetVersion(workspaceId, id) !== resetVersion) return;
      if (!opened.ok) {
        setSession({ status: 'error', message: opened.message, key });
        return;
      }
      const { data } = opened;
      rememberPracticeEpoch(workspaceId, id, data.reset_epoch);
      if (opening.cached && !data.reused) cache.dropSession(opening.cached.id);
      const outcome = data.result?.outcome;
      if (data.result && outcome) {
        const saved = data.submitted_answer;
        const answer: PracticeAnswer = {
          selected: Array.isArray(saved?.selected_option_ids)
            ? (saved.selected_option_ids as string[])
            : [],
          text: typeof saved?.answer_text === 'string' ? saved.answer_text : '',
        };
        onGraded?.(id, outcome.result);
        setSession({
          status: 'ready',
          session: data.result,
          prior: { outcome, answer },
          key,
        });
        return;
      }
      if (!data.session) {
        setSession({ status: 'error', message: '문제를 불러오지 못했습니다.', key });
        return;
      }
      if (!data.reused) {
        cache.put(data.session, data.reset_epoch, data.latest_attempt_id);
        onViewed(id);
      }
      setSession({
        status: 'ready',
        session: data.session,
        previousRevision: data.previous_revision,
        key,
      });
    };
    const start = () => {
      open().catch(() => {
        if (current) setSession({ status: 'error', message: '문제를 불러오지 못했습니다.', key });
      });
    };
    let pause: ReturnType<typeof setTimeout> | undefined;
    if (opening.afterNavigation) pause = setTimeout(start, PRACTICE_NAVIGATION_PAUSE_MS);
    else start();
    return () => {
      current = false;
      clearTimeout(pause);
    };
    // onViewed is a stable callback of the screen; the opening identifies the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening, readOnly, workspaceId, cache]);

  const view = shown;
  const state: SessionState =
    session.key === opening.key ? session : { status: 'loading' as const };
  const ready = state.status === 'ready' ? state.session : null;
  useEffect(() => {
    if (questionId && !readOnly) {
      recordActivity?.({ kind: 'question', workspaceId, questionId });
    }
  }, [questionId, readOnly, recordActivity, workspaceId]);

  // Answering state belongs to one opening of one session: a new session (next question, reopen)
  // and a re-opened cached one start empty.
  const workId = ready ? `${opening.key}:${ready.id}` : null;
  const [workState, setWorkState] = useState<Work>(() => freshWork(null));
  const initial: Work =
    state.status === 'ready' && state.prior
      ? { ...freshWork(workId), answer: state.prior.answer, outcome: state.prior.outcome }
      : freshWork(workId);
  const work = workId && workState.workId === workId ? workState : initial;
  // The session being answered now: a late result of an earlier session (the user moved on to
  // another question meanwhile) must not land in the new one.
  useLayoutEffect(() => {
    liveWork.current = workId;
  }, [workId]);
  /** Applies `patch` only while `id` is still the opening being answered. */
  function updateWork(id: string, patch: (w: Work) => Partial<Work>) {
    if (liveWork.current !== id) return;
    setWorkState((prev) => {
      const base = prev.workId === id ? prev : initial;
      return { ...base, ...patch(base) };
    });
  }

  const formId = useId();
  const resultRef = useRef<HTMLElement>(null);
  const outcomeId = work.outcome?.attempt_id ?? null;
  const submittedHere = useRef<string | null>(null);
  useEffect(() => {
    // The submit button leaves with the answer form: keep focus in the panel on the result. A
    // question reopened with its result stays at the top (UX12-VIEW-AC05).
    if (outcomeId && outcomeId === submittedHere.current) {
      submittedHere.current = null;
      resultRef.current?.focus();
    }
  }, [outcomeId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || !view || !workId || work.busy || work.outcome || !canSubmit(ready, work.answer)) {
      return;
    }
    const qid = view.id;
    const resetVersion = practiceResetVersion(workspaceId, qid);
    // Submitted (or failed: already submitted elsewhere) sessions are never shown again.
    cache.dropSession(ready.id);
    updateWork(workId, () => ({ busy: 'submit', error: null }));
    let result: StudyActionResult<SubmitResult>;
    try {
      result = await submitPracticeAction(workspaceId, ready.id, submitBody(ready, work.answer));
    } catch {
      result = { ok: false, kind: 'unavailable', message: QUESTION_FAILURE_MESSAGES.unavailable };
    }
    if (result.ok && practiceResetVersion(workspaceId, qid) === resetVersion) {
      onGraded?.(qid, result.data.result);
    }
    if (result.ok) submittedHere.current = result.data.attempt_id;
    updateWork(workId, () =>
      result.ok ? { busy: null, outcome: result.data } : { busy: null, error: result.message },
    );
  }

  async function selfGrade(grade: GradeResult) {
    if (
      !ready ||
      !view ||
      !workId ||
      work.busy ||
      work.outcome?.result !== 'pending' ||
      work.selfGrade
    ) {
      return;
    }
    const qid = view.id;
    const resetVersion = practiceResetVersion(workspaceId, qid);
    updateWork(workId, () => ({ busy: 'grade', error: null }));
    let ok = false;
    let message: string = QUESTION_FAILURE_MESSAGES.unavailable;
    try {
      const result = await selfGradePracticeAction(workspaceId, ready.id, grade);
      ok = result.ok;
      if (!result.ok) message = result.message;
    } catch {
      // network failure: keep the pending result and let the user try again
    }
    if (ok && practiceResetVersion(workspaceId, qid) === resetVersion) onGraded?.(qid, grade);
    updateWork(workId, () =>
      ok ? { busy: null, selfGrade: grade } : { busy: null, error: message },
    );
  }

  const locked = work.busy !== null || work.outcome !== null;
  const outcome = work.outcome;
  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const resetKey = useRef(newKey());
  const pendingGrade = outcome?.result === 'pending' && work.selfGrade === null;
  const finished = outcome !== null && !pendingGrade;

  const footer = view ? (
    <div className={styles.footer}>
      {ready && !outcome ? (
        <Button
          type="submit"
          form={formId}
          variant="primary"
          loading={work.busy === 'submit'}
          disabled={!canSubmit(ready, work.answer)}
        >
          제출
        </Button>
      ) : null}
      {ready && pendingGrade ? (
        <SelfGradeButtons busy={work.busy === 'grade'} onGrade={(g) => void selfGrade(g)} />
      ) : null}
      {readOnly ? null : (
        <AnotherTryButton
          available={ready !== null && finished}
          onTry={() =>
            setOpening((o) => ({
              ...o,
              key: newKey(),
              cached: null,
              forceNew: true,
              afterNavigation: false,
            }))
          }
        />
      )}
      {ready && (outcome || view.lastGradedResult || view.isPendingGrading) ? (
        <Button
          onClick={() => {
            resetKey.current = newKey();
            setResetError(null);
            setResetOpen(true);
          }}
        >
          초기화
        </Button>
      ) : null}
      <QuestionNav
        previousUnavailable={!neighbors.previous || !onNavigate}
        nextUnavailable={!neighbors.next || !onNavigate}
        onPrevious={() => {
          if (neighbors.previous) onNavigate?.(neighbors.previous);
        }}
        onNext={() => {
          if (neighbors.next) onNavigate?.(neighbors.next);
        }}
      />
    </div>
  ) : undefined;

  return (
    <FloatingSidePanel
      open={question !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={view?.title ?? '문제'}
      description={
        view ? `${questionTypeLabels[view.questionType]} · ${view.chapterTitle}` : undefined
      }
      closeLabel="패널 닫기"
      onCloseAutoFocus={onCloseAutoFocus}
      footer={footer}
      // Not on close: the panel keeps its place while it animates out.
      scrollKey={questionId ? opening.key : undefined}
      headerActions={
        view && !readOnly ? (
          <>
            <StudyToggles
              favorite={view.isFavorite}
              retry={view.needsRetry}
              retryAvailable={view.lastGradedResult === 'correct' && !view.isPendingGrading}
              disabled={!ready}
              onChange={(flags) => onFlagsChange(view.id, flags)}
            />
            {extra}
          </>
        ) : view ? (
          // Archived: no study toggles, but the read-only 문제 정보 menu stays (UX7-BANK-2).
          extra
        ) : undefined
      }
    >
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="풀이 기록 초기화"
        description={
          <>
            이 문제의 내 풀이 기록과 Heatmap 상태가 초기화됩니다. 되돌릴 수 없습니다.
            {resetError ? <span role="alert"> {resetError}</span> : null}
          </>
        }
        confirmLabel="초기화"
        loading={resetBusy}
        onConfirm={() => {
          if (!view || resetBusy) return;
          setResetBusy(true);
          const version = practiceResetVersion(workspaceId, view.id);
          void resetPracticeAction(workspaceId, view.id, resetKey.current)
            .then((result) => {
              if (practiceResetVersion(workspaceId, view.id) !== version) return;
              setResetBusy(false);
              if (!result.ok) {
                setResetError(result.message);
                return;
              }
              if (ready) cache.dropSession(ready.id);
              liveWork.current = null;
              setResetOpen(false);
              publishPracticeReset(workspaceId, result.data.epochs);
            })
            .catch(() => {
              setResetBusy(false);
              setResetError(QUESTION_FAILURE_MESSAGES.unavailable);
            });
        }}
      />
      {view ? (
        <div className={styles.body} data-screen-id={screenId}>
          {/* QSRC-01: requested as soon as the panel shows the question, in every state. */}
          <QuestionSourceButton source={source} />
          <QuestionSourceDialog source={source} />
          {readOnly ? (
            <>
              <p className={styles.notice}>
                보관된 Workspace는 읽기 전용입니다. 문제를 풀거나 학습 상태를 바꿀 수 없습니다.
              </p>
              <QuestionStem stem={view.preview} />
            </>
          ) : ready ? (
            <>
              {state.status === 'ready' && state.previousRevision ? (
                <p>
                  문제가 변경되었습니다.{' '}
                  <a href={`/workspaces/${workspaceId}?panel=history`}>이전 풀이 이력 보기</a>
                </p>
              ) : null}
              <form
                id={formId}
                className={styles.form}
                onSubmit={(e) => void submit(e)}
                aria-busy={work.busy !== null || undefined}
                noValidate
              >
                <QuestionBody
                  kind="answer"
                  stem={ready.stem}
                  stemTables={ready.stem_tables}
                  question={ready}
                  figures={<QuestionFigures source={source} />}
                  answer={work.answer}
                  disabled={locked}
                  onAnswerChange={(answer) => {
                    if (workId) updateWork(workId, () => ({ answer }));
                  }}
                  outcome={outcome}
                  selfGrade={work.selfGrade}
                  error={work.error}
                  resultRef={resultRef}
                  highlighting={{
                    questionId: view.id,
                    revisionId: ready.question_revision_id,
                    chapterTitle: view.chapterTitle,
                  }}
                />
              </form>
              {outcome ? (
                // AIEXPL-01: only once this session was submitted (nothing is read before).
                <AiExplanation
                  workspaceId={workspaceId}
                  target={{ kind: 'question', id: ready.question_id }}
                  gate={{ practice_session_id: ready.id }}
                  options={ready.options}
                  askAttachment={{
                    kind: 'question',
                    view: 'practice',
                    question_id: ready.question_id,
                    practice_session_id: ready.id,
                  }}
                />
              ) : null}
              {outcome ? (
                // RELSRC-01: under the AI 해설, also only once this session was submitted.
                <RelatedSources
                  workspaceId={workspaceId}
                  target={{ kind: 'question', id: ready.question_id }}
                  gate={{ practice_session_id: ready.id }}
                />
              ) : null}
            </>
          ) : state.status === 'error' ? (
            <div role="alert" className={styles.error}>
              <p>{state.message}</p>
              <Button
                onClick={() =>
                  setOpening((o) => ({ ...o, key: newKey(), cached: null, afterNavigation: false }))
                }
              >
                다시 시도
              </Button>
            </div>
          ) : (
            <div aria-busy="true">
              <QuestionStem stem={view.preview} />
              <p className={styles.loading}>문제를 불러오는 중입니다…</p>
            </div>
          )}
        </div>
      ) : null}
    </FloatingSidePanel>
  );
}

/**
 * Favorite / retry toggles of a bank question (practice, sequence(bank)). UX9-RETRY-OPT: they are
 * never busy — the caller shows each press at once and saves it in the background (FlagSync), so
 * pressing one never changes the other. RETRY-CORRECT: `다시 풀기` is not rendered at all unless
 * `retryAvailable` (the last graded result is correct), even when the flag is still on.
 */
export function StudyToggles({
  favorite,
  retry,
  retryAvailable,
  disabled = false,
  onChange,
}: {
  readonly disabled?: boolean;
  readonly favorite: boolean;
  readonly retry: boolean;
  readonly retryAvailable: boolean;
  readonly onChange: (flags: { is_favorite?: boolean; needs_retry?: boolean }) => void;
}) {
  return (
    <>
      <FavoriteToggle
        disabled={disabled}
        pressed={favorite}
        onPressedChange={(pressed) => onChange({ is_favorite: pressed })}
      />
      {retryAvailable ? (
        <RetryToggle
          disabled={disabled}
          pressed={retry}
          onPressedChange={(pressed) => onChange({ needs_retry: pressed })}
        />
      ) : null}
    </>
  );
}

/** 맞음 / 틀림 of a pending submission (essays, short answers without accepted answers). */
export function SelfGradeButtons({
  busy,
  onGrade,
}: {
  readonly busy: boolean;
  readonly onGrade: (grade: GradeResult) => void;
}) {
  return (
    <div className={styles.selfGrade} role="group" aria-label="직접 채점">
      <Button loading={busy} onClick={() => onGrade('correct')}>
        맞음
      </Button>
      <Button disabled={busy} onClick={() => onGrade('incorrect')}>
        틀림
      </Button>
    </div>
  );
}

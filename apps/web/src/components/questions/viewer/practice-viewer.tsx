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
// (lib/questions/practice-cache.ts), so re-opening an unanswered question shows it at once; a
// session whose submission started is never reused.
// UX7-BANK: editors get the screen's 문제 관리 menu (`headerExtra`) in the header; after an edit
// the screen invalidates that question (`invalidated`) and the viewer, if it still shows it,
// opens a session of the new revision (the cached session of the old revision is dropped).
// UX7-BANK-2: the header menu's 정답·해설 보기 opens a separate read-only dialog over the panel; the
// session on screen (and an answer being chosen) stays as it is and nothing is recorded.
import {
  ArrowLeftIcon,
  Button,
  ConfirmDialog,
  IconButton,
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
  latestPracticeAction,
  openPracticeSessionAction,
  resetPracticeAction,
  selfGradePracticeAction,
  submitPracticeAction,
  type PracticeSession,
  type StudyActionResult,
  type SubmitResult,
} from '@/lib/questions/practice-actions';
import { AiExplanation } from '@/components/questions/ai-explanation/ai-explanation';
import { RelatedSources } from '@/components/questions/related-sources/related-sources';
import { PracticeSessionCache } from '@/lib/questions/practice-cache';
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
import { QuestionSourcePreview } from './question-source-preview';
import styles from './question-viewer.module.css';

export interface PracticeQuestion {
  readonly id: string;
  /** `3장 12번 문제`: names the dialog (same title as the dot's label). */
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
  readonly headerExtra?: ReactNode;
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
  /** The open session to reuse if recent metadata confirms it is current. */
  readonly cached: PracticeSession | null;
  readonly forceNew?: boolean;
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
  // The last open question keeps rendering while the panel animates closed.
  const [shown, setShown] = useState(question);
  if (question && question !== shown) setShown(question);

  // One cache per workspace: another workspace starts empty (the old one is dropped).
  const [cache, setCache] = useState(() => new PracticeSessionCache(workspaceId));
  const scoped = cache.workspaceId === workspaceId.toLowerCase();
  if (!scoped) setCache(new PracticeSessionCache(workspaceId));

  const liveWork = useRef<string | null>(null);
  useEffect(
    () =>
      subscribePracticeResets(workspaceId, (id) => {
        const stale = cache.get(id);
        if (stale) cache.dropSession(stale.id);
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
    setOpening({ questionId, key: newKey(), cached: scoped ? cache.get(questionId) : null });
  }
  const [session, setSession] = useState<SessionState & { readonly key: string | null }>({
    status: 'loading',
    key: null,
  });

  useEffect(() => {
    const id = opening.questionId;
    if (!id || readOnly) return;
    let current = true;
    const key = opening.key;
    const resetVersion = practiceResetVersion(workspaceId, id);
    void (async () => {
      const latest = await latestPracticeAction(workspaceId, id);
      if (latest && !latest.ok) {
        if (current) setSession({ status: 'error', message: latest.message, key });
        return;
      }
      if (!current || practiceResetVersion(workspaceId, id) !== resetVersion) return;
      rememberPracticeEpoch(workspaceId, id, latest.data.reset_epoch);
      if (
        opening.cached &&
        !opening.forceNew &&
        cache.get(id)?.id === opening.cached.id &&
        cache.epoch(id) === latest.data.reset_epoch &&
        opening.cached.question_revision_id === latest.data.active_revision_id &&
        cache.baselineAttemptId(id) === latest.data.latest_attempt_id
      ) {
        setSession({
          status: 'ready',
          session: opening.cached,
          previousRevision: latest.data.previous_revision,
          key,
        });
        return;
      }
      if (!opening.forceNew && latest.data.session?.outcome) {
        const saved = latest.data.submitted_answer;
        const answer: PracticeAnswer = {
          selected: Array.isArray(saved?.selected_option_ids)
            ? (saved.selected_option_ids as string[])
            : [],
          text: typeof saved?.answer_text === 'string' ? saved.answer_text : '',
        };
        onGraded?.(id, latest.data.session.outcome.result);
        if (current)
          setSession({
            status: 'ready',
            session: latest.data.session,
            prior: { outcome: latest.data.session.outcome, answer },
            key,
          });
        return;
      }
      if (opening.cached) cache.dropSession(opening.cached.id);
      if (!current || practiceResetVersion(workspaceId, id) !== resetVersion) return;
      const result = await openPracticeSessionAction(workspaceId, id, key, latest.data.reset_epoch);
      if (result.ok && practiceResetVersion(workspaceId, id) === resetVersion) {
        cache.put(result.data, latest.data.reset_epoch, latest.data.latest_attempt_id);
        if (current) onViewed(id);
      }
      if (current)
        setSession(
          result.ok
            ? {
                status: 'ready',
                session: result.data,
                previousRevision: latest?.ok && latest.data.previous_revision,
                key,
              }
            : { status: 'error', message: result.message, key },
        );
    })().catch(() => {
      if (current) setSession({ status: 'error', message: '문제를 불러오지 못했습니다.', key });
    });
    return () => {
      current = false;
    };
    // onViewed is a stable callback of the screen; the opening identifies the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening, readOnly, workspaceId, cache]);

  const view = shown;
  const state: SessionState =
    session.key === opening.key ? session : { status: 'loading' as const };
  const ready = state.status === 'ready' ? state.session : null;

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
  const resultRef = useRef<HTMLParagraphElement>(null);
  const outcomeId = work.outcome?.attempt_id ?? null;
  useEffect(() => {
    // The submit button leaves with the answer form: keep focus in the panel on the result.
    if (outcomeId) resultRef.current?.focus();
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
      {ready && finished ? (
        <Button
          variant="ghost"
          onClick={() => setOpening((o) => ({ ...o, key: newKey(), cached: null, forceNew: true }))}
        >
          한 번 더 풀기
        </Button>
      ) : null}
      {ready ? (
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
      <nav className={styles.nav} aria-label="문제 이동">
        <NavButton target={neighbors.previous} onNavigate={onNavigate}>
          이전 문제
        </NavButton>
        <NavButton target={neighbors.next} onNavigate={onNavigate}>
          다음 문제
        </NavButton>
      </nav>
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
            {headerExtra}
          </>
        ) : view ? (
          // Archived: no study toggles, but the read-only 문제 정보 menu stays (UX7-BANK-2).
          headerExtra
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
          <QuestionSourcePreview target={{ kind: 'question', id: view.id }} />
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
                  question={ready}
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
              <Button onClick={() => setOpening((o) => ({ ...o, key: newKey(), cached: null }))}>
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

/**
 * Previous/next. At either end the button stays focusable (`aria-disabled`) so focus does not
 * drop out of the panel when the last question is reached.
 */
function NavButton({
  target,
  onNavigate,
  children,
}: {
  readonly target: string | null;
  readonly onNavigate: ((questionId: string) => void) | undefined;
  readonly children: string;
}) {
  const unavailable = !target || !onNavigate;
  return (
    <IconButton
      label={children}
      icon={
        <ArrowLeftIcon
          width={20}
          height={20}
          style={children === '다음 문제' ? { transform: 'rotate(180deg)' } : undefined}
        />
      }
      aria-disabled={unavailable || undefined}
      onClick={() => {
        if (target && onNavigate) onNavigate(target);
      }}
    />
  );
}

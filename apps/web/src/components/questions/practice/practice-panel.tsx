'use client';

// QPLAY-01 QuestionPracticePanel (docs/screens/questions-practice.md, questions.md §3.2/§4,
// design-system §5.1): a modal Floating Side Panel opened from a heatmap dot or `?question=`.
// Opening it starts a practice session, which is what records the view (never the hover
// preview). The session carries no answers: the correct options, accepted answers, rubric and
// explanation arrive only with the submit result. Essays and ungradable short answers stay
// pending until the user grades them (맞음/틀림). Previous/next follow the heatmap order and are
// URL changes owned by the screen; Escape/close return focus to the dot (the screen decides).
import {
  Button,
  Checkbox,
  FavoriteToggle,
  FloatingSidePanel,
  RadioGroup,
  RetryToggle,
  Textarea,
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
} from 'react';
import {
  openPracticeSessionAction,
  selfGradePracticeAction,
  submitPracticeAction,
  type PracticeSession,
  type StudyActionResult,
  type SubmitResult,
} from '@/lib/questions/practice-actions';
import { QUESTION_FAILURE_MESSAGES } from '@/lib/questions/problems';
import {
  ANSWER_TEXT_MAX,
  canSubmit,
  EMPTY_ANSWER,
  finalResult,
  optionMark,
  resultMessage,
  submitBody,
  toggleOption,
  type AttemptResult,
  type GradeResult,
  type Neighbors,
  type PracticeAnswer,
} from './practice-model';
import styles from './practice-panel.module.css';

export interface PracticeQuestion {
  readonly id: string;
  /** `3장 12번 문제`: names the dialog (same title as the dot's label). */
  readonly title: string;
  readonly chapterTitle: string;
  readonly questionType: keyof typeof questionTypeLabels;
  /** Overview preview (first lines of the stem), shown until the session arrives. */
  readonly preview: string;
  readonly isFavorite: boolean;
  readonly needsRetry: boolean;
  /** A favorite/retry change is being saved: the toggles show the saved state and wait. */
  readonly savingFlags?: boolean;
}

export interface PracticePanelProps {
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
  readonly onViewed: (questionId: string) => void;
  /** An answer was submitted (`pending`) or graded (auto or self). */
  readonly onGraded?: (questionId: string, result: AttemptResult) => void;
  /** Where focus goes when the panel closes (the opening dot). */
  readonly onCloseAutoFocus?: ComponentProps<typeof FloatingSidePanel>['onCloseAutoFocus'];
}

type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly session: PracticeSession }
  | { readonly status: 'error'; readonly message: string };

interface Opening {
  readonly questionId: string | null;
  /** Idempotency key of this opening: a re-run effect (Strict Mode, retry) reuses it. */
  readonly key: string;
}

/** The answering state of one session. */
interface Work {
  readonly sessionId: string | null;
  readonly answer: PracticeAnswer;
  readonly busy: 'submit' | 'grade' | null;
  readonly outcome: SubmitResult | null;
  readonly selfGrade: GradeResult | null;
  readonly error: string | null;
}

function freshWork(sessionId: string | null): Work {
  return {
    sessionId,
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

export function PracticePanel({
  workspaceId,
  question,
  readOnly,
  screenId,
  neighbors = NO_NEIGHBORS,
  onNavigate,
  onClose,
  onFlagsChange,
  onViewed,
  onGraded,
  onCloseAutoFocus,
}: PracticePanelProps) {
  const questionId = question?.id ?? null;
  // The last open question keeps rendering while the panel animates closed.
  const [shown, setShown] = useState(question);
  if (question && question !== shown) setShown(question);

  const [opening, setOpening] = useState<Opening>(() => ({ questionId, key: newKey() }));
  if (opening.questionId !== questionId) {
    setOpening({ questionId, key: newKey() });
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
    void openPracticeSessionAction(workspaceId, id, key).then(
      (result: StudyActionResult<PracticeSession>) => {
        if (result.ok) onViewed(id);
        if (!current) return;
        setSession(
          result.ok
            ? { status: 'ready', session: result.data, key }
            : { status: 'error', message: result.message, key },
        );
      },
      () => {
        if (current) {
          setSession({ status: 'error', message: '문제를 불러오지 못했습니다.', key });
        }
      },
    );
    return () => {
      current = false;
    };
    // onViewed is a stable callback of the screen; the opening identifies the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening, readOnly, workspaceId]);

  const view = shown;
  const state: SessionState =
    session.key === opening.key ? session : { status: 'loading' as const };
  const ready = state.status === 'ready' ? state.session : null;

  // Answering state belongs to one session: a new session (next question, reopen) starts empty.
  const [workState, setWorkState] = useState<Work>(() => freshWork(null));
  const work = ready && workState.sessionId === ready.id ? workState : freshWork(ready?.id ?? null);
  // The session being answered now: a late result of an earlier session (the user moved on to
  // another question meanwhile) must not land in the new one.
  const liveSession = useRef<string | null>(null);
  useLayoutEffect(() => {
    liveSession.current = ready?.id ?? null;
  }, [ready?.id]);
  /** Applies `patch` only while `sessionId` is still the session being answered. */
  function updateWork(sessionId: string, patch: (w: Work) => Partial<Work>) {
    if (liveSession.current !== sessionId) return;
    setWorkState((prev) => {
      const base = prev.sessionId === sessionId ? prev : freshWork(sessionId);
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
    if (!ready || !view || work.busy || work.outcome || !canSubmit(ready, work.answer)) return;
    const sessionId = ready.id;
    const qid = view.id;
    updateWork(sessionId, () => ({ busy: 'submit', error: null }));
    let result: StudyActionResult<SubmitResult>;
    try {
      result = await submitPracticeAction(workspaceId, sessionId, submitBody(ready, work.answer));
    } catch {
      result = { ok: false, kind: 'unavailable', message: QUESTION_FAILURE_MESSAGES.unavailable };
    }
    if (result.ok) onGraded?.(qid, result.data.result);
    updateWork(sessionId, () =>
      result.ok ? { busy: null, outcome: result.data } : { busy: null, error: result.message },
    );
  }

  async function selfGrade(grade: GradeResult) {
    if (!ready || !view || work.busy || work.outcome?.result !== 'pending' || work.selfGrade) {
      return;
    }
    const sessionId = ready.id;
    const qid = view.id;
    updateWork(sessionId, () => ({ busy: 'grade', error: null }));
    let ok = false;
    let message: string = QUESTION_FAILURE_MESSAGES.unavailable;
    try {
      const result = await selfGradePracticeAction(workspaceId, sessionId, grade);
      ok = result.ok;
      if (!result.ok) message = result.message;
    } catch {
      // network failure: keep the pending result and let the user try again
    }
    if (ok) onGraded?.(qid, grade);
    updateWork(sessionId, () =>
      ok ? { busy: null, selfGrade: grade } : { busy: null, error: message },
    );
  }

  const locked = work.busy !== null || work.outcome !== null;
  const outcome = work.outcome;
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
        <div className={styles.selfGrade} role="group" aria-label="직접 채점">
          <Button loading={work.busy === 'grade'} onClick={() => void selfGrade('correct')}>
            맞음
          </Button>
          <Button disabled={work.busy === 'grade'} onClick={() => void selfGrade('incorrect')}>
            틀림
          </Button>
        </div>
      ) : null}
      {ready && finished ? (
        <Button variant="ghost" onClick={() => setOpening((o) => ({ ...o, key: newKey() }))}>
          한 번 더 풀기
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
            <FavoriteToggle
              pressed={view.isFavorite}
              aria-disabled={view.savingFlags || undefined}
              onPressedChange={(pressed) => {
                if (!view.savingFlags) onFlagsChange(view.id, { is_favorite: pressed });
              }}
            />
            <RetryToggle
              pressed={view.needsRetry}
              aria-disabled={view.savingFlags || undefined}
              onPressedChange={(pressed) => {
                if (!view.savingFlags) onFlagsChange(view.id, { needs_retry: pressed });
              }}
            />
          </>
        ) : undefined
      }
    >
      {view ? (
        <div className={styles.body} data-screen-id={screenId}>
          {readOnly ? (
            <>
              <p className={styles.notice}>
                보관된 Workspace는 읽기 전용입니다. 문제를 풀거나 학습 상태를 바꿀 수 없습니다.
              </p>
              <p className={styles.stem}>{view.preview}</p>
            </>
          ) : ready ? (
            <form
              id={formId}
              className={styles.form}
              onSubmit={(e) => void submit(e)}
              aria-busy={work.busy !== null || undefined}
              noValidate
            >
              <p className={styles.stem}>{ready.stem}</p>
              <AnswerField
                session={ready}
                answer={work.answer}
                disabled={locked}
                correct={outcome?.correct_option_ids ?? null}
                revealed={outcome !== null}
                onChange={(answer) => updateWork(ready.id, () => ({ answer }))}
              />
              <p
                ref={resultRef}
                role="status"
                tabIndex={-1}
                className={styles.result}
                data-result={outcome ? finalResult(outcome.result, work.selfGrade) : undefined}
              >
                {outcome ? resultMessage(outcome.result, work.selfGrade) : ''}
              </p>
              {work.error ? (
                <p role="alert" className={styles.error}>
                  {work.error}
                </p>
              ) : null}
              {outcome ? <Reveal outcome={outcome} /> : null}
            </form>
          ) : state.status === 'error' ? (
            <div role="alert" className={styles.error}>
              <p>{state.message}</p>
              <Button onClick={() => setOpening((o) => ({ ...o, key: newKey() }))}>
                다시 시도
              </Button>
            </div>
          ) : (
            <div aria-busy="true">
              <p className={styles.stem}>{view.preview}</p>
              <p className={styles.loading}>문제를 불러오는 중입니다…</p>
            </div>
          )}
        </div>
      ) : null}
    </FloatingSidePanel>
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
    <Button
      size="sm"
      aria-disabled={unavailable || undefined}
      onClick={() => {
        if (target && onNavigate) onNavigate(target);
      }}
    >
      {children}
    </Button>
  );
}

function AnswerField({
  session,
  answer,
  disabled,
  correct,
  revealed,
  onChange,
}: {
  readonly session: PracticeSession;
  readonly answer: PracticeAnswer;
  readonly disabled: boolean;
  readonly correct: readonly string[] | null;
  readonly revealed: boolean;
  readonly onChange: (answer: PracticeAnswer) => void;
}) {
  if (session.question_type !== 'MCQ') {
    return (
      <Textarea
        label="답안"
        value={answer.text}
        rows={session.question_type === 'ESSAY' ? 8 : 3}
        maxLength={ANSWER_TEXT_MAX}
        disabled={disabled}
        onChange={(e) => onChange({ ...answer, text: e.target.value })}
      />
    );
  }
  const mark = (id: string) => (revealed ? optionMark(id, correct, answer.selected) : undefined);
  if (!session.is_multi_answer) {
    return (
      <RadioGroup
        label="보기"
        orientation="vertical"
        disabled={disabled}
        value={answer.selected[0] ?? ''}
        onValueChange={(id) =>
          onChange({ ...answer, selected: toggleOption(session, answer.selected, id, true) })
        }
        options={session.options.map((o, index) => {
          const description = mark(o.id);
          return {
            value: o.id,
            label: <OptionLabel index={index} text={o.text} />,
            ...(description ? { description } : {}),
          };
        })}
      />
    );
  }
  return (
    <fieldset className={styles.choices}>
      <legend className={styles.legend}>보기 (정답을 모두 고르세요)</legend>
      {session.options.map((o, index) => (
        <Checkbox
          key={o.id}
          label={<OptionLabel index={index} text={o.text} />}
          description={mark(o.id)}
          disabled={disabled}
          checked={answer.selected.includes(o.id)}
          onCheckedChange={(checked) =>
            onChange({
              ...answer,
              selected: toggleOption(session, answer.selected, o.id, checked === true),
            })
          }
        />
      ))}
    </fieldset>
  );
}

/**
 * An option's display number (`1.`, by displayed position, so a shuffled session numbers its own
 * order) and text. The number is decorative: grading uses the option ID, and the radio/checkbox
 * keeps the option text as its name while its position is announced by the group.
 */
function OptionLabel({ index, text }: { readonly index: number; readonly text: string }) {
  return (
    <>
      <span className={styles.optionNumber} aria-hidden="true">
        {index + 1}.
      </span>{' '}
      {text}
    </>
  );
}

/** Answers revealed by the submit result (never before submission). */
function Reveal({ outcome }: { readonly outcome: SubmitResult }) {
  const accepted = outcome.accepted_answers ?? [];
  return (
    <div className={styles.reveal}>
      {accepted.length > 0 ? (
        <section aria-label="허용 답안">
          <h3 className={styles.revealTitle}>허용 답안</h3>
          <p className={styles.revealText}>{accepted.join(', ')}</p>
        </section>
      ) : null}
      {outcome.rubric ? (
        <section aria-label="채점 기준">
          <h3 className={styles.revealTitle}>채점 기준</h3>
          <p className={styles.revealText}>{outcome.rubric}</p>
        </section>
      ) : null}
      {outcome.explanation ? (
        <section aria-label="해설">
          <h3 className={styles.revealTitle}>해설</h3>
          <p className={styles.revealText}>{outcome.explanation}</p>
        </section>
      ) : null}
    </div>
  );
}

// Pure QPLAY-01 / QVIEW-01 practice model: what an answer submits, when it can be submitted, the
// result wording and previous/next. Unit-tested without a browser; the server grades
// (questions.md §4). Shared by every QuestionViewer mode that takes an answer.
import type { PracticeSession, SubmitResult } from '@/lib/questions/practice-actions';

/** The parts of an answer-free question (a practice session, a run position) answers depend on. */
type AnswerShape = Pick<PracticeSession, 'question_type' | 'is_multi_answer'> & {
  readonly displayed_option_ids: readonly string[];
};

export type GradeResult = 'correct' | 'incorrect';
export type AttemptResult = SubmitResult['result'];

export interface PracticeAnswer {
  /** Selected MCQ option ids (stable ids, never positions), in displayed order. */
  readonly selected: readonly string[];
  /** Short-answer / essay text. */
  readonly text: string;
}

export const EMPTY_ANSWER: PracticeAnswer = { selected: [], text: '' };

export type SubmitBody =
  { readonly selected_option_ids: string[] } | { readonly answer_text: string };

/** Mirrors the API's `answer_text` limit. */
export const ANSWER_TEXT_MAX = 20_000;

/** The selection after (un)checking `optionId`: single answer replaces, multi answer toggles. */
export function toggleOption(
  session: Pick<AnswerShape, 'is_multi_answer' | 'displayed_option_ids'>,
  selected: readonly string[],
  optionId: string,
  checked: boolean,
): string[] {
  if (!session.displayed_option_ids.includes(optionId)) return [...selected];
  if (!session.is_multi_answer) return checked ? [optionId] : [];
  const next = new Set(selected);
  if (checked) next.add(optionId);
  else next.delete(optionId);
  return session.displayed_option_ids.filter((id) => next.has(id));
}

/** Whether `answer` is a complete answer for `session` (one option, ≥ 1 for multi, or text). */
export function canSubmit(session: AnswerShape, answer: PracticeAnswer): boolean {
  if (session.question_type === 'MCQ') {
    const known = answer.selected.filter((id) => session.displayed_option_ids.includes(id));
    return session.is_multi_answer ? known.length > 0 : known.length === 1;
  }
  const text = answer.text.trim();
  return text.length > 0 && answer.text.length <= ANSWER_TEXT_MAX;
}

/** The submit body: option ids of this session only (MCQ), otherwise the answer text. */
export function submitBody(
  session: Pick<AnswerShape, 'question_type' | 'displayed_option_ids'>,
  answer: PracticeAnswer,
): SubmitBody {
  if (session.question_type === 'MCQ') {
    const chosen = new Set(answer.selected);
    return { selected_option_ids: session.displayed_option_ids.filter((id) => chosen.has(id)) };
  }
  return { answer_text: answer.text };
}

/** The result a submission ends with: the user's self-grade settles a pending one. */
export function finalResult(
  submitted: AttemptResult,
  selfGrade: GradeResult | null,
): AttemptResult {
  return submitted === 'pending' && selfGrade ? selfGrade : submitted;
}

/** Text of the result live region (never color alone). A pending result is not a grade. */
export function resultMessage(submitted: AttemptResult, selfGrade: GradeResult | null): string {
  if (submitted === 'pending') {
    if (selfGrade === 'correct') return '정답으로 채점했습니다.';
    if (selfGrade === 'incorrect') return '오답으로 채점했습니다.';
    return '채점 대기 중입니다. 채점 기준과 비교해 직접 채점해 주세요.';
  }
  return submitted === 'correct' ? '정답입니다.' : '오답입니다.';
}

/**
 * An MCQ grade shows on the option rows (UX12-OPTIONS), so its sentence stays for assistive tech
 * only. Pending and non-MCQ wording is the only visible result, so it stays on screen.
 */
export function resultIsVisuallyHidden(
  questionType: AnswerShape['question_type'],
  submitted: AttemptResult,
): boolean {
  return questionType === 'MCQ' && submitted !== 'pending';
}

/** Description of an MCQ option once the answers are revealed (visually hidden, UX12-OPTIONS). */
export function optionMark(
  optionId: string,
  correct: readonly string[] | null,
  selected: readonly string[],
): string | undefined {
  if (correct?.includes(optionId)) return selected.includes(optionId) ? '정답 · 내 선택' : '정답';
  return selected.includes(optionId) ? '내 선택' : undefined;
}

/**
 * Border tone of an MCQ option row once graded (UX7-QDISPLAY, QPLAY-01-AC12): a correct answer
 * marks the chosen options `correct` (green); a wrong one marks the chosen wrong options `chosen`
 * (no border) and every correct option `answer` (red), a chosen correct one too. The hidden
 * description (`optionMark`) carries the meaning; the border only reinforces it.
 */
export type OptionTone = 'correct' | 'chosen' | 'answer';

export function optionTone(
  optionId: string,
  correct: readonly string[] | null,
  selected: readonly string[],
  result: AttemptResult,
): OptionTone | undefined {
  if (!correct || result === 'pending') return undefined;
  const chosen = selected.includes(optionId);
  if (result === 'correct') return chosen ? 'correct' : undefined;
  if (correct.includes(optionId)) return 'answer';
  return chosen ? 'chosen' : undefined;
}

export interface Neighbors {
  readonly previous: string | null;
  readonly next: string | null;
}

/** Previous/next question of `id` in heatmap `order`; none when `id` is not listed. */
export function neighbors(order: readonly string[], id: string | null): Neighbors {
  const at = id ? order.indexOf(id) : -1;
  if (at < 0) return { previous: null, next: null };
  return { previous: order[at - 1] ?? null, next: order[at + 1] ?? null };
}

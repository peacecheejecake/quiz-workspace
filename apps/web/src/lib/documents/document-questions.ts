// DOC-02-AC11 (DOCVIEW): confirmed questions imported from this PDF, shown in question format in
// the text pane instead of their raw source blocks. Only sources marked `imported` (the question's
// printed place in a question PDF) count — a generated question's cited passages or a manual
// question's page reference never turn book text into a question card. The answer fields are what
// the caller already may read (the bank for members, published questions for share viewers); the
// screen keeps them folded until asked for.
import type { Schemas } from '@quiz/api-client';

type Revision = Schemas['QuestionRevision'];

/** What the bank (`Question`) and the shared view (`SharedQuestion`) both carry. */
export interface QuestionLike {
  readonly id: string;
  readonly question_number: number | null;
  readonly question_type: 'MCQ' | 'SHORT_ANSWER' | 'ESSAY';
  readonly revision: Revision;
  readonly sources: readonly {
    readonly document_id: string | null;
    readonly block_ids?: readonly string[];
    readonly imported?: boolean;
  }[];
}

export interface DocumentQuestion {
  readonly id: string;
  readonly number: number | null;
  readonly type: QuestionLike['question_type'];
  readonly stem: string;
  readonly options: Revision['options'];
  readonly correctOptionIds: readonly string[] | null;
  readonly acceptedAnswers: readonly string[] | null;
  readonly explanation: string | null;
  readonly rubric: string | null;
  /** Source blocks of the question in this document (stem and options). */
  readonly blockIds: readonly string[];
}

/** Questions printed in `documentId` (imported sources with blocks), in the given order. */
export function documentQuestions(
  items: readonly QuestionLike[],
  documentId: string,
): DocumentQuestion[] {
  const out: DocumentQuestion[] = [];
  for (const q of items) {
    const blockIds = q.sources
      .filter((s) => s.document_id === documentId && s.imported === true)
      .flatMap((s) => s.block_ids ?? []);
    if (blockIds.length === 0) continue;
    out.push({
      id: q.id,
      number: q.question_number,
      type: q.question_type,
      stem: q.revision.stem,
      options: q.revision.options,
      correctOptionIds: q.revision.correct_option_ids,
      acceptedAnswers: q.revision.accepted_answers,
      explanation: q.revision.explanation,
      rubric: q.revision.rubric,
      blockIds: [...new Set(blockIds)],
    });
  }
  return out;
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

/** Display label of the option at `index` (0-based): ①, ②, … then (21), (22), … */
export function optionLabel(index: number): string {
  return CIRCLED[index] ?? `(${index + 1})`;
}

export const QUESTION_TYPE_LABELS: Readonly<Record<DocumentQuestion['type'], string>> = {
  MCQ: '객관식',
  SHORT_ANSWER: '단답형',
  ESSAY: '서술형',
};

/** The folded answer section: `정답: ② 증발`, accepted answers, a model answer, the explanation. */
export function answerLines(q: DocumentQuestion): string[] {
  const lines: string[] = [];
  if (q.correctOptionIds && q.correctOptionIds.length > 0) {
    const picked = q.options
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => q.correctOptionIds?.includes(option.id))
      .map(({ option, index }) => `${optionLabel(index)} ${option.text}`);
    if (picked.length > 0) lines.push(`정답: ${picked.join(', ')}`);
  }
  if (q.acceptedAnswers && q.acceptedAnswers.length > 0) {
    lines.push(`정답: ${q.acceptedAnswers.join(' / ')}`);
  }
  if (q.rubric) lines.push(`모범 답안: ${q.rubric}`);
  if (lines.length === 0) lines.push('등록된 정답이 없습니다.');
  if (q.explanation) lines.push(`해설: ${q.explanation}`);
  return lines;
}

// UX7-DEDUP 중복 문제 정리 (docs/questions.md §10, QOV-01-AC16/AC17, QIMPORT-01-AC10): the
// review choices of the duplicate dialog and the import review's duplicate reason. Pure, so they
// are unit-tested; FastAPI decides what is a duplicate and re-checks every merge.
import type { Schemas } from '@quiz/api-client';

export type DuplicateScan = Schemas['DuplicateScan'];
export type DuplicateGroup = Schemas['DuplicateGroup'];
export type DuplicateQuestion = Schemas['DuplicateQuestion'];
export type MergeGroup = Schemas['MergeGroup'];
export type MergeResult = Schemas['MergeResult'];
export type DraftDuplicate = Schemas['DraftDuplicate'];

/** Per group (by fingerprint): the question to keep and whether the group is merged. */
export interface GroupChoice {
  readonly keep: string;
  readonly include: boolean;
}
export type Choices = ReadonlyMap<string, GroupChoice>;

/** The default review: every group merged, keeping the server's suggestion (the oldest). */
export function initialChoices(groups: readonly DuplicateGroup[]): Map<string, GroupChoice> {
  return new Map(
    groups.map((g) => [g.fingerprint, { keep: g.suggested_keep_question_id, include: true }]),
  );
}

function choiceOf(group: DuplicateGroup, choices: Choices): GroupChoice {
  const choice = choices.get(group.fingerprint);
  const keep =
    choice && group.questions.some((q) => q.question_id === choice.keep)
      ? choice.keep
      : group.suggested_keep_question_id;
  return { keep, include: choice?.include ?? true };
}

/** The merge request of the included groups: each keep with the group's other questions. */
export function mergeRequest(groups: readonly DuplicateGroup[], choices: Choices): MergeGroup[] {
  return groups.flatMap((group) => {
    const { keep, include } = choiceOf(group, choices);
    if (!include) return [];
    return [
      {
        keep_question_id: keep,
        duplicate_question_ids: group.questions
          .map((q) => q.question_id)
          .filter((id) => id !== keep),
      },
    ];
  });
}

/** How many questions the merge archives. */
export function archivedCount(groups: readonly DuplicateGroup[], choices: Choices): number {
  return mergeRequest(groups, choices).reduce((n, g) => n + g.duplicate_question_ids.length, 0);
}

/** "3번 문제" for a numbered question, else "번호 없는 문제". */
export function duplicateQuestionName(question: Pick<DuplicateQuestion, 'question_number'>) {
  return question.question_number !== null
    ? `${question.question_number}번 문제`
    : '번호 없는 문제';
}

/** The import review's text for a duplicate draft (QIMPORT-01-AC10), or null. */
export function duplicateReason(duplicate: DraftDuplicate | null | undefined): string | null {
  if (!duplicate) return null;
  if (duplicate.kind === 'question') {
    return duplicate.number !== null
      ? `이미 등록된 ${duplicate.number}번 문제와 같습니다`
      : '이미 등록된 문제와 같습니다';
  }
  return duplicate.number !== null
    ? `이 PDF의 ${duplicate.number}번 초안과 같습니다`
    : '이 PDF의 앞선 초안과 같습니다';
}

/** The merge API's limits per request (and mergeDuplicatesAction's). */
export const MERGE_LIMITS = { groups: 100, duplicates: 50 } as const;

/**
 * The merge split into requests within MERGE_LIMITS (Codex P2): a group with more than 50
 * duplicates goes in chunks, each with the group's keep, and chunk r of every group is sent in
 * round r — so a request never names a keep twice (the API refuses an id named twice) — split
 * into requests of at most 100 groups. Every request is idempotent on the server (a duplicate
 * already merged into the same keep is left as it is), so a failed one can be sent again.
 */
export function mergeBatches(request: readonly MergeGroup[]): MergeGroup[][] {
  const chunked = request.map((g) => {
    const chunks: MergeGroup[] = [];
    for (let i = 0; i < g.duplicate_question_ids.length; i += MERGE_LIMITS.duplicates) {
      chunks.push({
        keep_question_id: g.keep_question_id,
        duplicate_question_ids: g.duplicate_question_ids.slice(i, i + MERGE_LIMITS.duplicates),
      });
    }
    return chunks;
  });
  const rounds = Math.max(0, ...chunked.map((c) => c.length));
  const batches: MergeGroup[][] = [];
  for (let r = 0; r < rounds; r++) {
    const round = chunked.flatMap((c) => {
      const chunk = c[r];
      return chunk ? [chunk] : [];
    });
    for (let i = 0; i < round.length; i += MERGE_LIMITS.groups) {
      batches.push(round.slice(i, i + MERGE_LIMITS.groups));
    }
  }
  return batches;
}

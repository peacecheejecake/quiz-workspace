// Cross-language parity: the TS status rules and apps/api `quiz_api.question_status` are both
// checked against contracts/question-status.truth.json (docs/questions.md §2.1, §7).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deriveDotStatus,
  summarizeStatuses,
  type LastGradedResult,
  type QuestionDotStatus,
} from '../src';

interface TruthTable {
  derive: {
    state: {
      first_viewed_at: string | null;
      last_graded_result: LastGradedResult;
      needs_retry: boolean;
      is_favorite: boolean;
    };
    status: QuestionDotStatus;
  }[];
  summarize: {
    name: string;
    items: { status: QuestionDotStatus; is_favorite: boolean }[];
    counts: Record<string, number>;
  }[];
}

const table = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../contracts/question-status.truth.json'),
    'utf8',
  ),
) as TruthTable;

describe('question status truth table (shared with apps/api)', () => {
  it('covers every input combination', () => {
    expect(table.derive).toHaveLength(24);
  });

  it.each(table.derive)('derive %j', ({ state, status }) => {
    expect(
      deriveDotStatus({
        firstViewedAt: state.first_viewed_at,
        lastGradedResult: state.last_graded_result,
        needsRetry: state.needs_retry,
        isFavorite: state.is_favorite,
      }),
    ).toBe(status);
  });

  it.each(table.summarize)('summarize: $name', ({ items, counts }) => {
    expect(
      summarizeStatuses(items.map((i) => ({ status: i.status, isFavorite: i.is_favorite }))),
    ).toEqual(counts);
  });
});

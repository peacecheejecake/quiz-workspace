import { describe, expect, it } from 'vitest';
import { QUESTION_DOT_STATUSES } from '@quiz/ui';
import {
  EMPTY_OVERVIEW_FILTERS,
  overviewApiQuery,
  overviewSearch,
  parseOverviewFilters,
} from '../src/lib/questions/overview-filters';

describe('UX10-HOME status filters', () => {
  it('UX10-HOME-AC03 distinguishes omitted, none and partial status selections', () => {
    expect(parseOverviewFilters({}).status).toEqual(QUESTION_DOT_STATUSES);
    expect(parseOverviewFilters({ status: 'unknown' }).status).toEqual(QUESTION_DOT_STATUSES);
    const none = parseOverviewFilters({ status: 'none' });
    expect(none.status).toEqual([]);
    expect(overviewSearch(none)).toBe('?status=none');
    expect(overviewApiQuery(none)).toEqual({ status: ['none'] });
    expect(parseOverviewFilters({ status: ['correct', 'unseen', 'correct'] }).status).toEqual([
      'unseen',
      'correct',
    ]);
    expect(overviewSearch(EMPTY_OVERVIEW_FILTERS)).toBe('');
  });
});

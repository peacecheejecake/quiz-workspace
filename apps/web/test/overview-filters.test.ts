// QOV-01 URL state: the heatmap filters use the overview API's parameter names, so the URL and the
// API query mirror each other; `?question=` (the open panel) is kept apart from the filters.
import { describe, expect, it } from 'vitest';
import {
  EMPTY_OVERVIEW_FILTERS,
  isOverviewFiltered,
  openQuestionId,
  overviewApiQuery,
  overviewSearch,
  parseOverviewFilters,
} from '../src/lib/questions/overview-filters';

const CHAPTER = '6f1c2a3b-1111-4222-8333-444455556666';
const QUESTION = 'A0B1C2D3-1111-4222-8333-444455556666';

describe('parseOverviewFilters', () => {
  it('reads every filter with the API parameter names', () => {
    const params = new URLSearchParams(
      `chapter=${CHAPTER}&type=ESSAY&q=%20attention%20&status=retry&status=unseen&favorite=true&retry=false`,
    );
    expect(parseOverviewFilters(params)).toEqual({
      chapter: CHAPTER,
      type: 'ESSAY',
      q: 'attention',
      // Legend order, whatever the URL order.
      status: ['unseen', 'retry'],
      favorite: true,
      retry: false,
    });
  });

  it('accepts the "no chapter" group and record-style search params', () => {
    expect(parseOverviewFilters({ chapter: 'none', status: ['viewed', 'viewed'] })).toMatchObject({
      chapter: 'none',
      status: ['viewed'],
    });
  });

  it('drops malformed values instead of sending them to the API', () => {
    const parsed = parseOverviewFilters({
      chapter: 'not-a-uuid',
      type: 'TRUE_FALSE',
      status: ['seen', 'correct'],
      favorite: 'yes',
      retry: '1',
      q: 'x'.repeat(300),
    });
    expect(parsed).toEqual({
      chapter: null,
      type: null,
      q: 'x'.repeat(200),
      status: ['correct'],
      favorite: null,
      retry: null,
    });
  });

  it('defaults to no filter at all (every confirmed question)', () => {
    expect(parseOverviewFilters({})).toEqual(EMPTY_OVERVIEW_FILTERS);
    expect(isOverviewFiltered(EMPTY_OVERVIEW_FILTERS)).toBe(false);
  });
});

describe('overviewSearch', () => {
  it('round-trips through the URL', () => {
    const filters = parseOverviewFilters(
      new URLSearchParams('status=incorrect&status=retry&favorite=true&chapter=none&q=비용'),
    );
    const search = overviewSearch(filters);
    expect(parseOverviewFilters(new URLSearchParams(search.slice(1)))).toEqual(filters);
    expect(search).toBe(
      '?chapter=none&q=%EB%B9%84%EC%9A%A9&status=incorrect&status=retry&favorite=true',
    );
  });

  it('omits defaults and appends the open question', () => {
    expect(overviewSearch(EMPTY_OVERVIEW_FILTERS)).toBe('');
    expect(overviewSearch(EMPTY_OVERVIEW_FILTERS, 'q-1')).toBe('?question=q-1');
    expect(overviewSearch({ ...EMPTY_OVERVIEW_FILTERS, retry: true }, 'q-1')).toBe(
      '?retry=true&question=q-1',
    );
  });

  it('never treats ?question= as a filter', () => {
    const params = new URLSearchParams(`question=${QUESTION}`);
    expect(isOverviewFiltered(parseOverviewFilters(params))).toBe(false);
  });
});

describe('openQuestionId', () => {
  it('returns the open question only for a UUID', () => {
    expect(openQuestionId(new URLSearchParams(`question=${QUESTION}`))).toBe(
      QUESTION.toLowerCase(),
    );
    expect(openQuestionId(new URLSearchParams('question=q12'))).toBeNull();
    expect(openQuestionId({})).toBeNull();
  });
});

describe('overviewApiQuery', () => {
  it('maps filters to the overview query (repeatable status, booleans)', () => {
    expect(
      overviewApiQuery({
        chapter: 'none',
        type: 'MCQ',
        q: 'softmax',
        status: ['viewed', 'correct'],
        favorite: true,
        retry: false,
      }),
    ).toEqual({
      chapter: 'none',
      type: 'MCQ',
      q: 'softmax',
      status: ['viewed', 'correct'],
      favorite: true,
      retry: false,
    });
    expect(overviewApiQuery(EMPTY_OVERVIEW_FILTERS)).toEqual({});
  });
});

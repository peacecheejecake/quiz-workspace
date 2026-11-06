import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionOverview } from '../src/lib/questions/overview-data';
import { EMPTY_OVERVIEW_FILTERS } from '../src/lib/questions/overview-filters';
import { seedOverviewCache } from '../src/lib/questions/overview-cache';

const api = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock('../src/lib/api/server', () => ({
  createServerApiClient: async () => api,
  NotAuthenticatedError: class extends Error {},
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
}));
const { loadOverview } = await import('../src/lib/questions/overview-data');
const snapshot = (total: number): QuestionOverview => ({
  counts: { total, unseen: total, viewed: 0, incorrect: 0, correct: 0, retry: 0, favorite: 0 },
  items: [],
  chapters: [],
});

beforeEach(() => {
  api.GET.mockReset();
});
describe('SSR keyword-clear cache seed', () => {
  it('loads a queryless snapshot with every other filter retained on direct entry', async () => {
    const filters = {
      ...EMPTY_OVERVIEW_FILTERS,
      chapter: 'none',
      type: 'MCQ' as const,
      favorite: true,
      q: 'chlorine',
    };
    api.GET.mockImplementation(async (_path, init) => {
      const query = init.params.query;
      return { data: snapshot(query.q ? 1 : query.type ? 2 : 3) };
    });
    const data = await loadOverview('workspace', filters);
    expect(api.GET.mock.calls.map(([, init]) => init.params.query)).toEqual([
      { chapter: 'none', type: ['MCQ'], favorite: true, q: 'chlorine' },
      {},
      { chapter: 'none', type: ['MCQ'], favorite: true },
    ]);
    const cache = seedOverviewCache(
      'workspace',
      'viewer',
      filters,
      data.overview,
      data.failure,
      data.unfilteredOverview ?? null,
      data.querylessOverview ?? null,
    );
    expect(cache.get({ ...filters, q: '' })?.counts.total).toBe(2);
    expect(cache.get(EMPTY_OVERVIEW_FILTERS)?.counts.total).toBe(3);
  });

  it('reuses the full snapshot when q is the only filter', async () => {
    api.GET.mockResolvedValue({ data: snapshot(3) });
    const data = await loadOverview('workspace', { ...EMPTY_OVERVIEW_FILTERS, q: 'chlorine' });
    expect(api.GET).toHaveBeenCalledTimes(2);
    expect(data.querylessOverview).toBe(data.unfilteredOverview);
  });
});

// HISTORY-01 display model and browser client: labels, the "나" actor, revision labels, job cause
// and retryability text, page merging, and that the retry/list calls go to the BFF relays.
import { describe, expect, it, vi } from 'vitest';
import { createHistoryClient, historyListPath, retryPath } from '../src/lib/history/client';
import { HISTORY_QUERY } from '../src/lib/history/bff';
import {
  actorLabel,
  appendPage,
  attemptResultLabel,
  eventLabel,
  formatHistoryTime,
  jobCauseLabel,
  questionLabel,
  retryabilityLabel,
  revisionLabel,
  targetLabel,
  type WorkspaceJob,
} from '../src/lib/history/model';

const WS = '3f2b6f0e-8a4c-4d7e-9a51-1c2d3e4f5a6b';
const ME = '0b6a5c0e-1d2f-4a3b-8c4d-5e6f7a8b9c0d';
const DOC = '1c7b6d1f-2e3a-4b4c-9d5e-6f7a8b9c0d1e';

function job(overrides: Partial<WorkspaceJob> = {}): WorkspaceJob {
  return {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    job_type: 'document.parse',
    status: 'failed',
    progress: null,
    stage: null,
    error_code: 'indexing_failed',
    attempts: 1,
    max_attempts: 3,
    cancel_requested: false,
    created_at: '2026-10-18T00:00:00Z',
    updated_at: '2026-10-18T00:00:00Z',
    started_at: null,
    finished_at: '2026-10-18T00:01:00Z',
    target_type: 'document',
    target_id: DOC,
    target_label: 'book-ko',
    retryable: true,
    ...overrides,
  };
}

describe('history labels', () => {
  it('names the viewer "나" and others by display name', () => {
    expect(actorLabel({ id: ME, display_name: 'Kim' }, ME)).toBe('나');
    expect(actorLabel({ id: DOC, display_name: 'Kim' }, ME)).toBe('Kim');
    expect(actorLabel({ id: DOC, display_name: null }, ME)).toBe('이름 없는 사용자');
    expect(actorLabel(null, ME)).toBe('알 수 없는 사용자');
  });

  it('labels document revisions and question versions', () => {
    expect(revisionLabel({ target_type: 'document', revision: { id: DOC, number: 3 } })).toBe(
      '개정 3',
    );
    expect(revisionLabel({ target_type: 'question', revision: { id: null, number: 2 } })).toBe(
      '버전 2',
    );
    expect(revisionLabel({ target_type: 'question', revision: null })).toBeNull();
  });

  it('labels events and targets with Korean fallbacks', () => {
    expect(eventLabel('document.block_corrected')).toBe('문서 교정');
    expect(eventLabel('question.updated')).toBe('문제 수정');
    expect(eventLabel('custom.event')).toBe('custom.event');
    expect(targetLabel('question', '1번 문제')).toBe('1번 문제');
    expect(targetLabel('question', null)).toBe('번호 없는 문제');
    expect(targetLabel(null, null)).toBe('대상 없음');
    expect(questionLabel(4)).toBe('4번 문제');
  });

  it('states a failed job’s cause and whether it can be retried as text', () => {
    expect(jobCauseLabel(job())).toBe('색인 실패');
    expect(retryabilityLabel(job())).toBe('재시도 가능');
    expect(retryabilityLabel(job({ retryable: false }))).toBe('재시도 불가');
    expect(jobCauseLabel(job({ error_code: 'weird_code' }))).toBe('작업 실패 (weird_code)');
    expect(jobCauseLabel(job({ status: 'succeeded', error_code: null }))).toBeNull();
    expect(retryabilityLabel(job({ status: 'running' }))).toBeNull();
  });

  it('labels attempt results', () => {
    expect(attemptResultLabel('correct')).toBe('정답');
    expect(attemptResultLabel('incorrect')).toBe('오답');
    expect(attemptResultLabel('pending')).toBe('채점 대기');
  });

  it('formats times in Asia/Seoul whatever the runtime zone', () => {
    expect(formatHistoryTime('2026-10-17T15:30:00Z')).toContain('2026');
    expect(formatHistoryTime('2026-10-17T15:30:00Z')).toMatch(/10.*18/);
    expect(formatHistoryTime('not a date')).toBe('not a date');
  });

  it('appends pages without duplicating ids', () => {
    const merged = appendPage(
      { items: [{ id: 'a' }, { id: 'b' }], nextCursor: 'c1' },
      { items: [{ id: 'b' }, { id: 'c' }], nextCursor: null },
    );
    expect(merged).toEqual({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], nextCursor: null });
  });
});

describe('history client', () => {
  it('lists through the BFF with the page size and cursor only', async () => {
    expect(historyListPath(WS, 'attempts', 'abc_-1')).toBe(
      `/api/workspaces/${WS}/attempts?limit=50&cursor=abc_-1`,
    );
    const fetchImpl = vi.fn(async () =>
      Response.json({ items: [{ id: 'x' }], next_cursor: 'n1' }),
    ) as unknown as typeof fetch;
    const page = await createHistoryClient(fetchImpl).list(WS, 'jobs');
    expect(page).toEqual({ items: [{ id: 'x' }], nextCursor: 'n1' });
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/workspaces/${WS}/jobs?limit=50`,
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    );
  });

  it('retries a document job by publishing its draft, an import by its retry endpoint', async () => {
    expect(retryPath(job())).toBe(`/api/documents/${DOC}/publish`);
    expect(retryPath(job({ target_type: 'question_import' }))).toBe(
      `/api/question-imports/${DOC}/retry`,
    );
    expect(retryPath(job({ target_type: 'question_generation' }))).toBeNull();
    expect(retryPath(job({ target_id: null }))).toBeNull();

    const fetchImpl = vi.fn(async () =>
      Response.json({ job_id: 'j2' }, { status: 202 }),
    ) as unknown as typeof fetch;
    await createHistoryClient(fetchImpl).retry(job(), 'key-12345678');
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/documents/${DOC}/publish`,
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        headers: expect.objectContaining({ 'idempotency-key': 'key-12345678' }),
      }),
    );
  });

  it('surfaces a refused retry as an error', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ status: 409 }, { status: 409 }),
    ) as unknown as typeof fetch;
    await expect(createHistoryClient(fetchImpl).retry(job(), 'key-12345678')).rejects.toThrow(
      /409/,
    );
  });

  it('forwards only a page size and a URL-safe cursor to FastAPI', () => {
    expect(Object.keys(HISTORY_QUERY).sort()).toEqual(['cursor', 'limit']);
    expect(HISTORY_QUERY.cursor?.test('WyIyMDI2Il0')).toBe(true);
    expect(HISTORY_QUERY.cursor?.test('a b')).toBe(false);
    expect(HISTORY_QUERY.limit?.test('1000')).toBe(false);
  });
});

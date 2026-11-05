import { expect, it, vi } from 'vitest';
import { createMockPracticeApi } from '../src/components/questions/mock-exams/mock-exam-client';

it('UX11-RETURN-AC01 opens a separate mock session without linking the original run', async () => {
  const fetcher = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          id: 'session',
          workspace_id: 'workspace',
          mock_exam_question_id: 'question',
          revision_id: 'revision',
          question_type: 'MCQ',
          stem: 'Synthetic',
          is_multi_answer: false,
          displayed_option_ids: [],
          options: [],
          state: 'open',
          opened_at: '2026-01-01T00:00:00Z',
          practice_run_id: null,
          run_position: null,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
  );
  const result = await createMockPracticeApi('workspace', fetcher).openStandaloneSession(
    'question',
    'fresh-key',
  );
  expect(result.ok).toBe(true);
  const [, init] = fetcher.mock.calls[0] ?? [];
  expect(JSON.parse(String(init?.body))).toEqual({});
  expect(new Headers(init?.headers).get('idempotency-key')).toBe('fresh-key');
});

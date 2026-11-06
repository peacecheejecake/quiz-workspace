// @vitest-environment jsdom
// UX12-MOCKFORM2 / HOMEDLG-01: with 범위 first the range is the first input a backdrop click could
// lose, so a touched range counts as unsaved although no option has changed yet.
import './dom-setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MockExamForm } from '../src/components/questions/mock-exams/mock-exam-form';

const reported = vi.hoisted(() => vi.fn<(dirty: boolean) => void>());
vi.mock('@quiz/ui', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useUnsavedChanges: reported,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  reported.mockClear();
});

it('reports a touched range as unsaved', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            chapters: [],
            items: [
              {
                question_id: '22222222-2222-4222-8222-000000000001',
                chapter_id: null,
                question_number: 1,
                question_type: 'MCQ',
                preview: '발문',
                status: 'unseen',
                is_favorite: false,
                needs_retry: false,
                is_pending_grading: false,
                last_graded_result: null,
              },
            ],
            counts: {},
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ),
  );
  render(
    <MockExamForm
      workspaceId="11111111-1111-4111-8111-000000000000"
      mode="create"
      initial={{ title: '모의고사 1', types: [], count: '20', wholeRange: false, difficulty: null }}
      llmAvailable={false}
      busy={false}
      error={null}
      onSubmit={vi.fn()}
    />,
  );
  const all = await screen.findByRole('checkbox', { name: '전체 선택' });
  expect(reported).toHaveBeenLastCalledWith(false);
  await userEvent.setup().click(all);
  await waitFor(() => expect(reported).toHaveBeenLastCalledWith(true));
});

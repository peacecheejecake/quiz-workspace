// @vitest-environment jsdom
// UX12-SHARE: the `공유자의 기록` card. The list holds no write control, a turned-off link says so
// in the panel, and a dead link ends the view.
import './dom-setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SharedApiError, type SharedClient } from '../src/lib/shared/client';

vi.mock('next/navigation', () => ({
  usePathname: () => '/share/x',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const { SharedOwnerRecords } = await import('../src/components/shared/shared-owner-records');

const SHARE = '0b6a5c0e-1d2f-4a3b-8c4d-5e6f7a8b9c0d';
const QUESTION = {
  question_id: '1c7b6d1f-2e3a-4b4c-9d5e-6f7a8b9c0d1e',
  number_label: '3번',
  stem_preview: '비는 무엇인가',
};

function client(overrides: Partial<SharedClient> = {}): SharedClient {
  return {
    ownerAttempts: vi.fn(async () => ({
      items: [
        {
          id: 'a1',
          question: QUESTION,
          question_type: 'MCQ',
          result: 'incorrect',
          submitted_at: '2026-11-01T01:00:00Z',
        },
      ],
      next_cursor: null,
    })),
    ownerHighlights: vi.fn(async () => ({
      items: [
        {
          id: 'h1',
          kind: 'explanation',
          color: 'blue',
          quote: '증발한 물',
          question: QUESTION,
          chapter_title: null,
          created_at: '2026-11-01T02:00:00Z',
        },
        {
          id: 'h2',
          kind: 'note',
          color: 'pink',
          quote: '노트 문장',
          question: null,
          chapter_title: '1장',
          created_at: '2026-11-01T03:00:00Z',
        },
      ],
      next_cursor: null,
    })),
    ...overrides,
  } as unknown as SharedClient;
}

async function open(fake: SharedClient, onUnavailable = vi.fn()) {
  render(
    <SharedOwnerRecords
      shareId={SHARE}
      client={fake}
      documents={[]}
      onUnavailable={onUnavailable}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: '기록 보기' }));
  return screen.findByRole('dialog', { name: '공유자의 기록' });
}

describe('SharedOwnerRecords', () => {
  it('reads nothing until opened, then lists attempts and highlights without a write control', async () => {
    const fake = client();
    render(
      <SharedOwnerRecords shareId={SHARE} client={fake} documents={[]} onUnavailable={vi.fn()} />,
    );
    expect(fake.ownerAttempts).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '기록 보기' }));
    const panel = await screen.findByRole('dialog', { name: '공유자의 기록' });

    const attempts = within(panel).getByRole('region', { name: '풀이 이력' });
    expect(await within(attempts).findByText('오답')).toBeTruthy();
    const highlights = within(panel).getByRole('region', { name: '하이라이트' });
    expect(await within(highlights).findByText('증발한 물')).toBeTruthy();
    expect(within(highlights).getByText('정리 노트 · 1장')).toBeTruthy();
    const names = within(panel)
      .getAllByRole('button')
      .map((b) => b.textContent ?? '');
    expect(names.join(' ')).not.toMatch(/삭제|색|저장|편집|즐겨찾기/);
  });

  it('says the records are gone when the option was turned off meanwhile', async () => {
    const off = vi.fn(async () => {
      throw new SharedApiError('notFound', 404);
    });
    const panel = await open(client({ ownerAttempts: off, ownerHighlights: off }));
    await waitFor(() =>
      expect(within(panel).getAllByText('공유자가 기록 공개를 중지했습니다.')).toHaveLength(2),
    );
  });

  it('ends the share view when the link itself is over', async () => {
    const onUnavailable = vi.fn();
    const dead = vi.fn(async () => {
      throw new SharedApiError('unavailable', 404);
    });
    await open(client({ ownerAttempts: dead, ownerHighlights: dead }), onUnavailable);
    await waitFor(() => expect(onUnavailable).toHaveBeenCalled());
  });

  it('asks for the next page with the cursor it was given', async () => {
    const ownerAttempts = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          {
            id: 'a1',
            question: QUESTION,
            question_type: 'MCQ',
            result: 'correct',
            submitted_at: '2026-11-01T01:00:00Z',
          },
        ],
        next_cursor: 'next',
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'a2',
            question: QUESTION,
            question_type: 'MCQ',
            result: 'pending',
            submitted_at: '2026-10-01T01:00:00Z',
          },
        ],
        next_cursor: null,
      });
    const panel = await open(client({ ownerAttempts }));
    const attempts = within(panel).getByRole('region', { name: '풀이 이력' });
    await userEvent.click(await within(attempts).findByRole('button', { name: '더 보기' }));
    expect(await within(attempts).findByText('채점 전')).toBeTruthy();
    expect(ownerAttempts.mock.calls[1]?.[0]).toBe('next');
    expect(within(attempts).queryByRole('button', { name: '더 보기' })).toBeNull();
  });
});

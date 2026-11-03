// @vitest-environment jsdom
// ASK-01 AI 질문 panel (components/ask/ask-panel.tsx) against a fake AskClient: request races the
// E2E specs cannot force — a send finishing after the panel closed or moved on, a lost response
// and its retry, a conversation of another workspace in the URL, an answer stream that ends in an
// `error` whose reconciliation read fails.
import './dom-setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskPanel, type AskPanelProps } from '../src/components/ask/ask-panel';
import {
  type AskClient,
  type AskMessage,
  type Conversation,
  type MessageAccepted,
} from '../src/lib/ask/client';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const WS = '11111111-1111-4111-8111-111111111111';
const CONV = '33333333-3333-4333-8333-333333333333';
const STATE = {
  available: true,
  reason: null,
  limits: { max_question_chars: 1000, max_turns: 20, max_regenerations: 5 },
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function message(patch: Partial<AskMessage> & Pick<AskMessage, 'id' | 'role'>): AskMessage {
  return {
    conversation_id: CONV,
    status: 'succeeded',
    text: '답',
    sources: [],
    searched_sources: [],
    disclosure: 'none',
    error_code: null,
    uncited: false,
    truncated: false,
    degraded: [],
    question_message_id: null,
    retry_of_message_id: null,
    regenerated_from_message_id: null,
    feedback: null,
    created_at: '2026-11-03T00:00:00Z',
    ...patch,
  };
}

function conversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: CONV,
    workspace_id: WS,
    title: '질문',
    scope: { document_ids: [], chapter_ids: [] },
    attachment: null,
    messages: [],
    created_at: '2026-11-03T00:00:00Z',
    last_message_at: '2026-11-03T00:00:00Z',
    ...patch,
  };
}

function accepted(question: string): MessageAccepted {
  const user = message({ id: 'q1', role: 'user', text: question });
  return {
    user_message: user,
    answer: message({ id: 'a1', role: 'assistant', question_message_id: 'q1', text: '답 [1]' }),
    stream_url: '/api/v1/ask/messages/a1/stream',
    job_id: '44444444-4444-4444-8444-444444444444',
  };
}

function fakeClient(overrides: Partial<AskClient> = {}): AskClient {
  return {
    state: vi.fn(async () => STATE),
    list: vi.fn(async () => ({ items: [], next_cursor: null })),
    create: vi.fn(async () => conversation()),
    get: vi.fn(async () => conversation()),
    remove: vi.fn(async () => undefined),
    detach: vi.fn(async () => conversation()),
    ask: vi.fn(async (_c, body) => accepted(body.question)),
    message: vi.fn(async () => message({ id: 'a1', role: 'assistant' })),
    cancel: vi.fn(async () => message({ id: 'a1', role: 'assistant', status: 'stopped' })),
    again: vi.fn(async () => accepted('질문')),
    feedback: vi.fn(async () => undefined),
    ...overrides,
  };
}

function props(client: AskClient, patch: Partial<AskPanelProps> = {}): AskPanelProps {
  return {
    open: true,
    onOpenChange: vi.fn(),
    container: document.body,
    workspaceId: WS,
    archived: false,
    askState: STATE,
    client,
    conversationId: null,
    onNavigate: vi.fn(),
    documents: [],
    intent: null,
    ...patch,
  };
}

beforeEach(() => {
  // The answer stream relay: never answers unless a test says otherwise.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => undefined)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI 질문 panel request races', () => {
  it('ASK-01-AC01 a first question accepted after the panel closed or moved on navigates nowhere', async () => {
    const user = userEvent.setup();
    for (const after of ['closed', 'switched'] as const) {
      const pending = deferred<MessageAccepted>();
      const client = fakeClient({ ask: vi.fn(() => pending.promise) });
      const p = props(client);
      const view = render(<AskPanel {...p} />);
      await user.type(screen.getByRole('textbox', { name: '질문' }), '가나다 원리{Enter}');
      await waitFor(() => expect(client.ask).toHaveBeenCalledTimes(1));
      view.rerender(
        <AskPanel
          {...p}
          {...(after === 'closed'
            ? { open: false }
            : { conversationId: '55555555-5555-4555-8555-555555555555' })}
        />,
      );
      pending.resolve(accepted('가나다 원리'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The server still answers; only the stale navigation (and view update) is dropped.
      expect(p.onNavigate, after).not.toHaveBeenCalled();
      view.unmount();
    }
  });
});

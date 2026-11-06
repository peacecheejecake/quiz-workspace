// @vitest-environment jsdom
// ASK-01 AI 질문 panel (components/ask/ask-panel.tsx) against a fake AskClient: request races the
// E2E specs cannot force — a send finishing after the panel closed or moved on, a lost response
// and its retry, a conversation of another workspace in the URL, an answer stream that ends in an
// `error` whose reconciliation read fails.
import './dom-setup';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindRecoveryIdentity } from '../src/components/ask/ask-recovery-identity';
import { createAskRecoveryStore } from '../src/components/ask/ask-recovery-store';
import { AskPanel, type AskPanelProps } from '../src/components/ask/ask-panel';
import {
  AskApiError,
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
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
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

/** The question input; on the conversation list the FAB opens the composer first. */
async function composer(): Promise<HTMLElement> {
  const input = () => screen.queryByRole('textbox', { name: '질문' });
  const fab = () => screen.queryByRole('button', { name: '새 대화' });
  await waitFor(() => expect(input() ?? fab()).not.toBeNull());
  const button = input() ? null : fab();
  if (button) fireEvent.click(button);
  return screen.findByRole('textbox', { name: '질문' });
}

describe('UX10-AI availability', () => {
  it('hides the send action while retaining stored conversation access', async () => {
    const client = fakeClient();
    render(
      <AskPanel
        {...props(client, {
          askState: { ...STATE, available: false, reason: 'disabled' },
          conversationId: 'c1',
        })}
      />,
    );
    await waitFor(() => expect(client.get).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '보내기' })).toBeNull();
  });
});

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

describe('UX11-AI-DIRECT composer', () => {
  it('clears immediately, retains a pending question, and preserves edits on acceptance', async () => {
    const user = userEvent.setup();
    const pending = deferred<MessageAccepted>();
    const client = fakeClient({ ask: vi.fn(() => pending.promise) });
    render(<AskPanel {...props(client, { conversationId: CONV })} />);
    const input = await composer();
    await user.type(input, '첫 질문{Enter}');
    await waitFor(() => expect(client.ask).toHaveBeenCalledTimes(1));
    expect(input).toHaveValue('');
    expect(screen.getByText('첫 질문')).toBeTruthy();
    await user.type(input, '새 질문');
    pending.resolve(accepted('첫 질문'));
    await waitFor(() => expect(input).toHaveValue('새 질문'));
  });

  it('does not overwrite an edited draft on failure, including an erased draft', async () => {
    const user = userEvent.setup();
    const pending = deferred<MessageAccepted>();
    const client = fakeClient({ ask: vi.fn(() => pending.promise) });
    render(<AskPanel {...props(client, { conversationId: CONV })} />);
    const input = await composer();
    await user.type(input, '실패 질문{Enter}');
    await waitFor(() => expect(client.ask).toHaveBeenCalledTimes(1));
    await user.type(input, '새 글');
    await user.clear(input);
    pending.reject(new AskApiError('network'));
    await screen.findByText(/네트워크 연결을 확인/);
    expect(input).toHaveValue('');
    const recovery = screen.getByRole('group', { name: '보내지 못한 질문' });
    expect(recovery).toHaveTextContent('실패 질문');
    expect(recovery).toHaveTextContent('질문 복사');
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('unavailable'));
    await user.click(screen.getByRole('button', { name: '질문 복사' }));
    await screen.findByText('복사하지 못했습니다');
    expect(recovery).toHaveTextContent('실패 질문');
    expect(input).toHaveValue('');
  });

  it('retains a failed pending send across close and reopen without exposing it in another conversation', async () => {
    const user = userEvent.setup();
    const pending = deferred<MessageAccepted>();
    const recovery = createAskRecoveryStore();
    const client = fakeClient({ ask: vi.fn(() => pending.promise) });
    const p = props(client, { conversationId: CONV, recovery });
    const view = render(<AskPanel {...p} />);
    const input = await composer();
    await user.type(input, '원래 질문{Enter}');
    await waitFor(() => expect(client.ask).toHaveBeenCalledTimes(1));
    view.unmount();
    pending.reject(new AskApiError('network'));
    await waitFor(() => expect(recovery.getSnapshot()).toHaveLength(1));
    const other = render(<AskPanel {...p} conversationId="other" />);
    expect(screen.queryByText('원래 질문')).toBeNull();
    other.unmount();
    render(<AskPanel {...p} />);
    expect(await screen.findByText('원래 질문')).toBeTruthy();
  });

  it('does not retain a late failure after the account owner unmounts', async () => {
    const user = userEvent.setup();
    const pending = deferred<MessageAccepted>();
    const recovery = createAskRecoveryStore();
    const client = fakeClient({ ask: vi.fn(() => pending.promise) });
    const view = render(<AskPanel {...props(client, { conversationId: CONV, recovery })} />);
    await user.type(await composer(), '비공개 질문{Enter}');
    await waitFor(() => expect(client.ask).toHaveBeenCalledTimes(1));
    view.unmount();
    recovery.deactivate();
    pending.reject(new AskApiError('network'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recovery.getSnapshot()).toHaveLength(0);
  });

  it('keeps an edited draft and a hidden rejected question through an identity outage', async () => {
    const user = userEvent.setup();
    const pending = deferred<MessageAccepted>();
    const recovery = createAskRecoveryStore();
    let offline = false;
    const identity = bindRecoveryIdentity(
      recovery,
      async () => {
        if (offline) throw new Error('offline');
        return 'A';
      },
      vi.fn(),
    );
    await waitFor(() => expect(recovery.valid(recovery.token())).toBe(true));
    const client = fakeClient({ ask: vi.fn(() => pending.promise) });
    render(<AskPanel {...props(client, { conversationId: CONV, recovery })} />);
    const input = await composer();
    await user.type(input, '첫 질문{Enter}');
    await waitFor(() => expect(client.ask).toHaveBeenCalledTimes(1));
    await user.type(input, '새 글');
    await user.clear(input);
    offline = true;
    pending.reject(new AskApiError('network'));
    await screen.findByText(/네트워크 연결을 확인/);
    expect(input).toHaveValue('');
    expect(screen.queryByText('첫 질문')).toBeNull();
    offline = false;
    expect(await recovery.verify()).toBe(true);
    expect(await screen.findByText('첫 질문')).toBeTruthy();
    expect(input).toHaveValue('');
    identity.close();
  });

  it('reconciles an accepted response after identity returns without posting again', async () => {
    const user = userEvent.setup();
    const pending = deferred<MessageAccepted>();
    const recovery = createAskRecoveryStore();
    let offline = false;
    let offlineChecks = 0;
    const identity = bindRecoveryIdentity(
      recovery,
      async () => {
        if (offline) {
          offlineChecks += 1;
          throw new Error('offline');
        }
        return 'A';
      },
      vi.fn(),
    );
    await waitFor(() => expect(recovery.valid(recovery.token())).toBe(true));
    const client = fakeClient({ ask: vi.fn(() => pending.promise) });
    render(<AskPanel {...props(client, { conversationId: CONV, recovery })} />);
    const input = await composer();
    await user.type(input, '수락된 질문{Enter}');
    await waitFor(() => expect(client.ask).toHaveBeenCalledTimes(1));
    offline = true;
    pending.resolve(accepted('수락된 질문'));
    await waitFor(() => expect(offlineChecks).toBeGreaterThan(0));
    expect(recovery.getReceipts()).toHaveLength(0);
    offline = false;
    expect(await recovery.verify()).toBe(true);
    expect(await screen.findByText('수락된 질문')).toBeTruthy();
    expect(client.ask).toHaveBeenCalledTimes(1);
    identity.close();
  });

  it('defers first-conversation navigation until an accepted receipt is verified', async () => {
    const user = userEvent.setup();
    const pending = deferred<MessageAccepted>();
    const recovery = createAskRecoveryStore();
    let offline = false;
    let offlineChecks = 0;
    const identity = bindRecoveryIdentity(
      recovery,
      async () => {
        if (offline) {
          offlineChecks += 1;
          throw new Error('offline');
        }
        return 'A';
      },
      vi.fn(),
    );
    await waitFor(() => expect(recovery.valid(recovery.token())).toBe(true));
    const client = fakeClient({ ask: vi.fn(() => pending.promise) });
    const p = props(client, { recovery });
    render(<AskPanel {...p} />);
    await user.type(await composer(), '첫 질문{Enter}');
    await waitFor(() => expect(client.ask).toHaveBeenCalledTimes(1));
    offline = true;
    pending.resolve(accepted('첫 질문'));
    await waitFor(() => expect(offlineChecks).toBeGreaterThan(0));
    expect(p.onNavigate).not.toHaveBeenCalled();
    offline = false;
    await recovery.verify();
    await waitFor(() => expect(p.onNavigate).toHaveBeenCalledWith(CONV, 'replace'));
    expect(client.ask).toHaveBeenCalledTimes(1);
    identity.close();
  });

  it.each(['대화 목록', '새 대화'])(
    'does not navigate a newer %s view when an older send is accepted',
    async (label) => {
      const user = userEvent.setup();
      const pending = deferred<MessageAccepted>();
      const client = fakeClient({ ask: vi.fn(() => pending.promise) });
      const p = props(client);
      render(<AskPanel {...p} />);
      await user.type(await composer(), '이전 질문{Enter}');
      await waitFor(() => expect(client.ask).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole('button', { name: '대화 목록' }));
      if (label === '새 대화') await user.click(await screen.findByRole('button', { name: label }));
      pending.resolve(accepted('이전 질문'));
      expect(await screen.findByRole('group', { name: '확인할 답변' })).toHaveTextContent(
        '이전 질문',
      );
      expect(p.onNavigate).not.toHaveBeenCalled();
    },
  );

  it('reloads a same-conversation receipt after reopening, retaining it on read failure and preserving the draft', async () => {
    const user = userEvent.setup();
    const pending = deferred<MessageAccepted>();
    const recovery = createAskRecoveryStore();
    const get = vi
      .fn<AskClient['get']>()
      .mockResolvedValueOnce(conversation())
      .mockResolvedValueOnce(conversation())
      .mockRejectedValueOnce(new AskApiError('network'))
      .mockResolvedValueOnce(
        conversation({
          messages: [accepted('기존 질문').user_message, accepted('기존 질문').answer],
        }),
      );
    const client = fakeClient({ ask: vi.fn(() => pending.promise), get });
    const p = props(client, { recovery, conversationId: CONV });
    const first = render(<AskPanel {...p} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await user.type(await composer(), '기존 질문{Enter}');
    await waitFor(() => expect(client.ask).toHaveBeenCalledTimes(1));
    first.unmount();
    pending.resolve(accepted('기존 질문'));
    await waitFor(() => expect(recovery.getReceipts()).toHaveLength(1));
    render(<AskPanel {...p} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    const draft = await composer();
    await user.type(draft, '새 draft');
    await user.click(await screen.findByRole('button', { name: '답변 확인' }));
    await screen.findByText(/네트워크 연결을 확인/);
    expect(screen.getByRole('button', { name: '답변 확인' })).toBeTruthy();
    expect(draft).toHaveValue('새 draft');
    await user.click(screen.getByRole('button', { name: '답변 확인' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '답변 확인' })).toBeNull());
    expect(await screen.findByText('기존 질문')).toBeTruthy();
    expect(draft).toHaveValue('새 draft');
    expect(p.onNavigate).not.toHaveBeenCalled();
  });

  it('reuses an ambiguous operation after panel remount with the exact original body and key', async () => {
    const user = userEvent.setup();
    const recovery = createAskRecoveryStore();
    const ask = vi
      .fn<AskClient['ask']>()
      .mockRejectedValueOnce(new AskApiError('network'))
      .mockImplementation(async (_id, body) => accepted(body.question));
    const client = fakeClient({ ask });
    const p = props(client, { recovery });
    const first = render(<AskPanel {...p} />);
    await user.type(await composer(), '같은 질문{Enter}');
    await screen.findByText(/네트워크 연결을 확인/);
    first.unmount();
    render(<AskPanel {...p} />);
    await user.type(await composer(), '같은 질문{Enter}');
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    expect(ask.mock.calls[1]).toEqual(ask.mock.calls[0]);
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  it('reconciles a possibly accepted question before sending changed text after remount', async () => {
    const user = userEvent.setup();
    const recovery = createAskRecoveryStore();
    const ask = vi
      .fn<AskClient['ask']>()
      .mockRejectedValueOnce(new AskApiError('network'))
      .mockImplementation(async (_id, body) => accepted(body.question));
    const client = fakeClient({ ask });
    const p = props(client, { recovery });
    const first = render(<AskPanel {...p} />);
    await user.type(await composer(), '원래 질문{Enter}');
    await screen.findByText(/네트워크 연결을 확인/);
    first.unmount();
    render(<AskPanel {...p} />);
    await user.type(await composer(), '다른 질문{Enter}');
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    expect(client.get).toHaveBeenCalledWith(CONV);
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[1]?.[2]).not.toBe(ask.mock.calls[0]?.[2]);
    expect(ask.mock.calls[1]?.[1].question).toBe('다른 질문');
  });

  it.each(['첫 질문', '다른 질문'])(
    'starts a distinct compose session after an ambiguous first-send failure for %s',
    async (nextQuestion) => {
      const user = userEvent.setup();
      const recovery = createAskRecoveryStore();
      const secondId = '55555555-5555-4555-8555-555555555555';
      const create = vi
        .fn<AskClient['create']>()
        .mockResolvedValueOnce(conversation())
        .mockResolvedValueOnce(conversation({ id: secondId }));
      const ask = vi
        .fn<AskClient['ask']>()
        .mockRejectedValueOnce(new AskApiError('network'))
        .mockImplementation(async (_id, body) => accepted(body.question));
      const client = fakeClient({ ask, create });
      render(<AskPanel {...props(client, { recovery })} />);
      const input = await composer();
      await user.type(input, '첫 질문{Enter}');
      await screen.findByText(/네트워크 연결을 확인/);
      await user.click(screen.getByRole('button', { name: '대화 목록' }));
      await user.click(await screen.findByRole('button', { name: '새 대화' }));
      const next = await composer();
      await user.clear(next);
      await user.type(next, `${nextQuestion}{Enter}`);
      await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
      expect(create).toHaveBeenCalledTimes(2);
      expect(ask.mock.calls[1]?.[0]).toBe(secondId);
      expect(ask.mock.calls[1]?.[2]).not.toBe(ask.mock.calls[0]?.[2]);
    },
  );

  it('restores a failed send only when no subsequent edit occurred', async () => {
    const user = userEvent.setup();
    const pending = deferred<MessageAccepted>();
    const client = fakeClient({ ask: vi.fn(() => pending.promise) });
    render(<AskPanel {...props(client, { conversationId: CONV })} />);
    const input = await composer();
    await user.type(input, '실패 질문{Enter}');
    await waitFor(() => expect(client.ask).toHaveBeenCalledTimes(1));
    expect(input).toHaveValue('');
    pending.reject(new AskApiError('network'));
    await waitFor(() => expect(input).toHaveValue('실패 질문'));
    expect(screen.queryByRole('group', { name: '보내지 못한 질문' })).toBeNull();
  });
});

describe('UX12-ASK screens', () => {
  it('UX12-ASK-AC03 keeps a draft across the list and moves focus with the screens', async () => {
    const user = userEvent.setup();
    render(<AskPanel {...props(fakeClient())} />);
    expect(screen.queryByRole('textbox', { name: '질문' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: '새 대화' }));
    const input = await screen.findByRole('textbox', { name: '질문' });
    expect(input).toHaveFocus();
    await user.type(input, '쓰던 질문');
    await user.click(screen.getByRole('button', { name: '대화 목록' }));
    const fab = await screen.findByRole('button', { name: '새 대화' });
    expect(fab).toHaveFocus();
    await user.click(fab);
    const again = await screen.findByRole('textbox', { name: '질문' });
    expect(again).toHaveValue('쓰던 질문');
    expect(again).toHaveFocus();
  });

  it('UX12-ASK-AC03 shows a failed new question on the list, where no composer holds it', async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      ask: vi.fn(async () => Promise.reject(new AskApiError('network'))),
    });
    render(<AskPanel {...props(client)} />);
    await user.type(await composer(), '실패 질문{Enter}');
    await screen.findByText(/네트워크 연결을 확인/);
    expect(screen.queryByRole('group', { name: '보내지 못한 질문' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '대화 목록' }));
    expect(await screen.findByRole('group', { name: '보내지 못한 질문' })).toBeVisible();
  });

  it('UX12-ASK-AC02 moves focus to the title when the list has no FAB', async () => {
    const user = userEvent.setup();
    const client = fakeClient({ get: vi.fn(async () => conversation()) });
    const unavailable = { ...STATE, available: false, reason: 'disabled' as const };
    const p = props(client, { askState: unavailable, conversationId: CONV });
    const view = render(<AskPanel {...p} />);
    await user.click(await screen.findByRole('button', { name: '대화 목록' }));
    view.rerender(<AskPanel {...p} conversationId={null} />);
    expect(screen.queryByRole('button', { name: '새 대화' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'AI 질문' })).toHaveFocus();
    expect(screen.getByText('이 환경에서는 AI 질문을 사용할 수 없습니다.')).toBeVisible();
    await screen.findByText(/Workspace 문서에 대해 물어보세요/);
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('UX12-ASK-AC07 keeps focus on the button when 보내기 becomes 답변 중지', async () => {
    const user = userEvent.setup();
    const pending = deferred<MessageAccepted>();
    const client = fakeClient({ ask: vi.fn(() => pending.promise) });
    render(<AskPanel {...props(client)} />);
    await user.type(await composer(), '질문');
    const send = screen.getByRole('button', { name: '보내기' });
    await user.click(send);
    pending.resolve({
      ...accepted('질문'),
      answer: message({
        id: 'a1',
        role: 'assistant',
        status: 'streaming',
        question_message_id: 'q1',
        text: '',
      }),
    });
    const stop = await screen.findByRole('button', { name: '답변 중지' });
    expect(stop).toBe(send);
    expect(stop).toHaveFocus();
  });

  it('UX12-ASK-AC08 offers 다시 시도 only on a failed or stopped last answer', async () => {
    const turn = (status: AskMessage['status']) =>
      conversation({
        messages: [
          message({ id: 'q1', role: 'user', text: '질문' }),
          message({ id: 'a1', role: 'assistant', status, question_message_id: 'q1', text: '답' }),
        ],
      });
    const shown = render(
      <AskPanel
        {...props(fakeClient({ get: vi.fn(async () => turn('succeeded')) }), {
          conversationId: CONV,
        })}
      />,
    );
    await screen.findByText('답');
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
    expect(screen.queryByRole('button', { name: '다시 생성' })).toBeNull();
    expect(screen.queryByText('AI 생성')).toBeNull();
    shown.unmount();
    render(
      <AskPanel
        {...props(fakeClient({ get: vi.fn(async () => turn('stopped')) }), {
          conversationId: CONV,
        })}
      />,
    );
    expect(await screen.findByRole('button', { name: '다시 시도' })).toBeVisible();
  });
});

describe('AI 질문 panel request races', () => {
  it('ASK-01-AC01 a first question accepted after the panel closed or moved on navigates nowhere', async () => {
    const user = userEvent.setup();
    for (const after of ['closed', 'switched'] as const) {
      const pending = deferred<MessageAccepted>();
      const client = fakeClient({ ask: vi.fn(() => pending.promise) });
      const p = props(client);
      const view = render(<AskPanel {...p} />);
      await user.type(await composer(), '가나다 원리{Enter}');
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

  it('ASK-01-AC09 a resend after a lost response reuses its Idempotency-Key; another question re-reads the conversation first', async () => {
    const user = userEvent.setup();
    const ask = vi
      .fn<AskClient['ask']>()
      .mockRejectedValueOnce(new AskApiError('network'))
      .mockRejectedValueOnce(new AskApiError('network'))
      .mockImplementation(async (_c, body) => accepted(body.question));
    const get = vi.fn(async () => conversation());
    const client = fakeClient({ ask, get });
    render(<AskPanel {...props(client, { conversationId: CONV })} />);
    const input = await composer();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    await user.type(input, '가나다 원리{Enter}');
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    await screen.findByText(/네트워크 연결을 확인/);
    // The same question again: the same operation, the same key (the first may have landed).
    await user.type(input, '{Enter}');
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    expect(ask.mock.calls[1]?.[2]).toBe(ask.mock.calls[0]?.[2]);
    await screen.findByText(/네트워크 연결을 확인/);

    // Another question: the conversation is re-read first, then a new key.
    await user.clear(input);
    await user.type(input, '다른 질문{Enter}');
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(3));
    expect(get).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[2]?.[2]).not.toBe(ask.mock.calls[0]?.[2]);
  });

  it('ASK-01-AC09 a retry after a lost response reuses its Idempotency-Key', async () => {
    const user = userEvent.setup();
    const failed = message({
      id: 'a1',
      role: 'assistant',
      question_message_id: 'q1',
      status: 'failed',
      error_code: 'llm_unavailable',
    });
    const again = vi
      .fn<AskClient['again']>()
      .mockRejectedValueOnce(new AskApiError('network'))
      .mockImplementation(async () => accepted('질문'));
    const client = fakeClient({
      again,
      get: vi.fn(async () =>
        conversation({ messages: [message({ id: 'q1', role: 'user', text: '질문' }), failed] }),
      ),
    });
    render(<AskPanel {...props(client, { conversationId: CONV })} />);
    await user.click(await screen.findByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(again).toHaveBeenCalledTimes(1));
    await screen.findByText(/네트워크 연결을 확인/);
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(again).toHaveBeenCalledTimes(2));
    expect(again.mock.calls[1]?.[2]).toBe(again.mock.calls[0]?.[2]);
  });

  it('ASK-01-AC07 a conversation of another workspace in the URL is not found here', async () => {
    const client = fakeClient({
      get: vi.fn(async () =>
        conversation({
          workspace_id: OTHER_WS,
          messages: [message({ id: 'q1', role: 'user', text: '다른 Workspace의 질문' })],
        }),
      ),
    });
    render(<AskPanel {...props(client, { conversationId: CONV })} />);
    expect(await screen.findByText('대화를 찾을 수 없습니다.')).toBeVisible();
    expect(screen.queryByText('다른 Workspace의 질문')).toBeNull();
  });

  it('ASK-01-AC09 an answer stream that ends in an error keeps reading the message until it is final', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('event: error\ndata: {"code":"llm_unavailable"}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    );
    const failed = message({
      id: 'a1',
      role: 'assistant',
      question_message_id: 'q1',
      status: 'failed',
      error_code: 'llm_unavailable',
    });
    const read = vi
      .fn<AskClient['message']>()
      .mockRejectedValueOnce(new AskApiError('network'))
      .mockResolvedValue(failed);
    const client = fakeClient({
      message: read,
      get: vi.fn(async () =>
        conversation({
          messages: [
            message({ id: 'q1', role: 'user', text: '질문' }),
            { ...failed, status: 'streaming', error_code: null, text: '' },
          ],
        }),
      ),
    });
    render(<AskPanel {...props(client, { conversationId: CONV })} />);
    // The first reconciliation read fails; the panel keeps polling instead of spinning forever.
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent(
      'AI 서비스에 연결하지 못했습니다',
    );
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('ASK-01-AC09 a turn recovered by re-reading after a lost response stays shown after the next question', async () => {
    const user = userEvent.setup();
    const recovered = [
      message({ id: 'q0', role: 'user', text: '가나다 원리' }),
      message({ id: 'a0', role: 'assistant', question_message_id: 'q0', text: '복구된 답' }),
    ];
    const ask = vi
      .fn<AskClient['ask']>()
      .mockRejectedValueOnce(new AskApiError('network'))
      .mockImplementation(async (_c, body) => accepted(body.question));
    const get = vi
      .fn<AskClient['get']>()
      .mockResolvedValueOnce(conversation())
      .mockResolvedValue(conversation({ messages: recovered }));
    const client = fakeClient({ ask, get });
    render(<AskPanel {...props(client, { conversationId: CONV })} />);
    const input = await composer();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await user.type(input, '가나다 원리{Enter}');
    await screen.findByText(/네트워크 연결을 확인/);
    await user.clear(input);
    await user.type(input, '다른 질문{Enter}');
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('다른 질문')).toBeVisible();
    // The first question landed after all: the re-read showed it, and the next send keeps it.
    expect(screen.getByText('복구된 답')).toBeVisible();
    expect(screen.getAllByRole('article', { name: '내 질문' })).toHaveLength(2);
  });

  it('ASK-01-AC09 an answer whose stream delivers nothing yet still shows its text so far and its stop button', async () => {
    // The relay's stream never delivers (a buffering proxy or browser): the panel reads the
    // message itself while the stream is silent.
    const streaming = message({
      id: 'a1',
      role: 'assistant',
      question_message_id: 'q1',
      status: 'streaming',
      text: '가나다 원리는 부분',
    });
    const read = vi.fn<AskClient['message']>().mockResolvedValue(streaming);
    const client = fakeClient({
      message: read,
      get: vi.fn(async () =>
        conversation({
          messages: [message({ id: 'q1', role: 'user', text: '질문' }), { ...streaming, text: '' }],
        }),
      ),
    });
    render(<AskPanel {...props(client, { conversationId: CONV })} />);
    expect(await screen.findByText(/가나다 원리는 부분/, {}, { timeout: 4000 })).toBeVisible();
    expect(screen.getByRole('button', { name: '답변 중지' })).toBeVisible();
  });

  it('ASK-01-AC09 once polling finalized an answer, its late stream events change neither it nor the next answer', async () => {
    const user = userEvent.setup();
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new ReadableStream<Uint8Array>({ start: (c) => void streams.push(c) }), {
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    );
    const push = (i: number, text: string) => streams[i]?.enqueue(new TextEncoder().encode(text));
    const final = message({
      id: 'a1',
      role: 'assistant',
      question_message_id: 'q1',
      status: 'succeeded',
      text: '최종 답',
    });
    const next = message({
      id: 'a2',
      role: 'assistant',
      question_message_id: 'q2',
      status: 'queued',
      text: '',
    });
    const client = fakeClient({
      // The silent stream is reconciled by polling: the answer is final.
      message: vi.fn(async (id: string) =>
        id === 'a1' ? final : { ...next, status: 'streaming' as const },
      ),
      get: vi.fn(async () =>
        conversation({
          messages: [
            message({ id: 'q1', role: 'user', text: '질문' }),
            { ...final, status: 'streaming', text: '' },
          ],
        }),
      ),
      ask: vi.fn(async () => ({
        user_message: message({ id: 'q2', role: 'user', text: '다음 질문' }),
        answer: next,
        stream_url: '/api/v1/ask/messages/a2/stream',
        job_id: '44444444-4444-4444-8444-444444444444',
      })),
    });
    render(<AskPanel {...props(client, { conversationId: CONV })} />);
    expect(await screen.findByText('최종 답', {}, { timeout: 4000 })).toBeVisible();

    // The held-back stream of the finalized answer now delivers a delta: it is ignored.
    push(0, 'id: 1\nevent: delta\ndata: {"seq":1,"text":"늦은 글자"}\n\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/늦은 글자/)).toBeNull();
    expect(screen.getByText('최종 답')).toBeVisible();

    // The next answer streams; the first stream's late `done` does not clear its text.
    await user.type(await composer(), '다음 질문{Enter}');
    await waitFor(() => expect(streams).toHaveLength(2));
    push(1, 'id: 1\nevent: delta\ndata: {"seq":1,"text":"새 답 일부"}\n\n');
    expect(await screen.findByText(/새 답 일부/)).toBeVisible();
    push(0, `event: done\ndata: ${JSON.stringify({ message: final })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText(/새 답 일부/)).toBeVisible();
  });
});

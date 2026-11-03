// @vitest-environment jsdom
// ASK-01 문제 쪽 진입점 (components/ask/ask-launcher.tsx useGuardedAskLaunch): a question's
// `질문하기` creates the conversation first and only then opens the AI 질문 panel. A creation that
// finishes after the user moved on — the question dialog closed (its 질문하기 gone), the address
// changed (another panel, another workspace), the home unmounted, or a newer 질문하기 — must not
// open the panel or touch history.
import './dom-setup';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGuardedAskLaunch } from '../src/components/ask/ask-launcher';
import type { AskAttachmentInput, Conversation } from '../src/lib/ask/client';

const ATTACHMENT: AskAttachmentInput = {
  kind: 'question',
  view: 'detail',
  question_id: '22222222-2222-4222-8222-000000000001',
};
const CONVERSATION = { id: '33333333-3333-4333-8333-333333333333' } as Conversation;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup() {
  const pending: ReturnType<typeof deferred<Conversation | null>>[] = [];
  const create = vi.fn(() => {
    const d = deferred<Conversation | null>();
    pending.push(d);
    return d.promise;
  });
  const show = vi.fn();
  const hook = renderHook(() => useGuardedAskLaunch(create, show));
  const opener = document.createElement('button');
  document.body.append(opener);
  return { pending, create, show, hook, opener };
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('ASK-01 질문하기 launch guard', () => {
  it('opens the panel with the created conversation when nothing changed meanwhile', async () => {
    const { pending, show, hook, opener } = setup();
    let done!: Promise<void>;
    act(() => {
      done = hook.result.current.open(ATTACHMENT, opener);
    });
    await act(async () => {
      pending[0]?.resolve(CONVERSATION);
      await done;
    });
    expect(show).toHaveBeenCalledWith({ conversation: CONVERSATION, opener });
  });

  it('does nothing once the question dialog closed (its 질문하기 left the page)', async () => {
    const { pending, show, hook, opener } = setup();
    let done!: Promise<void>;
    act(() => {
      done = hook.result.current.open(ATTACHMENT, opener);
    });
    opener.remove();
    await act(async () => {
      pending[0]?.resolve(CONVERSATION);
      await done;
    });
    expect(show).not.toHaveBeenCalled();
  });

  it('does nothing once the address changed (another panel, another workspace)', async () => {
    const { pending, show, hook, opener } = setup();
    window.history.pushState(null, '', '/workspaces/a?question=q1');
    let done!: Promise<void>;
    act(() => {
      done = hook.result.current.open(ATTACHMENT, opener);
    });
    window.history.pushState(null, '', '/workspaces/b');
    await act(async () => {
      pending[0]?.resolve(CONVERSATION);
      await done;
    });
    expect(show).not.toHaveBeenCalled();
  });

  it('does nothing after the home unmounted', async () => {
    const { pending, show, hook, opener } = setup();
    let done!: Promise<void>;
    act(() => {
      done = hook.result.current.open(ATTACHMENT, opener);
    });
    hook.unmount();
    await act(async () => {
      pending[0]?.resolve(CONVERSATION);
      await done;
    });
    expect(show).not.toHaveBeenCalled();
  });

  it('a newer 질문하기 supersedes an older one still creating', async () => {
    const { pending, show, hook, opener } = setup();
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = hook.result.current.open(ATTACHMENT, opener);
      second = hook.result.current.open(ATTACHMENT, opener);
    });
    const newer = { id: '44444444-4444-4444-8444-444444444444' } as Conversation;
    await act(async () => {
      pending[1]?.resolve(newer);
      pending[0]?.resolve(CONVERSATION);
      await Promise.all([first, second]);
    });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith({ conversation: newer, opener });
  });

  it('a failed creation still opens the panel (with the reason) when nothing changed', async () => {
    const { pending, show, hook, opener } = setup();
    let done!: Promise<void>;
    act(() => {
      done = hook.result.current.open(ATTACHMENT, opener);
    });
    await act(async () => {
      pending[0]?.resolve(null);
      await done;
    });
    expect(show).toHaveBeenCalledWith({ conversation: null, opener });
  });
});

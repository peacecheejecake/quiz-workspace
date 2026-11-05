import { describe, expect, it, vi } from 'vitest';
import {
  observedPracticeEpoch,
  practiceResetVersion,
  publishPracticeReset,
  rememberPracticeEpoch,
  subscribePracticeResets,
  setPracticeViewer,
} from '../src/lib/questions/practice-reset-events';

describe('practice reset generations and authoritative epochs', () => {
  it('invalidates old work without inflating a refetched epoch on duplicate or delayed events', () => {
    const workspace = 'epoch-test';
    const question = 'q';
    const alias = 'alias';
    const seen: string[] = [];
    const unsubscribe = subscribePracticeResets(workspace, (id) => seen.push(id));
    rememberPracticeEpoch(workspace, question, 2);
    const oldVersion = practiceResetVersion(workspace, question);
    publishPracticeReset(workspace, { [question]: 2, [alias]: 4 });
    expect(practiceResetVersion(workspace, question)).not.toBe(oldVersion);
    expect(observedPracticeEpoch(workspace, question)).toBe(2);
    expect(observedPracticeEpoch(workspace, alias)).toBe(4);
    publishPracticeReset(workspace, { [question]: 2 });
    expect(observedPracticeEpoch(workspace, question)).toBe(2);
    rememberPracticeEpoch(workspace, question, 3);
    publishPracticeReset(workspace, { [question]: 2 });
    expect(observedPracticeEpoch(workspace, question)).toBe(3);
    expect(seen).toEqual([question, alias, question, question]);
    unsubscribe();
  });

  it('accepts delayed cross-tab epochs without inventing a new server epoch', () => {
    let receive: ((event: MessageEvent<unknown>) => void) | null = null;
    class Channel {
      set onmessage(handler: (event: MessageEvent<unknown>) => void) {
        receive = handler;
      }
      postMessage = vi.fn();
      close = vi.fn();
    }
    vi.stubGlobal('BroadcastChannel', Channel);
    const workspace = 'cross-tab-epoch-test';
    setPracticeViewer('user-a');
    const unsubscribe = subscribePracticeResets(workspace, vi.fn());
    rememberPracticeEpoch(workspace, 'q', 7);
    const before = practiceResetVersion(workspace, 'q');
    const deliver = receive as unknown as (event: MessageEvent<unknown>) => void;
    deliver({ data: { viewerId: 'user-a', epochs: { q: 7 } } } as MessageEvent<unknown>);
    deliver({ data: { viewerId: 'user-a', epochs: { q: 7 } } } as MessageEvent<unknown>);
    expect(practiceResetVersion(workspace, 'q')).not.toBe(before);
    expect(observedPracticeEpoch(workspace, 'q')).toBe(7);
    rememberPracticeEpoch(workspace, 'q', 8);
    deliver({ data: { viewerId: 'user-a', epochs: { q: 7 } } } as MessageEvent<unknown>);
    expect(observedPracticeEpoch(workspace, 'q')).toBe(8);
    const oldVersion = practiceResetVersion(workspace, 'q');
    setPracticeViewer('user-b');
    expect(practiceResetVersion(workspace, 'q')).not.toBe(oldVersion);
    expect(observedPracticeEpoch(workspace, 'q')).toBeUndefined();
    rememberPracticeEpoch(workspace, 'q', 1);
    deliver({ data: { viewerId: 'user-a', epochs: { q: 7 } } } as MessageEvent<unknown>);
    expect(observedPracticeEpoch(workspace, 'q')).toBe(1);
    unsubscribe();
    setPracticeViewer(null);
    vi.unstubAllGlobals();
  });
});

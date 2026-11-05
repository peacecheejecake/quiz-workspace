import { describe, expect, it } from 'vitest';
import { makeReturnTarget, returnHref } from '../src/lib/questions/practice-return';

const workspaceId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const questionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const runId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('practice return target', () => {
  it('UX11-RETURN-AC02 reconstructs only the allowed workspace question route', () => {
    const target = makeReturnTarget({ kind: 'question', workspaceId, questionId });
    expect(target && returnHref(target)).toBe(`/workspaces/${workspaceId}?question=${questionId}`);
  });
  it('UX11-RETURN-AC02 preserves the run position', () => {
    const target = makeReturnTarget({ kind: 'run', workspaceId, runId, position: 12 });
    expect(target && returnHref(target)).toBe(`/workspaces/${workspaceId}?practice=${runId}&i=12`);
  });
  it('UX11-RETURN-AC04 rejects malformed identifiers and invalid positions', () => {
    expect(
      makeReturnTarget({ kind: 'question', workspaceId: '../settings', questionId }),
    ).toBeNull();
    expect(makeReturnTarget({ kind: 'run', workspaceId, runId, position: 0 })).toBeNull();
    expect(makeReturnTarget({ kind: 'run', workspaceId, runId, position: 5001 })).toBeNull();
  });
  it('UX11-RETURN-AC04 retains only the allowlisted identifiers', () => {
    const input = { kind: 'question' as const, workspaceId, questionId, answer: 'secret' };
    expect(makeReturnTarget(input)).toEqual({ kind: 'question', workspaceId, questionId });
  });
});

import { initialReturnState, reduceReturnState } from '../src/lib/questions/practice-return';

describe('practice return lifecycle', () => {
  const target = { kind: 'question' as const, workspaceId, questionId };
  it('UX11-RETURN-AC03 dismisses only the control and reactivates on activity', () => {
    const active = reduceReturnState(initialReturnState, { type: 'activity', target });
    const dismissed = reduceReturnState(active, { type: 'dismiss' });
    expect(dismissed).toEqual({ target, dismissed: true });
    expect(reduceReturnState(dismissed, { type: 'activity', target })).toEqual(active);
  });
  it('UX11-RETURN-AC04 clears the target when it is invalidated', () => {
    const active = reduceReturnState(initialReturnState, { type: 'activity', target });
    expect(reduceReturnState(active, { type: 'clear' })).toEqual(initialReturnState);
  });
});

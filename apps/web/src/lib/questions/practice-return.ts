import { PRACTICE_RUN_MAX } from './practice-runs';

export type ReturnTarget =
  | { readonly kind: 'question'; readonly workspaceId: string; readonly questionId: string }
  | {
      readonly kind: 'run';
      readonly workspaceId: string;
      readonly runId: string;
      readonly position: number;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Copies only the identifiers needed to reconstruct an allowed route. */
export function makeReturnTarget(target: ReturnTarget): ReturnTarget | null {
  if (!UUID.test(target.workspaceId)) return null;
  const workspaceId = target.workspaceId.toLowerCase();
  if (target.kind === 'question') {
    return UUID.test(target.questionId)
      ? { kind: 'question', workspaceId, questionId: target.questionId.toLowerCase() }
      : null;
  }
  if (
    !UUID.test(target.runId) ||
    !Number.isInteger(target.position) ||
    target.position < 1 ||
    target.position > PRACTICE_RUN_MAX
  )
    return null;
  return { kind: 'run', workspaceId, runId: target.runId.toLowerCase(), position: target.position };
}

export function returnHref(target: ReturnTarget): string {
  const params =
    target.kind === 'question'
      ? new URLSearchParams({ question: target.questionId })
      : new URLSearchParams({ practice: target.runId, i: String(target.position) });
  return `/workspaces/${target.workspaceId}?${params}`;
}

export interface ReturnState {
  readonly target: ReturnTarget | null;
  readonly dismissed: boolean;
}
export type ReturnAction =
  | { readonly type: 'activity'; readonly target: ReturnTarget }
  | { readonly type: 'dismiss' }
  | { readonly type: 'clear' };
export const initialReturnState: ReturnState = { target: null, dismissed: false };

export function reduceReturnState(state: ReturnState, action: ReturnAction): ReturnState {
  switch (action.type) {
    case 'activity': {
      const target = makeReturnTarget(action.target);
      return target ? { target, dismissed: false } : state;
    }
    case 'dismiss':
      return { ...state, dismissed: true };
    case 'clear':
      return initialReturnState;
  }
}

// Inline correction of one canonical block (DOC-02-AC02) as a pure state machine, so the
// version-based conflict handling is unit-tested without a browser:
//
//   idle --start--> editing --save--> saving --saved--> idle
//                      ^                 |
//                      +----failed-------+   (error shown; text kept)
//                      +----conflict-----+   (server text shown; base_version moves to the
//                                             server's version so a deliberate re-save wins)
//
// Only one block is edited at a time. Saving an unchanged text is a cancel (the API would answer
// a no-op without creating a draft anyway).
import type { ContentBlock, EditorFailureKind } from './editor-api';

export interface EditFailure {
  readonly kind: EditorFailureKind;
  readonly message: string;
}

export interface ConflictInfo {
  /** The block's current text on the server (the user's text stays in the field). */
  readonly serverText: string;
}

interface Draft {
  readonly blockId: string;
  /** Text in the field. */
  readonly text: string;
  /** Text the edit started from (or the server's text after a conflict). */
  readonly original: string;
  /** `version` sent as `base_version`. */
  readonly baseVersion: string;
}

export type BlockEditState =
  | { readonly phase: 'idle' }
  | (Draft & {
      readonly phase: 'editing';
      readonly failure?: EditFailure;
      readonly conflict?: ConflictInfo;
    })
  | (Draft & { readonly phase: 'saving' });

export type BlockEditAction =
  | { readonly type: 'start'; readonly block: Pick<ContentBlock, 'block_id' | 'text' | 'version'> }
  | { readonly type: 'change'; readonly text: string }
  | { readonly type: 'cancel' }
  | { readonly type: 'save' }
  | { readonly type: 'saved'; readonly blockId: string }
  | { readonly type: 'failed'; readonly blockId: string; readonly failure: EditFailure }
  | {
      readonly type: 'conflict';
      readonly blockId: string;
      readonly failure: EditFailure;
      /** The block as the server has it now; null when it could not be reloaded. */
      readonly latest: Pick<ContentBlock, 'text' | 'version'> | null;
    };

export const IDLE: BlockEditState = { phase: 'idle' };

export function blockEditReducer(state: BlockEditState, action: BlockEditAction): BlockEditState {
  switch (action.type) {
    case 'start':
      if (state.phase === 'saving') return state;
      return {
        phase: 'editing',
        blockId: action.block.block_id,
        text: action.block.text,
        original: action.block.text,
        baseVersion: action.block.version,
      };
    case 'change':
      if (state.phase !== 'editing') return state;
      return { ...state, text: action.text };
    case 'cancel':
      return state.phase === 'editing' ? IDLE : state;
    case 'save':
      if (state.phase !== 'editing') return state;
      if (state.text === state.original) return IDLE;
      return {
        phase: 'saving',
        blockId: state.blockId,
        text: state.text,
        original: state.original,
        baseVersion: state.baseVersion,
      };
    case 'saved':
      return state.phase === 'saving' && state.blockId === action.blockId ? IDLE : state;
    case 'failed':
      if (state.phase !== 'saving' || state.blockId !== action.blockId) return state;
      return { ...draftOf(state), phase: 'editing', failure: action.failure };
    case 'conflict':
      if (state.phase !== 'saving' || state.blockId !== action.blockId) return state;
      if (action.latest === null) {
        return { ...draftOf(state), phase: 'editing', failure: action.failure };
      }
      return {
        ...draftOf(state),
        phase: 'editing',
        original: action.latest.text,
        baseVersion: action.latest.version,
        failure: action.failure,
        conflict: { serverText: action.latest.text },
      };
  }
}

function draftOf(state: Draft): Draft {
  return {
    blockId: state.blockId,
    text: state.text,
    original: state.original,
    baseVersion: state.baseVersion,
  };
}

/** The block being edited or saved, if any. */
export function editingBlockId(state: BlockEditState): string | null {
  return state.phase === 'idle' ? null : state.blockId;
}

/** Unsaved text would be lost by navigating away / starting another edit. */
export function hasUnsavedText(state: BlockEditState): boolean {
  return state.phase !== 'idle' && state.text !== state.original;
}

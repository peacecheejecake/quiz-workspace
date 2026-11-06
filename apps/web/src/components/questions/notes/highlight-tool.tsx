'use client';

// HILITE-01 wiring of the shared highlight tool (design-system §5.2): the reader's highlight list
// of one place (`useHighlightStore`) and the `HighlightMenu` of a `HighlightableText` turned into
// my-highlights requests (`useHighlightTool`). The note body (ChapterNotePanel) and the
// explanation (QuestionViewer results and 문제 상세) use the same two kit components through
// this one module — no screen has its own copy of the menu logic.
import {
  HighlightMenu,
  useToast,
  type HighlightAction,
  type HighlightSelection,
  type TextHighlight,
} from '@quiz/ui';
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  createHighlight,
  deleteHighlight,
  HIGHLIGHT_FAILURE_MESSAGES,
  HighlightApiError,
  recolorHighlight,
  type HighlightTargetInput,
} from '@/lib/highlights/client';
import { HIGHLIGHT_TEXT, withCreated, withUpdated } from '@/lib/highlights/model';
import type { MyHighlight } from '@/lib/notes/model';
import { newIdempotencyKey } from '@/lib/workspaces/idempotency';

export type HighlightItems = readonly MyHighlight[];

/** The reader's highlights of one place: `undefined` while loading, null when the read failed. */
export interface HighlightStore {
  readonly items: HighlightItems | null | undefined;
  readonly update: (change: (items: HighlightItems) => HighlightItems) => void;
  /** Reads the list again (after a refused change, or `다시 시도`). */
  readonly reload: () => void;
}

/**
 * Reads `load` whenever `key` changes (or `reload` is called); a failure keeps null. The menu
 * works before the list arrives: a change is applied to the list on screen (an empty one while
 * loading or after a failed read), and a read that started before the latest change is not
 * applied — it would undo that change — but is made again.
 */
export function useHighlightStore(
  load: ((signal: AbortSignal) => Promise<HighlightItems>) | null,
  key: string,
): HighlightStore {
  const [items, setItems] = useState<HighlightItems | null | undefined>(undefined);
  const [round, setRound] = useState(0);
  // Bumped by every change: a read that started before the latest change is stale.
  const changes = useRef(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const enabled = load !== null;
  useEffect(() => {
    const read = loadRef.current;
    if (!enabled || !read) return undefined;
    const controller = new AbortController();
    const startedAt = changes.current;
    const stale = () => changes.current !== startedAt;
    read(controller.signal).then(
      (list) => {
        if (controller.signal.aborted) return;
        if (stale()) setRound((n) => n + 1);
        else setItems(list);
      },
      () => {
        if (controller.signal.aborted || stale()) return;
        setItems((prev) => (prev === undefined ? null : prev));
      },
    );
    return () => controller.abort();
  }, [enabled, key, round]);
  const update = useCallback((change: (items: HighlightItems) => HighlightItems) => {
    changes.current += 1;
    setItems((prev) => change(prev ?? []));
  }, []);
  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { items, update, reload };
}

/** Shows a refused highlight change as an error toast and reads the list again. */
export function useHighlightFailure(store: HighlightStore): (error: unknown) => void {
  const { toast } = useToast();
  const { reload } = store;
  return useCallback(
    (error: unknown) => {
      const kind = error instanceof HighlightApiError ? error.kind : 'failed';
      toast({ title: HIGHLIGHT_FAILURE_MESSAGES[kind], tone: 'error' });
      reload();
    },
    [toast, reload],
  );
}

export interface HighlightToolOptions {
  readonly store: HighlightStore;
  /** What the area draws (shown-text offsets), as `HighlightableText` gets it. */
  readonly drawn: readonly TextHighlight[];
  /** The API anchor of a shown range (note items: raw text with emphasis delimiters). */
  readonly toAnchor: (
    block: string,
    start: number,
    end: number,
  ) => { block: string; start: number; end: number } | null;
  readonly target: HighlightTargetInput;
  /** The `HighlightableText` (its `ref`); the menu returns focus there. */
  readonly areaRef: RefObject<HTMLDivElement | null>;
}

export interface HighlightTool {
  readonly onSelectRange: (selection: HighlightSelection | null) => void;
  /** The highlight whose menu is open, for `HighlightableText`. */
  readonly activeHighlightId: string | null;
  /** The `HighlightMenu`, rendered next to the area. */
  readonly menu: ReactNode;
}

export function useHighlightTool({
  store,
  drawn,
  toAnchor,
  target,
  areaRef,
}: HighlightToolOptions): HighlightTool {
  const [selection, setSelection] = useState<HighlightSelection | null>(null);
  // A refused change is said next to the area.
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const { update, reload } = store;
  const fail = (failure: unknown) => {
    const kind = failure instanceof HighlightApiError ? failure.kind : 'failed';
    setError(HIGHLIGHT_FAILURE_MESSAGES[kind]);
    reload();
  };
  const items = store.items ?? [];

  async function act(action: HighlightAction) {
    setError(null);
    try {
      if (action.type === 'create') {
        const anchor = toAnchor(action.block, action.start, action.end);
        if (!anchor) return;
        const created = await createHighlight(
          {
            target,
            anchor,
            color: action.color,
            ...(action.replaceIds.length > 0 ? { replace_ids: action.replaceIds } : {}),
          },
          newIdempotencyKey(),
        );
        update((list) => withCreated(list, created, action.replaceIds));
      } else if (action.type === 'recolor') {
        const current = items.find((h) => h.id === action.id);
        if (!current) return;
        const updated = await recolorHighlight(action.id, action.color, current.version);
        update((list) => withUpdated(list, updated));
      } else {
        await Promise.all(action.ids.map((id) => deleteHighlight(id)));
        update((list) => list.filter((h) => !action.ids.includes(h.id)));
      }
    } catch (error) {
      fail(error);
    }
  }

  const menu = (
    <>
      <HighlightMenu
        selection={selection}
        highlights={drawn}
        returnFocusTo={areaRef}
        onClose={() => setSelection(null)}
        onAction={(action) => void act(action)}
        onCopied={() => toast({ tone: 'success', title: HIGHLIGHT_TEXT.copied })}
      />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
  return {
    onSelectRange: setSelection,
    activeHighlightId: selection?.highlightId ?? null,
    menu,
  };
}

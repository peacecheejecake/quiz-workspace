'use client';

// HILITE-01 `내 하이라이트` of the note panel (docs/screens/highlights.md "`내 하이라이트` 영역"): the
// reader's own highlights of the chapter — the note versions' and the explanations of the
// chapter's questions — with `출처`·`색` filters (screen state, never in the URL), rows
// "<색> · 노트 · 버전 k" / "<색> · 해설 · <n>장 <번호>번" with the quote (3 lines, `더 보기`), an
// explanation row's footnote line (opens the question, with the preview), the "position lost"
// badge and a row menu: `위치로 이동` · `색 바꾸기` › 3 colors · `삭제` (no confirmation; a
// 10-second `되돌리기` toast, F8). There is no workspace-wide list (user decision C5). The note
// search (CHNOTE-02) looks into the explanation rows' quotes only: a note row's text is counted
// in the body already.
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  HIGHLIGHT_COLORS,
  highlightColorLabels,
  IconButton,
  MoreIcon,
  SearchMatchText,
  Skeleton,
  useToast,
  type HighlightColor,
  type TextMatch,
} from '@quiz/ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  deleteHighlight,
  HIGHLIGHT_FAILURE_MESSAGES,
  HighlightApiError,
  recolorHighlight,
  restoreHighlight,
} from '@/lib/highlights/client';
import {
  canGoTo,
  footnoteNumbers,
  HIGHLIGHT_TEXT,
  highlightFootnote,
  isNoteHighlight,
  matchesFilters,
  MAX_UNDO_TOASTS,
  orderRows,
  rowBadge,
  rowMeta,
  UNDO_TOAST_MS,
  withCreated,
  withUpdated,
  type ColorFilter,
  type SourceFilter,
} from '@/lib/highlights/model';
import type { MyHighlight } from '@/lib/notes/model';
import styles from './chapter-note.module.css';
import { useHighlightFailure, type HighlightStore } from './highlight-tool';

/** Kept for callers of the UX9-NOTE-W names. */
export const MY_HIGHLIGHTS_TEXT = HIGHLIGHT_TEXT;

/** Search block id of an explanation highlight row's quote. */
export function highlightRowBlock(id: string): string {
  return `hl:${id}`;
}

/** Whether the note search looks into this row (explanation highlights only). */
export function searchesRow(h: MyHighlight): boolean {
  return !isNoteHighlight(h);
}

/** A quote longer than this starts folded to 3 lines with `더 보기`. */
const LONG_QUOTE = 120;

export interface MyHighlightsSectionProps {
  readonly store: HighlightStore;
  /** Search results in a row's quote (block `highlightRowBlock(id)`). */
  readonly matchesOf: (block: string) => readonly TextMatch[];
  /** `위치로 이동`; `trigger` (the row's menu button) gets focus back from a dialog. */
  readonly onGoTo: (h: MyHighlight, trigger: HTMLElement | null) => void;
  /** An explanation row's footnote line as a link to its question (with the preview). */
  readonly renderFootnote: (h: MyHighlight, line: ReactNode) => ReactNode;
  /**
   * The `출처`·`색` filters, kept by the parent: the note search counts only the explanation rows
   * they show (a hidden row's quote is not a result one could go to).
   */
  readonly filters: HighlightFilters;
  readonly onFiltersChange: (filters: HighlightFilters) => void;
}

export interface HighlightFilters {
  readonly source: SourceFilter;
  readonly color: ColorFilter;
}

type FocusAfter = { readonly kind: 'row'; readonly id: string } | { readonly kind: 'heading' };

export function MyHighlightsSection({
  store,
  matchesOf,
  onGoTo,
  renderFootnote,
  filters,
  onFiltersChange,
}: MyHighlightsSectionProps) {
  const titleId = useId();
  const sourceId = useId();
  const colorId = useId();
  const { source, color } = filters;
  const setSource = (next: SourceFilter) => onFiltersChange({ ...filters, source: next });
  const setColor = (next: ColorFilter) => onFiltersChange({ ...filters, color: next });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // Where focus goes once a deleted row is gone from the list.
  const focusAfter = useRef<FocusAfter | null>(null);
  const { toast, dismiss } = useToast();
  const undoToasts = useRef<number[]>([]);
  const fail = useHighlightFailure(store);
  const { items, update, reload } = store;

  const rows = orderRows(items ?? []);
  const numbers = footnoteNumbers(rows);
  const visible = rows.filter((h) => matchesFilters(h, source, color));

  useEffect(() => {
    const after = focusAfter.current;
    if (!after) return;
    focusAfter.current = null;
    const target = after.kind === 'row' ? buttons.current.get(after.id) : headingRef.current;
    target?.focus();
  }, [items]);

  async function recolor(h: MyHighlight, next: HighlightColor) {
    if (next === h.color) return;
    try {
      const updated = await recolorHighlight(h.id, next, h.version);
      update((list) => withUpdated(list, updated));
    } catch (error) {
      fail(error);
    }
  }

  async function undo(h: MyHighlight) {
    try {
      const restored = await restoreHighlight(h.id);
      update((list) => withCreated(list, restored, []));
      reload();
    } catch (error) {
      const kind = error instanceof HighlightApiError ? error.kind : 'failed';
      toast({ title: HIGHLIGHT_FAILURE_MESSAGES[kind], tone: 'error' });
      reload();
    }
  }

  async function remove(h: MyHighlight) {
    // Focus moves to the next row's menu button (else the previous one, else the heading).
    const at = visible.findIndex((x) => x.id === h.id);
    const next = visible[at + 1] ?? visible[at - 1];
    focusAfter.current = next ? { kind: 'row', id: next.id } : { kind: 'heading' };
    update((list) => list.filter((x) => x.id !== h.id));
    try {
      await deleteHighlight(h.id);
    } catch (error) {
      if (!(error instanceof HighlightApiError && error.kind === 'gone')) {
        fail(error);
        return;
      }
    }
    // One toast per deletion, at most three at once: a fourth closes the oldest (its undo is gone).
    const id = toast({
      title: HIGHLIGHT_TEXT.deleted,
      tone: 'neutral',
      duration: UNDO_TOAST_MS,
      action: {
        label: HIGHLIGHT_TEXT.undo,
        altText: HIGHLIGHT_TEXT.undoHint,
        onClick: () => {
          undoToasts.current = undoToasts.current.filter((t) => t !== id);
          void undo(h);
        },
      },
    });
    undoToasts.current = [...undoToasts.current, id];
    while (undoToasts.current.length > MAX_UNDO_TOASTS) {
      const oldest = undoToasts.current.shift();
      if (oldest !== undefined) dismiss(oldest);
    }
  }

  const chip = (pressed: boolean, onPress: () => void, label: string, swatch?: HighlightColor) => (
    <Button
      key={label}
      size="sm"
      variant="ghost"
      aria-pressed={pressed}
      className={styles.chip}
      onClick={onPress}
    >
      {swatch ? (
        <span className={styles.swatch} data-highlight-color={swatch} aria-hidden="true" />
      ) : null}
      {label}
    </Button>
  );

  return (
    <section className={styles.myHighlights} aria-labelledby={titleId}>
      <h3 id={titleId} ref={headingRef} tabIndex={-1} className={styles.heading}>
        {items ? `${HIGHLIGHT_TEXT.title} (${items.length})` : HIGHLIGHT_TEXT.title}
      </h3>
      <p className={styles.hint}>{HIGHLIGHT_TEXT.onlyMine}</p>
      {items === undefined ? (
        <div aria-busy="true">
          <Skeleton width="60%" />
        </div>
      ) : items === null ? (
        <div className={styles.state} role="alert">
          <p className={styles.note}>{HIGHLIGHT_TEXT.failed}</p>
          <Button size="sm" onClick={reload}>
            {HIGHLIGHT_TEXT.retry}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className={styles.note}>{HIGHLIGHT_TEXT.empty}</p>
      ) : (
        <>
          <div className={styles.filters}>
            <div role="group" aria-labelledby={sourceId} className={styles.chips}>
              <span id={sourceId} className={styles.filterLabel}>
                {HIGHLIGHT_TEXT.source}
              </span>
              {chip(source === 'all', () => setSource('all'), HIGHLIGHT_TEXT.all)}
              {chip(source === 'note', () => setSource('note'), HIGHLIGHT_TEXT.note)}
              {chip(
                source === 'explanation',
                () => setSource('explanation'),
                HIGHLIGHT_TEXT.explanation,
              )}
            </div>
            <div role="group" aria-labelledby={colorId} className={styles.chips}>
              <span id={colorId} className={styles.filterLabel}>
                {HIGHLIGHT_TEXT.color}
              </span>
              {chip(color === 'all', () => setColor('all'), HIGHLIGHT_TEXT.all)}
              {HIGHLIGHT_COLORS.map((c) =>
                chip(color === c, () => setColor(c), highlightColorLabels[c], c),
              )}
            </div>
          </div>
          {visible.length === 0 ? (
            <p className={styles.note}>{HIGHLIGHT_TEXT.filteredEmpty}</p>
          ) : (
            <ul className={styles.highlightRows} aria-label={HIGHLIGHT_TEXT.list}>
              {visible.map((h) => {
                const k = numbers.get(h.id);
                const rowMatches = searchesRow(h) ? matchesOf(highlightRowBlock(h.id)) : [];
                const long = h.quote.length > LONG_QUOTE;
                const open = !long || expanded.has(h.id) || rowMatches.length > 0;
                const badge = rowBadge(h);
                return (
                  <li key={h.id} className={styles.highlightRow}>
                    <div className={styles.highlightHead}>
                      <span className={styles.highlightMeta}>
                        <span
                          className={styles.swatch}
                          data-highlight-color={h.color}
                          aria-hidden="true"
                        />
                        {rowMeta(h)}
                      </span>
                      <RowMenu
                        h={h}
                        buttonRef={(el) => {
                          if (el) buttons.current.set(h.id, el);
                          else buttons.current.delete(h.id);
                        }}
                        onGoTo={(trigger) => onGoTo(h, trigger)}
                        onRecolor={(c) => void recolor(h, c)}
                        onDelete={() => void remove(h)}
                      />
                    </div>
                    <p
                      className={styles.highlightQuote}
                      data-highlight-row-color={h.color}
                      data-folded={open ? undefined : ''}
                    >
                      {searchesRow(h) ? (
                        <SearchMatchText text={h.quote} matches={rowMatches} />
                      ) : (
                        h.quote
                      )}
                      {k !== undefined ? <sup className={styles.rowRef}>{` [h${k}]`}</sup> : null}
                    </p>
                    {long && rowMatches.length === 0 ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className={styles.more}
                        aria-expanded={open}
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(h.id)) next.delete(h.id);
                            else next.add(h.id);
                            return next;
                          })
                        }
                      >
                        {open ? HIGHLIGHT_TEXT.less : HIGHLIGHT_TEXT.more}
                      </Button>
                    ) : null}
                    {badge ? <Badge tone="warning">{badge}</Badge> : null}
                    {k !== undefined ? (
                      <p className={styles.rowFootnote}>
                        {renderFootnote(h, highlightFootnote(h, k))}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function RowMenu({
  h,
  buttonRef,
  onGoTo,
  onRecolor,
  onDelete,
}: {
  readonly h: MyHighlight;
  readonly buttonRef: (el: HTMLButtonElement | null) => void;
  readonly onGoTo: (trigger: HTMLElement | null) => void;
  readonly onRecolor: (color: HighlightColor) => void;
  readonly onDelete: () => void;
}) {
  const reasonId = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const reachable = canGoTo(h);
  // Actions run once the menu has handed focus back to its button.
  const later = (action: () => void) => () => window.setTimeout(action, 0);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton
          ref={(el) => {
            trigger.current = el;
            buttonRef(el);
          }}
          label={HIGHLIGHT_TEXT.menu}
          icon={<MoreIcon />}
          size="sm"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={HIGHLIGHT_TEXT.menu}>
        <DropdownMenuItem
          disabled={!reachable}
          aria-describedby={reachable ? undefined : reasonId}
          onSelect={() => window.setTimeout(() => onGoTo(trigger.current), 0)}
        >
          {HIGHLIGHT_TEXT.goto}
        </DropdownMenuItem>
        {reachable ? null : (
          <DropdownMenuLabel id={reasonId}>{HIGHLIGHT_TEXT.gotoMissing}</DropdownMenuLabel>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{HIGHLIGHT_TEXT.recolor}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label={HIGHLIGHT_TEXT.recolor}>
            <DropdownMenuRadioGroup
              value={h.color}
              onValueChange={(value) => onRecolor(value as HighlightColor)}
            >
              {HIGHLIGHT_COLORS.map((c) => (
                <DropdownMenuRadioItem key={c} value={c}>
                  {highlightColorLabels[c]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="danger" onSelect={later(onDelete)}>
          {HIGHLIGHT_TEXT.delete}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

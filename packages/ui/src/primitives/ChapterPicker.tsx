'use client';

import { mediaQueries } from '@quiz/design-tokens';
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from '../internal/cx';
import { FieldFrame, useFieldIds, type FieldOwnProps } from './Field';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from './icons';
import { Input } from './Input';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';
import {
  buildChapterTree,
  initialExpanded,
  isFiltering,
  visibleRows,
  type ChapterPickerNode,
  type ChapterPickerOption,
  type VisibleRow,
} from './chapter-tree';

export type { ChapterPickerNode, ChapterPickerOption } from './chapter-tree';

export interface ChapterPickerProps extends Omit<FieldOwnProps, 'label'> {
  /** Names the trigger, the popover and the tree. */
  label: string;
  /** The chapters in pre-order. Share one array between pickers over the same outline. */
  nodes: readonly ChapterPickerNode[];
  /** Fixed top-level choices above the tree (`전체 챕터`, `챕터 없음`). */
  leading?: readonly ChapterPickerOption[];
  /** The chosen value; `''` shows `placeholder`. */
  value: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Name of the filter box. */
  filterLabel?: string;
  emptyText?: string;
  /** Class for the field wrapper (label + control + messages). */
  fieldClassName?: string;
  id?: string;
  'aria-describedby'?: string;
}

const isSheet = () =>
  typeof window.matchMedia === 'function' && window.matchMedia(mediaQueries.mobile).matches;

const TREE_ROW = '[role="treeitem"]';
const NO_OPTIONS: readonly ChapterPickerOption[] = [];

/** The tree, mounted only while the popover is open: a closed picker costs one button. */
function ChapterTree({
  label,
  nodes,
  leading,
  value,
  filterLabel,
  emptyText,
  onChoose,
}: {
  readonly label: string;
  readonly nodes: readonly ChapterPickerNode[];
  readonly leading: readonly ChapterPickerOption[];
  readonly value: string;
  readonly filterLabel: string;
  readonly emptyText: string;
  readonly onChoose: (value: string) => void;
}) {
  const rows = useMemo(() => buildChapterTree(nodes, leading), [nodes, leading]);
  // What the user changed, over a default that follows `nodes`: an outline that arrives while the
  // popover is open (the question editor loads it) still opens its groups.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const expanded = useMemo(() => {
    const initial = initialExpanded(rows, value);
    return new Set(
      [...initial, ...toggled].filter((item) => initial.has(item) !== toggled.has(item)),
    );
  }, [rows, value, toggled]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const filtering = isFiltering(query);
  const shown = useMemo(() => visibleRows(rows, expanded, query), [rows, expanded, query]);
  const tabStop =
    shown.find((item) => item.row.node.value === active) ??
    shown.find((item) => item.row.node.value === value) ??
    shown[0];

  // The list opens on the chosen row. `scrollTop`, not scrollIntoView: the popper has no position yet.
  useLayoutEffect(() => {
    const list = treeRef.current;
    const row = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (list && row) list.scrollTop = row.offsetTop - (list.clientHeight - row.offsetHeight) / 2;
    // Only when it opens.
  }, []);

  function focusRow(position: number) {
    const target = treeRef.current?.querySelectorAll<HTMLElement>(TREE_ROW)[position];
    target?.focus();
  }

  function toggle(rowValue: string) {
    setToggled((current) => {
      const next = new Set(current);
      if (!next.delete(rowValue)) next.add(rowValue);
      return next;
    });
  }

  function activate(item: VisibleRow) {
    if (!item.row.node.group) onChoose(item.row.node.value);
    else if (!filtering) toggle(item.row.node.value);
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLLIElement>, position: number) {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const item = shown[position] as VisibleRow;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case 'ArrowDown':
        handled();
        focusRow(Math.min(position + 1, shown.length - 1));
        return;
      case 'ArrowUp':
        handled();
        if (position === 0) filterRef.current?.focus();
        else focusRow(position - 1);
        return;
      case 'Home':
        handled();
        focusRow(0);
        return;
      case 'End':
        handled();
        focusRow(shown.length - 1);
        return;
      case 'ArrowRight':
        handled();
        if (!item.parent) return;
        if (!item.expanded) toggle(item.row.node.value);
        else focusRow(position + 1);
        return;
      case 'ArrowLeft': {
        handled();
        if (item.expanded && !filtering) {
          toggle(item.row.node.value);
          return;
        }
        const parent = shown.findIndex((other) => other.index === item.row.parent);
        if (parent >= 0) focusRow(parent);
        return;
      }
      case 'Enter':
      case ' ':
        handled();
        activate(item);
        return;
      default:
        // Typing carries on in the filter box, which receives this very key.
        if (event.key.length === 1 && !event.shiftKey) filterRef.current?.focus();
    }
  }

  function onFilterKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      treeRef.current?.querySelector<HTMLElement>(`${TREE_ROW}[tabindex="0"]`)?.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const first = shown.find((item) => item.matched);
      if (first) onChoose(first.row.node.value);
    }
  }

  return (
    <>
      <Input
        ref={filterRef}
        type="search"
        label={filterLabel}
        hideLabel
        placeholder={filterLabel}
        autoComplete="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onFilterKeyDown}
        fieldClassName="filter"
      />
      {shown.length === 0 ? (
        <p role="status" className="empty">
          {emptyText}
        </p>
      ) : (
        <ul ref={treeRef} role="tree" aria-label={label} className="tree">
          {shown.map((item, position) => {
            const { node, depth } = item.row;
            const selected = !node.group && node.value === value;
            return (
              <li
                key={node.value}
                id={`${baseId}-${item.index}`}
                role="treeitem"
                aria-label={node.label}
                aria-level={depth}
                aria-posinset={item.position}
                aria-setsize={item.setSize}
                aria-selected={node.group ? undefined : selected}
                aria-expanded={item.parent ? item.expanded : undefined}
                data-value={node.value}
                data-group={node.group || undefined}
                tabIndex={item === tabStop ? 0 : -1}
                className="row"
                style={{ paddingInlineStart: `calc(var(--space-4) * ${depth - 1})` }}
                onFocus={(event) => {
                  if (event.target === event.currentTarget) setActive(node.value);
                }}
                onClick={() => activate(item)}
                onKeyDown={(event) => onRowKeyDown(event, position)}
              >
                {item.parent && !filtering ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    className="toggle"
                    aria-label={`${node.label} ${item.expanded ? '접기' : '펼치기'}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggle(node.value);
                    }}
                  >
                    {item.expanded ? (
                      <ChevronDownIcon width={16} height={16} />
                    ) : (
                      <ChevronRightIcon width={16} height={16} />
                    )}
                  </button>
                ) : (
                  <span className="spacer" />
                )}
                <span className="title">{node.label}</span>
                {selected ? <CheckIcon width={16} height={16} className="check" /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/**
 * Single chapter choice as a tree in a kit `Popover` (docs/screens/ux12-chapter-picker.md): the
 * trigger looks like `Select` and is a `combobox`, the popover holds a filter box and a `tree` with
 * expand/collapse and the full keyboard pattern; below 768px it is a bottom sheet. The content
 * renders only while open, so a page can hold hundreds of pickers over a long outline
 * (QIMP-REVIEW-SCALE: pass them one shared `nodes` array).
 */
export function ChapterPicker({
  label,
  hideLabel,
  description,
  error,
  nodes,
  leading = NO_OPTIONS,
  value,
  onValueChange,
  placeholder,
  disabled,
  filterLabel = '챕터 찾기',
  emptyText = '찾는 챕터가 없습니다',
  fieldClassName,
  id,
  'aria-describedby': ariaDescribedBy,
}: ChapterPickerProps) {
  const [open, setOpen] = useState(false);
  const ids = useFieldIds(id, description, error, ariaDescribedBy);
  const labelId = `${ids.id}-label`;
  const node = nodes.find((candidate) => candidate.value === value);
  const chosen =
    leading.find((option) => option.value === value)?.label ?? node?.triggerLabel ?? node?.label;
  return (
    <FieldFrame
      ids={ids}
      labelId={labelId}
      label={label}
      hideLabel={hideLabel}
      description={description}
      error={error}
      className={fieldClassName}
    >
      {/* Modal like the `Select` it replaces: a tap outside closes the sheet without pressing what
          is under it. */}
      <Popover modal open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          id={ids.id}
          role="combobox"
          aria-labelledby={labelId}
          aria-describedby={ids.describedBy}
          aria-invalid={ids.hasError || undefined}
          aria-errormessage={ids.hasError ? ids.errorId : undefined}
          disabled={disabled}
          data-placeholder={chosen === undefined ? '' : undefined}
          className={cx('qz-control', 'qz-select', 'qz-focus-ring')}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          <span className="value">{chosen ?? placeholder}</span>
          <span className="icon">
            <ChevronDownIcon width={18} height={18} />
          </span>
        </PopoverTrigger>
        <PopoverContent
          aria-label={label}
          align="start"
          sideOffset={4}
          collisionPadding={16}
          closeLabel={`${label} 닫기`}
          className="qz-chapter-picker"
          onOpenAutoFocus={(event) => {
            if (!isSheet()) return;
            // The filter box would raise the on-screen keyboard over the sheet.
            event.preventDefault();
            const content = event.currentTarget as HTMLElement;
            content
              .querySelector<HTMLElement>(`${TREE_ROW}[tabindex="0"]`)
              ?.focus({ preventScroll: true });
          }}
        >
          <ChapterTree
            label={label}
            nodes={nodes}
            leading={leading}
            value={value}
            filterLabel={filterLabel}
            emptyText={emptyText}
            onChoose={(next) => {
              setOpen(false);
              if (next !== value) onValueChange?.(next);
            }}
          />
        </PopoverContent>
      </Popover>
    </FieldFrame>
  );
}

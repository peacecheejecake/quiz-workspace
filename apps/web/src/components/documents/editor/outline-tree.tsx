'use client';

// DocumentOutlineTree (DOC-02-AC01): chapters and sections as a WAI-ARIA tree. Rendered flat
// (aria-level/posinset/setsize) so a parent's row never contains its children; one tab stop
// (roving tabindex); Up/Down move, Right/Left expand/collapse or move to child/parent, Home/End,
// Enter/Space (or a click) go to the section's PDF page and first text block.
// A click also opens a closed section; clicking the current, open section closes it.
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { OutlineItem } from '@/lib/documents/editor-api';
import { ancestorsOf, visibleOutlineRows } from '@/lib/documents/outline';
import styles from './editor.module.css';

export interface OutlineTreeProps {
  readonly items: readonly OutlineItem[];
  /** Section of the current block (aria-selected). */
  readonly currentId: string | null;
  readonly onNavigate: (node: OutlineItem) => void;
}

export function OutlineTree({ items, currentId, onNavigate }: OutlineTreeProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLLIElement>());
  const rows = useMemo(() => visibleOutlineRows(items, collapsed), [items, collapsed]);

  // Keep the path to the current section open (adjusted while rendering, not in an effect).
  const [revealed, setRevealed] = useState<string | null>(null);
  if (currentId !== revealed) {
    setRevealed(currentId);
    const path = currentId ? ancestorsOf(currentId, items) : [];
    if (path.some((id) => collapsed.has(id))) {
      const next = new Set(collapsed);
      for (const id of path) next.delete(id);
      setCollapsed(next);
    }
  }

  const tabStop =
    rows.find((r) => r.node.id === focusId)?.node.id ??
    rows.find((r) => r.node.id === currentId)?.node.id ??
    rows[0]?.node.id;

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setFocusId(id);
    refs.current.get(id)?.focus();
  };

  const toggle = (id: string, open: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, index: number) => {
    const row = rows[index];
    if (!row) return;
    const expanded = row.hasChildren && !collapsed.has(row.node.id);
    switch (event.key) {
      case 'ArrowDown':
        focusRow(rows[index + 1]?.node.id);
        break;
      case 'ArrowUp':
        focusRow(rows[index - 1]?.node.id);
        break;
      case 'Home':
        focusRow(rows[0]?.node.id);
        break;
      case 'End':
        focusRow(rows[rows.length - 1]?.node.id);
        break;
      case 'ArrowRight':
        if (row.hasChildren && !expanded) toggle(row.node.id, true);
        else if (expanded) focusRow(rows[index + 1]?.node.id);
        break;
      case 'ArrowLeft':
        if (expanded) toggle(row.node.id, false);
        else if (row.parentId) focusRow(row.parentId);
        break;
      case 'Enter':
      case ' ':
        onNavigate(row.node);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  if (items.length === 0) {
    return <p className={styles.paneNote}>이 문서에는 목차가 없습니다.</p>;
  }

  return (
    <ul role="tree" aria-label="목차" className={styles.tree}>
      {rows.map((row, index) => {
        const expanded = row.hasChildren ? !collapsed.has(row.node.id) : undefined;
        const selected = row.node.id === currentId;
        return (
          <li
            key={row.node.id}
            ref={(el) => {
              if (el) refs.current.set(row.node.id, el);
              else refs.current.delete(row.node.id);
            }}
            role="treeitem"
            aria-label={row.node.title}
            aria-level={row.depth}
            aria-posinset={row.position}
            aria-setsize={row.siblings}
            aria-expanded={expanded}
            aria-selected={selected}
            tabIndex={row.node.id === tabStop ? 0 : -1}
            className={styles.treeItem}
            data-selected={selected || undefined}
            style={{ paddingInlineStart: `calc(var(--space-3) * ${row.depth})` }}
            onClick={() => {
              setFocusId(row.node.id);
              // Pointer parity with Right/Left: a click opens a closed section, and a second click
              // on the current one closes it.
              if (row.hasChildren && (!expanded || selected)) toggle(row.node.id, !expanded);
              onNavigate(row.node);
            }}
            onFocus={() => setFocusId(row.node.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {row.hasChildren ? (
              <span
                className={styles.treeToggle}
                aria-hidden="true"
                data-expanded={expanded || undefined}
              >
                ▸
              </span>
            ) : (
              <span className={styles.treeToggle} aria-hidden="true" />
            )}
            <span className={styles.treeTitle}>{row.node.title}</span>
            {row.node.page != null ? (
              <span className={styles.treePage} aria-hidden="true">
                {row.node.page}쪽
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

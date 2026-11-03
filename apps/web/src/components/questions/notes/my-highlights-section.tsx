'use client';

// HILITE-01 `내 하이라이트` of the note panel, read-only for now: the reader's own highlights of the
// chapter (note versions and explanations) as rows "<색> · 노트 · 버전 k" / "<색> · 해설 · <n>장
// <번호>번" with the quote. Search results of the note search (CHNOTE-02) are drawn in the
// explanation rows' quotes only; a note row's text is already counted in the body. Filters, row
// menus and the explanation footnotes come with UX9-HL-W.
import { highlightColorLabels, SearchMatchText, type TextMatch } from '@quiz/ui';
import { useId } from 'react';
import type { MyHighlight } from '@/lib/notes/model';
import styles from './chapter-note.module.css';

export const MY_HIGHLIGHTS_TEXT = {
  title: '내 하이라이트',
  onlyMine: '나에게만 보입니다.',
  list: '내 하이라이트 목록',
  empty: '아직 하이라이트가 없습니다. 노트나 문제 해설에서 글자를 고르면 여기에 모입니다.',
  failed: '내 하이라이트를 불러오지 못했습니다.',
} as const;

/** Search block id of an explanation highlight row's quote. */
export function highlightRowBlock(id: string): string {
  return `hl:${id}`;
}

/** Whether the note search looks into this row (explanation highlights only). */
export function searchesRow(h: MyHighlight): boolean {
  return h.target.kind !== 'note';
}

function rowMeta(h: MyHighlight): string {
  const color = highlightColorLabels[h.color];
  if (h.target.kind === 'note') return `${color} · 노트 · 버전 ${h.target.note_version}`;
  return `${color} · 해설 · ${h.question?.number_label ?? ''}`.trimEnd();
}

export interface MyHighlightsSectionProps {
  /** null: the list could not be read. */
  readonly items: readonly MyHighlight[] | null;
  /** Search results in a row's quote (block `highlightRowBlock(id)`). */
  readonly matchesOf: (block: string) => readonly TextMatch[];
}

export function MyHighlightsSection({ items, matchesOf }: MyHighlightsSectionProps) {
  const titleId = useId();
  return (
    <section className={styles.myHighlights} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.heading}>
        {`${MY_HIGHLIGHTS_TEXT.title} (${items?.length ?? 0})`}
      </h3>
      <p className={styles.hint}>{MY_HIGHLIGHTS_TEXT.onlyMine}</p>
      {items === null ? (
        <p className={styles.note}>{MY_HIGHLIGHTS_TEXT.failed}</p>
      ) : items.length === 0 ? (
        <p className={styles.note}>{MY_HIGHLIGHTS_TEXT.empty}</p>
      ) : (
        <ul className={styles.highlightRows} aria-label={MY_HIGHLIGHTS_TEXT.list}>
          {items.map((h) => (
            <li key={h.id} className={styles.highlightRow}>
              <span className={styles.highlightMeta}>{rowMeta(h)}</span>
              <span className={styles.highlightQuote} data-highlight-row-color={h.color}>
                {searchesRow(h) ? (
                  <SearchMatchText text={h.quote} matches={matchesOf(highlightRowBlock(h.id))} />
                ) : (
                  h.quote
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

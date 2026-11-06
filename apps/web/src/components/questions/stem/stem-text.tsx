// STEM-ITEMS (docs/questions.md §4 item 11, QPLAY-01-AC14): the one rendering of a whole stem
// with its labelled items in a 제시 항목 box, shared by every screen that shows the full stem
// (QuestionStem, draft review, source compare, mock question dialog, document question card).
// One-line previews keep collapsing whitespace and do not use it. Pipe tables in a stem show as
// tables in place (QTABLE-01); malformed ones stay text.
import { Fragment } from 'react';
import { displayStem } from '@/lib/questions/display-stem';
import {
  stemItems,
  stemPassageParagraphs,
  type StemItem,
  type StemLayout,
} from '@/lib/questions/stem-items';
import { stemSegments, type PipeTable } from '@/lib/questions/stem-table';
import tableStyles from '@/components/shared/printed-table.module.css';
import styles from './stem-text.module.css';

/** The item list: named 제시 항목 (apart from the 보기 option list), labels as printed. */
export function StemItemList({ items }: { readonly items: readonly StemItem[] }) {
  return (
    // role="list" keeps list semantics in WebKit despite `list-style: none`.
    // eslint-disable-next-line jsx-a11y/no-redundant-roles
    <ul role="list" className={styles.items} aria-label="제시 항목">
      {items.map((item, i) => (
        <li key={i} className={styles.item}>
          <span>{item.label}</span> <span className={styles.text}>{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

function LayoutBlocks({ layout }: { readonly layout: StemLayout }) {
  return (
    <>
      {layout.lead.map((paragraph, i) => (
        <p key={`lead-${i}`}>{paragraph}</p>
      ))}
      <StemItemList items={layout.items} />
      {layout.trailing.map((paragraph, i) => (
        <p key={`trailing-${i}`}>{paragraph}</p>
      ))}
    </>
  );
}

/** A printed table scrolling inside its own focusable region on a narrow screen. */
function StemTable({ table }: { readonly table: PipeTable }) {
  return (
    // A keyboard user scrolls the region, so it takes focus.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div role="region" aria-label="표" tabIndex={0} className={tableStyles.tableScroll}>
      <table className={tableStyles.table}>
        <thead>
          <tr>
            {table.header.map((cell, c) =>
              // Table rows and cells have no ids; their position is their identity.
              cell === '' ? (
                <td key={c} />
              ) : (
                <th key={c} scope="col">
                  {cell}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Text without a table: one paragraph per blank-line block, or the item box and its text. */
function TextBlocks({ text }: { readonly text: string }) {
  const layout = stemItems(text);
  if (layout) return <LayoutBlocks layout={layout} />;
  return (
    <>
      {stemPassageParagraphs(text).map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
    </>
  );
}

/**
 * The displayed stem as blocks for a container that spaces them (QuestionStem): one paragraph per
 * blank-line block, or the question paragraphs, the item box and the paragraphs after it, with
 * printed tables in place.
 */
export function StemBlocks({ stem }: { readonly stem: string }) {
  const segments = stemSegments(stem);
  if (!segments.some((segment) => segment.kind === 'table')) return <TextBlocks text={stem} />;
  return (
    <>
      {segments.map((segment, i) => (
        <Fragment key={i}>
          {segment.kind === 'table' ? (
            <StemTable table={segment.table} />
          ) : (
            <TextBlocks text={segment.text} />
          )}
        </Fragment>
      ))}
    </>
  );
}

/**
 * A whole stem in a host's own text class: one paragraph as before when it has no items,
 * otherwise a block with the question paragraph, the item box and the paragraphs after it.
 */
export function StemText({
  stem,
  className,
}: {
  readonly stem: string;
  readonly className?: string;
}) {
  const blocks = (
    <div className={className ? `${className} ${styles.stem}` : styles.stem}>
      <StemBlocks stem={stem} />
    </div>
  );
  if (stemItems(stem) || stemSegments(stem).some((segment) => segment.kind === 'table')) {
    return blocks;
  }
  if (stemPassageParagraphs(stem).length === 1) {
    return <p className={className}>{displayStem(stem)}</p>;
  }
  return blocks;
}

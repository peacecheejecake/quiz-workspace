// STEM-ITEMS (docs/questions.md §4 item 11, QPLAY-01-AC14): the one rendering of a whole stem
// with its labelled items in a 제시 항목 box, shared by every screen that shows the full stem
// (QuestionStem, draft review, source compare, mock question dialog, document question card).
// One-line previews keep collapsing whitespace and do not use it. Pipe tables in a stem show as
// tables in place (QTABLE-01); malformed ones stay text. <제목> passages show in their own boxes
// (UX12-PASSAGE).
import { Fragment, useId } from 'react';
import { displayStem } from '@/lib/questions/display-stem';
import {
  stemItems,
  stemPassageParagraphs,
  type StemItem,
  type StemLayout,
} from '@/lib/questions/stem-items';
import {
  stemPassageLayout,
  type StemPassage,
  type StemPassageLayout,
} from '@/lib/questions/stem-passages';
import { tableGrid } from '@/lib/documents/table-grid';
import { stemSegments, type PipeTable } from '@/lib/questions/stem-table';
import {
  alignedStemTables,
  type StemCells,
  type StemTables,
} from '@/lib/questions/stem-table-edit';
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

/** One passage's box: its heading as printed, then its text and item lines. */
function StemPassageBox({ passage }: { readonly passage: StemPassage }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={styles.passage}>
      <h3 id={headingId} className={styles.passageHeading}>
        {passage.heading}
      </h3>
      {passage.intro !== '' && <p className={styles.passageIntro}>{passage.intro}</p>}
      {passage.lines.length > 0 && (
        // eslint-disable-next-line jsx-a11y/no-redundant-roles
        <ul role="list" className={styles.lines}>
          {passage.lines.map((line, i) => (
            <li key={i} className={styles.line}>
              <span>{line.marker}</span> <span className={styles.text}>{line.text}</span>
              {line.subs.length > 0 && (
                // eslint-disable-next-line jsx-a11y/no-redundant-roles
                <ul role="list" className={styles.subs}>
                  {line.subs.map((sub, s) => (
                    <li key={s} className={styles.line}>
                      <span>{sub.marker}</span> <span className={styles.text}>{sub.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PassageBlocks({ layout }: { readonly layout: StemPassageLayout }) {
  return (
    <>
      {layout.lead.map((paragraph, i) => {
        // Text after an earlier passage can open with its item list.
        const items = stemItems(paragraph);
        if (items) return <LayoutBlocks key={`lead-${i}`} layout={items} />;
        return <p key={`lead-${i}`}>{paragraph}</p>;
      })}
      {layout.passages.map((passage, i) => (
        <StemPassageBox key={i} passage={passage} />
      ))}
      {layout.rest !== '' && <TextBlocks text={layout.rest} />}
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

/**
 * A table with its structured cells (UX12-STEMTABLE): merged cells once. Header cells stay column
 * headers, covering every column they span; the first row is one even if the parser marked no
 * header, as in the GFM this replaces. One body: a span may cross from the header into the rows.
 */
function StructuredStemTable({ table }: { readonly table: StemCells }) {
  const headerRows = Math.max(table.header_rows, 1);
  return (
    // A keyboard user scrolls the region, so it takes focus.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div role="region" aria-label="표" tabIndex={0} className={tableStyles.tableScroll}>
      <table className={tableStyles.table}>
        <tbody>
          {tableGrid(table).map((row, r) => (
            // Table rows and cells have no ids; their position is their identity.
            <tr key={r}>
              {row.map(({ col, text, rowSpan, colSpan }) =>
                r < headerRows && text !== '' ? (
                  <th key={col} scope="col" rowSpan={rowSpan} colSpan={colSpan}>
                    {text}
                  </th>
                ) : (
                  <td key={col} rowSpan={rowSpan} colSpan={colSpan}>
                    {text}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PrintedStemTable({
  table,
  cells,
}: {
  readonly table: PipeTable;
  readonly cells: StemCells | null | undefined;
}) {
  return cells ? <StructuredStemTable table={cells} /> : <StemTable table={table} />;
}

/** Text without a table: one paragraph per blank-line block, or the item box and its text. */
function TextBlocks({
  text,
  afterTable = false,
}: {
  readonly text: string;
  readonly afterTable?: boolean;
}) {
  const passages = stemPassageLayout(text, { afterTable });
  if (passages) return <PassageBlocks layout={passages} />;
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
 * blank-line block, or the question paragraphs, the passage boxes, the item box and the paragraphs
 * after it, with printed tables in place.
 */
export function StemBlocks({
  stem,
  stemTables,
}: {
  readonly stem: string;
  readonly stemTables?: StemTables;
}) {
  const segments = stemSegments(stem);
  if (!segments.some((segment) => segment.kind === 'table')) return <TextBlocks text={stem} />;
  const cells = alignedStemTables(stem, stemTables);
  const tablesBefore = (end: number) =>
    segments.slice(0, end).filter((segment) => segment.kind === 'table').length;
  return (
    <>
      {segments.map((segment, i) => (
        <Fragment key={i}>
          {segment.kind === 'table' ? (
            <PrintedStemTable table={segment.table} cells={cells?.[tablesBefore(i)]} />
          ) : (
            <TextBlocks text={segment.text} afterTable={tablesBefore(i) > 0} />
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
  stemTables,
  className,
}: {
  readonly stem: string;
  readonly stemTables?: StemTables;
  readonly className?: string;
}) {
  const blocks = (
    <div className={className ? `${className} ${styles.stem}` : styles.stem}>
      <StemBlocks stem={stem} stemTables={stemTables} />
    </div>
  );
  const table = stemSegments(stem).some((segment) => segment.kind === 'table');
  if (table || stemItems(stem) || stemPassageLayout(stem)) {
    return blocks;
  }
  if (stemPassageParagraphs(stem).length === 1) {
    return <p className={className}>{displayStem(stem)}</p>;
  }
  return blocks;
}

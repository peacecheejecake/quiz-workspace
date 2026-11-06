// QTABLE-01 (docs/questions.md §4 item 11): options printed as a table, in aligned columns inside
// each host's own option row. Every row and the header use the same tracks. The visible header is
// hidden from assistive tech; each cell repeats its header as hidden text instead, so a radio's
// name reads `단계: 응집 주요 작용: 미세 입자 결합`.
import { Fragment, type CSSProperties, type ReactNode } from 'react';
import type { OptionGrid } from '@/lib/questions/stem-table';
import styles from './option-grid.module.css';

function tracks(grid: OptionGrid): CSSProperties {
  return { '--option-columns': grid.columns } as CSSProperties;
}

/** The visible column headers above the options; the host class insets them to its rows. */
export function OptionGridHead({
  grid,
  className,
  numbered = false,
  trailing = false,
}: {
  readonly grid: OptionGrid;
  readonly className?: string | undefined;
  /** The rows have a number column. */
  readonly numbered?: boolean;
  /** The rows have a trailing mark column. */
  readonly trailing?: boolean;
}) {
  if (!grid.headers) return null;
  return (
    <div
      aria-hidden="true"
      className={className ? `${styles.row} ${className}` : styles.row}
      style={tracks(grid)}
      data-numbered={numbered || undefined}
      data-trailing={trailing || undefined}
    >
      {numbered ? <span /> : null}
      {grid.headers.map((header, i) => (
        <span key={i} className={styles.head}>
          {header}
        </span>
      ))}
      {trailing ? <span /> : null}
    </div>
  );
}

/** One option's cells, with its number before them and its mark after them, if any. */
export function OptionCells({
  grid,
  index,
  number,
  numberClassName,
  trailing,
  reserveTrailing = false,
}: {
  readonly grid: OptionGrid;
  readonly index: number;
  readonly number?: ReactNode;
  readonly numberClassName?: string | undefined;
  readonly trailing?: ReactNode;
  /** Keeps the mark column when this row has no mark. */
  readonly reserveTrailing?: boolean;
}) {
  return (
    <span
      className={styles.row}
      style={tracks(grid)}
      data-numbered={number !== undefined || undefined}
      data-trailing={reserveTrailing || undefined}
    >
      {number !== undefined ? (
        <span className={numberClassName} aria-hidden="true">
          {number}
        </span>
      ) : null}
      {grid.rows[index]?.map((cell, c) => {
        const header = grid.headers?.[c];
        return (
          // Cells have no ids; their position is their identity. The space between cells keeps
          // them apart in the option's accessible name; it takes no room in the grid.
          <Fragment key={c}>
            <span className={styles.cell} data-copy={cell}>
              {header ? <span className="qz-visually-hidden">{header}: </span> : null}
              <span>{cell}</span>
            </span>{' '}
          </Fragment>
        );
      })}
      {reserveTrailing ? <span className={styles.trailing}>{trailing}</span> : null}
    </span>
  );
}

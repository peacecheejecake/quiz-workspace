'use client';

import { positionLabel, type RunResultItem, type RunSource } from '@/lib/questions/practice-runs';
import { groupResults, resultMark } from './result-groups';
import styles from './grouped-results.module.css';

const TONE_CLASS = { correct: styles.correct, incorrect: styles.incorrect } as const;

/**
 * Per-chapter tables of numbers and marks. A question is a column on screen, so that columns can
 * wrap at the panel width, and a row for assistive tech: number = row header, mark = cell.
 */
export function GroupedResults({
  items,
  source,
  onSelect,
}: {
  readonly items: readonly RunResultItem[];
  readonly source: RunSource;
  readonly onSelect: (position: number) => void;
}) {
  return (
    <ul className={styles.list} aria-label="문제별 결과">
      {groupResults(items).map((group) => (
        <li key={group.key}>
          <section aria-label={group.title}>
            <h3 className={styles.title}>{group.title}</h3>
            <div role="table" aria-label={group.title} className={styles.table}>
              {group.items.map((item) => {
                const label = positionLabel(item, source);
                const { mark, word, tone } = resultMark(item);
                return (
                  <div role="row" key={item.position} className={styles.column}>
                    <div role="rowheader" className={styles.number}>
                      <button
                        type="button"
                        className={styles.target}
                        aria-label={`${label} ${word}, 문제로 이동`}
                        onClick={() => onSelect(item.position)}
                      >
                        {label}
                      </button>
                    </div>
                    <div
                      role="cell"
                      aria-label={word}
                      className={[styles.result, tone ? TONE_CLASS[tone] : null]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {mark}
                    </div>
                  </div>
                );
              })}
            </div>
            {group.items.some((item) => !item.available) ? (
              <p className={styles.note}>불가: 더 이상 풀 수 없는 문제</p>
            ) : null}
          </section>
        </li>
      ))}
    </ul>
  );
}

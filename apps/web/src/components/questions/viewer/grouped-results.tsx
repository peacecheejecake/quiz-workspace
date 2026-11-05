'use client';

import { Button } from '@quiz/ui';
import { displayStem } from '@/lib/questions/display-stem';
import { RESULT_WORDS, type RunResultItem } from '@/lib/questions/practice-runs';
import { groupResults } from './result-groups';
import styles from './grouped-results.module.css';

export function GroupedResults({
  items,
  onSelect,
}: {
  readonly items: readonly RunResultItem[];
  readonly onSelect: (position: number) => void;
}) {
  return (
    <div role="list" aria-label="문제별 결과">
      {groupResults(items).map((group) => (
        <section role="listitem" key={group.key} aria-label={group.title}>
          <h3>{group.title}</h3>
          <ul className={styles.list}>
            {group.items.map((item) => (
              <li key={item.position}>
                <Button
                  variant="ghost"
                  className={styles.row}
                  onClick={() => onSelect(item.position)}
                >
                  <span>
                    {item.question_number === null
                      ? `문제 ${item.position}`
                      : `${item.question_number}번`}
                  </span>
                  <span>
                    {item.preview
                      ? displayStem(item.preview).replace(/\s+/g, ' ').slice(0, 40)
                      : item.available
                        ? ''
                        : '더 이상 풀 수 없는 문제'}
                  </span>
                  {!item.available ? (
                    <span>더 이상 풀 수 없는 문제</span>
                  ) : item.result === 'correct' ? (
                    <span className={styles.correct} aria-label="정답">
                      O
                    </span>
                  ) : item.result === 'incorrect' ? (
                    <span className={styles.incorrect} aria-label="오답">
                      X
                    </span>
                  ) : (
                    <span>{item.result ? RESULT_WORDS[item.result] : '아직 풀지 않음'}</span>
                  )}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

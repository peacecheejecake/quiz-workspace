// STEM-ITEMS (docs/questions.md §4 item 11, QPLAY-01-AC14): the one rendering of a whole stem
// with its labelled items in a 제시 항목 box, shared by every screen that shows the full stem
// (QuestionStem, draft review, source compare, mock question dialog, document question card).
// One-line previews keep collapsing whitespace and do not use it.
import { displayStem } from '@/lib/questions/display-stem';
import {
  stemItems,
  stemPassageParagraphs,
  type StemItem,
  type StemLayout,
} from '@/lib/questions/stem-items';
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

/**
 * The displayed stem as blocks for a container that spaces them (QuestionStem): one paragraph per
 * blank-line block, or the question paragraphs, the item box and the paragraphs after it.
 */
export function StemBlocks({ stem }: { readonly stem: string }) {
  const layout = stemItems(stem);
  if (layout) return <LayoutBlocks layout={layout} />;
  return (
    <>
      {stemPassageParagraphs(stem).map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
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
  const layout = stemItems(stem);
  if (!layout) {
    const paragraphs = stemPassageParagraphs(stem);
    if (paragraphs.length === 1) return <p className={className}>{displayStem(stem)}</p>;
    return (
      <div className={className ? `${className} ${styles.stem}` : styles.stem}>
        {paragraphs.map((paragraph, i) => (
          <p key={i}>{paragraph}</p>
        ))}
      </div>
    );
  }
  return (
    <div className={className ? `${className} ${styles.stem}` : styles.stem}>
      <LayoutBlocks layout={layout} />
    </div>
  );
}

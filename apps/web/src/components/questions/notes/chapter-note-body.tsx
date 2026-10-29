'use client';

// CHNOTE-01 note body, shared by the member panel and the share page's read-only panel: the
// "정답·해설 포함" disclosure (collapsed by default: the body comes from answers and
// explanations), sections (`h3`) of items ending in footnote numbers ("각주 k", a link to the
// footnote line in the same panel) and the `각주` list, whose lines open the cited question.
import { Button, ChevronDownIcon, ChevronUpIcon } from '@quiz/ui';
import { useId, type MouseEvent, type Ref } from 'react';
import {
  footnoteLinks,
  footnoteText,
  inlineParts,
  NOTE_TEXT,
  type NoteFootnote,
  type NoteSection,
} from '@/lib/notes/model';
import styles from './chapter-note.module.css';

export interface ChapterNoteBodyProps {
  readonly sections: readonly NoteSection[];
  readonly footnotes: readonly NoteFootnote[];
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  /** The disclosure button (focus returns here when the practice panel closes). */
  readonly disclosureRef?: Ref<HTMLButtonElement>;
  /** `href` of a footnote line's link to its question. */
  readonly questionHref: (questionId: string) => string;
  /** Opens the cited question (the practice panel, or the share page's question panel). */
  readonly onOpenQuestion: (questionId: string) => void;
}

function ItemText({ text }: { readonly text: string }) {
  return (
    <>
      {inlineParts(text).map((part, i) =>
        part.kind === 'strong' ? (
          <strong key={i}>{part.text}</strong>
        ) : part.kind === 'em' ? (
          <em key={i}>{part.text}</em>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function ChapterNoteBody({
  sections,
  footnotes,
  expanded,
  onExpandedChange,
  disclosureRef,
  questionHref,
  onOpenQuestion,
}: ChapterNoteBodyProps) {
  const baseId = useId();
  const bodyId = `${baseId}-body`;
  const listTitleId = `${baseId}-footnotes`;
  const footnoteId = (n: number) => `${baseId}-fn-${n}`;
  const known = new Set(footnotes.map((f) => f.number));

  // Moves to the footnote line in this panel (no URL fragment: the address bar keeps the panel).
  const jumpTo = (event: MouseEvent<HTMLAnchorElement>, n: number) => {
    event.preventDefault();
    const target = document.getElementById(footnoteId(n));
    if (!target) return;
    target.scrollIntoView({ block: 'nearest' });
    target.focus({ preventScroll: true });
  };

  return (
    <>
      <div className={styles.disclosure}>
        <Button
          ref={disclosureRef}
          size="sm"
          variant="secondary"
          className={styles.disclosureButton}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => onExpandedChange(!expanded)}
        >
          {`${NOTE_TEXT.disclosure} — ${expanded ? '접기' : '펼쳐서 보기'}`}
          {expanded ? (
            <ChevronUpIcon width={16} height={16} aria-hidden="true" />
          ) : (
            <ChevronDownIcon width={16} height={16} aria-hidden="true" />
          )}
        </Button>
        <p className={styles.hint}>{NOTE_TEXT.disclosureNote}</p>
      </div>

      <div id={bodyId} className={styles.body} hidden={!expanded}>
        {expanded ? (
          <>
            {sections.map((section, s) => (
              <section key={s} className={styles.section}>
                <h3 className={styles.heading}>{section.heading}</h3>
                <ul className={styles.items}>
                  {section.items.map((item, i) => (
                    <li key={i}>
                      <ItemText text={item.text} />
                      {item.footnotes
                        .filter((n) => known.has(n))
                        .map((n) => (
                          <a
                            key={n}
                            href={`#${encodeURIComponent(footnoteId(n))}`}
                            className={`${styles.ref} qz-focus-ring`}
                            aria-label={`각주 ${n}`}
                            onClick={(event) => jumpTo(event, n)}
                          >
                            [{n}]
                          </a>
                        ))}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <div className={styles.footnotes}>
              <p id={listTitleId} className={styles.footnotesTitle}>
                각주
              </p>
              <ol className={styles.footnoteList} aria-labelledby={listTitleId}>
                {footnotes.map((f) => (
                  <li key={f.number} id={footnoteId(f.number)} tabIndex={-1}>
                    {footnoteLinks(f) ? (
                      <a
                        href={questionHref(f.question_id)}
                        className={`${styles.footnoteLink} qz-focus-ring`}
                        onClick={(event) => {
                          event.preventDefault();
                          onOpenQuestion(f.question_id);
                        }}
                      >
                        {footnoteText(f)}
                      </a>
                    ) : (
                      <span className={styles.gone}>{footnoteText(f)}</span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

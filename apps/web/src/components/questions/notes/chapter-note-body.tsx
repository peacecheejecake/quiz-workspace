'use client';

// CHNOTE-01 note body with the CHNOTE-02 reading tools, shared by the member panel and the share
// page's read-only panel (docs/screens/chapter-note-tools.md): the 노트에서 찾기 search row, the
// answers notice (text, no fold — user decision C7), sections (`h3`) of items in a
// HighlightableText "정리 노트 본문" whose footnote numbers open the cited question, the `각주` list
// and (members) `내 하이라이트`. Footnote numbers and lines preview the question's stem and options
// at the pointer (focus: at the element; touch: a tap shows the preview with `문제 열기`); the
// preview never carries answers. Search results are drawn in the body, headings, footnote lines
// and the explanation rows of 내 하이라이트; the query is screen state only (never in the URL).
import {
  Button,
  findInNote,
  HighlightableText,
  PointerAnchoredFloating,
  SearchField,
  SearchMatchText,
  Skeleton,
  type FindBlock,
  type PointerFloatingMode,
  type TextBlock,
  type TextHighlight,
  type TextMatch,
} from '@quiz/ui';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  footnoteLinks,
  footnoteText,
  NOTE_TEXT,
  noteItemBlock,
  plainItemText,
  previewHeading,
  type MyHighlight,
  type NoteFootnote,
  type NoteSection,
  type QuestionPreview,
} from '@/lib/notes/model';
import { displayStem } from '@/lib/questions/display-stem';
import styles from './chapter-note.module.css';
import { highlightRowBlock, MyHighlightsSection, searchesRow } from './my-highlights-section';

export type LoadPreview = (questionId: string, signal?: AbortSignal) => Promise<QuestionPreview>;

export interface ChapterNoteBodyProps {
  readonly sections: readonly NoteSection[];
  readonly footnotes: readonly NoteFootnote[];
  /** `href` of a footnote's link to its question. */
  readonly questionHref: (questionId: string) => string;
  /**
   * Opens the cited question over the note (the practice panel, or the share page's question
   * panel); focus goes back to `trigger` (the pressed footnote) when that panel closes.
   */
  readonly onOpenQuestion: (questionId: string, trigger: HTMLElement | null) => void;
  /** The footnote preview's data (stem and options only). */
  readonly loadPreview: LoadPreview;
  /** The reader's highlights in this note version (drawn in the body). */
  readonly highlights?: readonly TextHighlight[];
  /** The reader's 내 하이라이트 rows (members); undefined: no section (share guests). */
  readonly myHighlights?: readonly MyHighlight[] | null;
  /** A modal (the practice panel) covers the note: its content is hidden meanwhile. */
  readonly covered?: boolean;
}

type PreviewState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly preview: QuestionPreview }
  | { readonly status: 'error' };

/** One request per question for the panel's life (a failure is retried on the next open). */
function usePreviewCache(load: LoadPreview) {
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const [read] = useState(() => {
    const cache = new Map<string, Promise<QuestionPreview>>();
    return (questionId: string): Promise<QuestionPreview> => {
      let pending = cache.get(questionId);
      if (!pending) {
        pending = loadRef.current(questionId);
        cache.set(questionId, pending);
        pending.catch(() => cache.delete(questionId));
      }
      return pending;
    };
  });
  return read;
}

function PreviewBody({
  questionId,
  read,
  mode,
  onOpen,
}: {
  readonly questionId: string;
  readonly read: (questionId: string) => Promise<QuestionPreview>;
  readonly mode: PointerFloatingMode;
  readonly onOpen: () => void;
}) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    read(questionId).then(
      (preview) => live && setState({ status: 'ready', preview }),
      () => live && setState({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [questionId, read]);

  return (
    <div className={styles.preview}>
      {state.status === 'loading' ? (
        <div className={styles.previewLoading} aria-busy="true">
          <span className="qz-visually-hidden">{NOTE_TEXT.previewLoading}</span>
          <Skeleton width="45%" />
          <Skeleton width="100%" />
          <Skeleton width="80%" />
        </div>
      ) : state.status === 'error' ? (
        <p className={styles.note}>{NOTE_TEXT.previewFailed}</p>
      ) : (
        <>
          <p className={styles.previewHeading}>{previewHeading(state.preview)}</p>
          <p className={styles.previewStem}>{displayStem(state.preview.stem)}</p>
          {state.preview.options.length > 0 ? (
            <ol className={styles.previewOptions}>
              {state.preview.options.map((option) => (
                <li key={option.id}>{option.text}</li>
              ))}
            </ol>
          ) : null}
        </>
      )}
      {mode === 'tap' ? (
        <Button size="sm" onClick={onOpen}>
          {NOTE_TEXT.openQuestion}
        </Button>
      ) : null}
    </div>
  );
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab inside the note dialog at its ends: from the last control to the first and back. A
 * footnote preview is a Radix layer whose focus scope pauses the modal's own focus trap while it
 * is open (and for a moment after it closes), so Tab from the last control would otherwise leave
 * the dialog.
 */
function keepTabInDialog(event: globalThis.KeyboardEvent): void {
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.defaultPrevented || !(event.target instanceof HTMLElement)) return;
  const dialog = event.target.closest('[role="dialog"]');
  if (!dialog) return;
  const stops = [...dialog.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) =>
      el.tabIndex >= 0 &&
      !el.closest('[inert], [hidden], [aria-hidden="true"]') &&
      getComputedStyle(el).visibility !== 'hidden',
  );
  const first = stops[0];
  const last = stops[stops.length - 1];
  const to = event.shiftKey ? event.target === first && last : event.target === last && first;
  if (!to) return;
  event.preventDefault();
  to.focus();
}

/**
 * `onCloseAutoFocus` of the note panel: a backdrop click while a footnote preview held the top
 * layer leaves focus on the backdrop's focusable container (`<main tabindex="-1">`) instead of
 * inside the note, and the panel would then not return focus to its opener. That focus is
 * dropped, so the panel hands it back to the `정리 노트` button.
 */
export function dropStrayFocus(): void {
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    active !== document.body &&
    active.tabIndex < 0 &&
    !active.closest('[role="dialog"]')
  ) {
    active.blur();
  }
}

/** Applies `keepTabInDialog` to the element `ref` points at (the note content's root). */
export function useKeepTabInDialog(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    el.addEventListener('keydown', keepTabInDialog);
    return () => el.removeEventListener('keydown', keepTabInDialog);
  });
}

/** A footnote link (number or line) that opens its question, with the preview floating on it. */
function FootnoteLink({
  questionId,
  href,
  className,
  label,
  read,
  onOpen,
  children,
}: {
  readonly questionId: string;
  readonly href: string;
  readonly className: string | undefined;
  readonly label?: string;
  readonly read: (questionId: string) => Promise<QuestionPreview>;
  readonly onOpen: (questionId: string, trigger: HTMLElement | null) => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  return (
    <PointerAnchoredFloating
      label={NOTE_TEXT.preview}
      openOnTap
      content={({ mode, close }) => (
        <PreviewBody
          questionId={questionId}
          read={read}
          mode={mode}
          onOpen={() => {
            close();
            onOpen(questionId, ref.current);
          }}
        />
      )}
    >
      <a
        ref={ref}
        href={href}
        className={`${className ?? ''} qz-focus-ring`}
        aria-label={label}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault();
          onOpen(questionId, event.currentTarget);
        }}
      >
        {children}
      </a>
    </PointerAnchoredFloating>
  );
}

const headingBlock = (s: number) => `h${s}`;
/** The question a footnote opens, or null ("삭제되었거나 옮긴 문제": no link, no preview). */
const linkedQuestion = (f: NoteFootnote): string | null =>
  footnoteLinks(f) ? (f.question_id ?? null) : null;
const footnoteBlock = (n: number) => `fn${n}`;

export function ChapterNoteBody({
  sections,
  footnotes,
  questionHref,
  onOpenQuestion,
  loadPreview,
  highlights = [],
  myHighlights,
  covered = false,
}: ChapterNoteBodyProps) {
  const baseId = useId();
  const listTitleId = `${baseId}-footnotes`;
  const footnoteId = (n: number) => `${baseId}-fn-${n}`;
  const byNumber = new Map(footnotes.map((f) => [f.number, f]));
  const read = usePreviewCache(loadPreview);
  const rootRef = useRef<HTMLDivElement>(null);
  useKeepTabInDialog(rootRef);
  const lastTrigger = useRef<HTMLElement | null>(null);

  const open = (questionId: string, trigger: HTMLElement | null) => {
    lastTrigger.current = trigger;
    onOpenQuestion(questionId, trigger);
  };

  // Moves to a footnote line in this panel (a footnote whose question is gone has no question to
  // open; no URL fragment: the address bar keeps the panel).
  const jumpTo = (event: MouseEvent<HTMLAnchorElement>, n: number) => {
    event.preventDefault();
    const target = document.getElementById(footnoteId(n));
    if (!target) return;
    target.scrollIntoView({ block: 'nearest' });
    target.focus({ preventScroll: true });
  };

  const itemBlocks = useMemo<TextBlock[]>(
    () =>
      sections.flatMap((section, s) =>
        section.items.map((item, i) => {
          const plain = plainItemText(item.text);
          return { id: noteItemBlock(s, i), text: plain.text, emphasis: plain.emphasis };
        }),
      ),
    [sections],
  );
  const searchedRows = useMemo(() => (myHighlights ?? []).filter(searchesRow), [myHighlights]);
  // Reading order: headings and items, the footnote lines, then the explanation rows.
  const findBlocks = useMemo<FindBlock[]>(() => {
    const out: FindBlock[] = [];
    let k = 0;
    sections.forEach((section, s) => {
      out.push({ id: headingBlock(s), text: section.heading });
      for (const _ of section.items) out.push(itemBlocks[k++] as FindBlock);
    });
    for (const f of footnotes) out.push({ id: footnoteBlock(f.number), text: footnoteText(f) });
    for (const h of searchedRows) out.push({ id: highlightRowBlock(h.id), text: h.quote });
    return out;
  }, [sections, itemBlocks, footnotes, searchedRows]);

  const [value, setValue] = useState('');
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const found = useMemo(() => findInNote(findBlocks, query), [findBlocks, query]);
  const total = found.matches.length;
  const shownCurrent = total === 0 ? 0 : Math.min(Math.max(current, 1), total);
  const matches = useMemo<TextMatch[]>(
    () => found.matches.map((m, i) => ({ ...m, current: i === shownCurrent - 1 })),
    [found, shownCurrent],
  );
  const matchesOf = (block: string) => matches.filter((m) => m.block === block);

  // Keep the current result in view (instantly with reduced motion).
  const currentKey = shownCurrent > 0 ? `${query}:${shownCurrent}` : '';
  useEffect(() => {
    if (!currentKey) return;
    const mark = rootRef.current?.querySelector('mark[data-search-result][data-current="true"]');
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true;
    mark?.scrollIntoView?.({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [currentKey]);

  // When the covering panel closes, focus is back on the pressed footnote (the panel's own focus
  // return normally does this; this covers a focus lost while the content was inert).
  const wasCovered = useRef(covered);
  useEffect(() => {
    if (wasCovered.current && !covered) {
      const active = document.activeElement;
      const trigger = lastTrigger.current;
      if (trigger?.isConnected && (!active || active === document.body)) {
        trigger.focus({ preventScroll: true });
      }
    }
    wasCovered.current = covered;
  }, [covered]);

  const refsOf = (numbers: readonly number[]) =>
    numbers.flatMap((n) => {
      const f = byNumber.get(n);
      if (!f) return [];
      const text = `[${n}]`;
      const questionId = linkedQuestion(f);
      return [
        questionId ? (
          <FootnoteLink
            key={n}
            questionId={questionId}
            href={questionHref(questionId)}
            className={styles.ref}
            label={`각주 ${n}`}
            read={read}
            onOpen={open}
          >
            {text}
          </FootnoteLink>
        ) : (
          <a
            key={n}
            href={`#${encodeURIComponent(footnoteId(n))}`}
            className={`${styles.ref} qz-focus-ring`}
            aria-label={`각주 ${n}`}
            onClick={(event) => jumpTo(event, n)}
          >
            {text}
          </a>
        ),
      ];
    });

  let k = 0;
  const blocks: TextBlock[] = sections.flatMap((section) =>
    section.items.map((item) => ({
      ...(itemBlocks[k++] as TextBlock),
      suffix: refsOf(item.footnotes),
    })),
  );

  return (
    <div ref={rootRef} className={styles.reader}>
      <SearchField
        label={NOTE_TEXT.search}
        value={value}
        onValueChange={setValue}
        onSearch={(q) => {
          setQuery(q);
          setCurrent(1);
        }}
        total={total}
        current={shownCurrent}
        capped={found.capped}
        onNext={() => setCurrent(shownCurrent >= total ? 1 : shownCurrent + 1)}
        onPrevious={() => setCurrent(shownCurrent <= 1 ? total : shownCurrent - 1)}
      />
      <p className={styles.hint}>{NOTE_TEXT.answersNotice}</p>

      <HighlightableText
        label={NOTE_TEXT.bodyLabel}
        blocks={blocks}
        highlights={highlights}
        matches={matches}
        scrollToCurrentMatch={false}
        readOnly
        className={styles.body}
        renderLayout={(renderBlock) =>
          sections.map((section, s) => {
            const first = sections.slice(0, s).reduce((n, x) => n + x.items.length, 0);
            return (
              <section key={s} className={styles.section}>
                <h3 className={styles.heading}>
                  <SearchMatchText text={section.heading} matches={matchesOf(headingBlock(s))} />
                </h3>
                <ul className={styles.items}>
                  {section.items.map((_, i) =>
                    renderBlock(itemBlocks[first + i]?.id ?? noteItemBlock(s, i), { as: 'li' }),
                  )}
                </ul>
              </section>
            );
          })
        }
      />

      <div className={styles.footnotes}>
        <p id={listTitleId} className={styles.footnotesTitle}>
          각주
        </p>
        <ol className={styles.footnoteList} aria-labelledby={listTitleId}>
          {footnotes.map((f) => {
            const line = (
              <SearchMatchText
                text={footnoteText(f)}
                matches={matchesOf(footnoteBlock(f.number))}
              />
            );
            const questionId = linkedQuestion(f);
            return (
              <li key={f.number} id={footnoteId(f.number)} tabIndex={-1}>
                {questionId ? (
                  <FootnoteLink
                    questionId={questionId}
                    href={questionHref(questionId)}
                    className={styles.footnoteLink}
                    read={read}
                    onOpen={open}
                  >
                    {line}
                  </FootnoteLink>
                ) : (
                  <span className={styles.gone}>{line}</span>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {myHighlights !== undefined ? (
        <MyHighlightsSection items={myHighlights} matchesOf={matchesOf} />
      ) : null}
    </div>
  );
}

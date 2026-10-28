'use client';

// QuestionDraftReview (docs/design-system.md component list): the human review list shared by
// QIMPORT-01 (PDF import drafts) and QGEN-01 (generation drafts, M6.3). Presentational: it shows
// each draft with its number, type, stem, options and answer, source pages, validation notes and
// review state, and reports the reviewer's actions (approve, edit, compare with the source) to the
// screen, which owns the API calls. Two review modes: per-draft approval (`onApproveChange`, QGEN-01;
// approval never implies registration) or a plain selection checkbox (`onSelectChange`, QIMPORT-01
// QIMP-BULK; the screen approves and registers the selection in one action).
//
// Accessibility: one list item per draft (nothing inside is a list item, so the list reads as
// "N drafts"); state is text + icon, never color alone (정답 보기 is
// marked "정답", a missing answer reads "정답 없음"); every control has a name that includes the
// draft number so screen-reader users can tell them apart.
//
// Performance (UX6-SELECT): real imports have hundreds of drafts. Rows are memoized and each row's
// checkbox subscribes to its own draft's selection (a small store), so checking a draft re-renders
// one checkbox and "전체 선택" only the checkboxes that change — never the drafts' content (stem,
// options, chapter picker). The screen keeps its callbacks and `renderExtra` stable for this.
import { AlertIcon, Badge, Button, CheckIcon, Checkbox } from '@quiz/ui';
import Link from 'next/link';
import {
  createContext,
  memo,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  approvalBlocker,
  selectionBlocker,
  draftNumber,
  DRAFT_ORIGIN_LABELS,
  issueMessage,
  REVIEW_STATUS_LABELS,
  type ReviewDraft,
} from '@/lib/questions/drafts';
import { QUESTION_TYPE_LABELS } from '@/lib/questions/form';
import styles from './question-draft-review.module.css';

export interface DraftReviewState {
  /** Approval shown while the request is in flight (optimistic). */
  readonly approving?: boolean;
  /** Inline error of the last action on this draft. */
  readonly error?: string;
}

export interface QuestionDraftReviewProps {
  /** Accessible name of the list (e.g. "가져온 초안"). */
  readonly label: string;
  readonly drafts: readonly ReviewDraft[];
  /** Per-draft UI state (pending approval, last error), by draft id. */
  readonly states?: Readonly<Record<string, DraftReviewState>>;
  /** No approve/edit controls (viewer, archived workspace). */
  readonly readOnly?: boolean;
  readonly onApproveChange?: (draft: ReviewDraft, approved: boolean) => void;
  /** Selection mode (replaces the approve control): ids of the selected drafts. */
  readonly selected?: ReadonlySet<string>;
  /** Selection checkboxes are shown but cannot change (e.g. while registering). */
  readonly selectionDisabled?: boolean;
  readonly onSelectChange?: (draft: ReviewDraft, selected: boolean) => void;
  readonly onEdit?: (draft: ReviewDraft) => void;
  /** Opens the source comparison for the draft (e.g. the PDF page next to it). */
  readonly onCompare?: (draft: ReviewDraft) => void;
  /** Deep link of a source page (e.g. the document viewer at `?page=`); null = plain text. */
  readonly pageHref?: (draft: ReviewDraft, page: number) => string | null;
  /** Extra content per draft (e.g. a generation diff), rendered under the answer. */
  readonly renderExtra?: (draft: ReviewDraft) => ReactNode;
}

const NO_STATES: Readonly<Record<string, DraftReviewState>> = {};
const NO_STATE: DraftReviewState = {};

/** The selected ids for the checkboxes: each one re-renders only when its own draft changes. */
class SelectionStore {
  private readonly listeners = new Set<() => void>();
  constructor(private selected: ReadonlySet<string> | undefined) {}
  has(id: string): boolean {
    return this.selected?.has(id) ?? false;
  }
  set(next: ReadonlySet<string> | undefined): void {
    if (next === this.selected) return;
    this.selected = next;
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

const SelectionContext = createContext<SelectionStore | null>(null);

export function QuestionDraftReview({
  label,
  drafts,
  states = NO_STATES,
  readOnly = false,
  onApproveChange,
  selected,
  selectionDisabled = false,
  onSelectChange,
  onEdit,
  onCompare,
  pageHref,
  renderExtra,
}: QuestionDraftReviewProps) {
  const [store] = useState(() => new SelectionStore(selected));
  useLayoutEffect(() => store.set(selected), [store, selected]);
  return (
    <SelectionContext.Provider value={store}>
      <ul aria-label={label} className={styles.list}>
        {drafts.map((draft) => (
          <DraftItem
            key={draft.id}
            draft={draft}
            state={states[draft.id] ?? NO_STATE}
            readOnly={readOnly}
            onApproveChange={onApproveChange}
            selectionDisabled={selectionDisabled}
            onSelectChange={onSelectChange}
            onEdit={onEdit}
            onCompare={onCompare}
            pageHref={pageHref}
            renderExtra={renderExtra}
          />
        ))}
      </ul>
    </SelectionContext.Provider>
  );
}

interface DraftItemProps {
  readonly draft: ReviewDraft;
  readonly state: DraftReviewState;
  readonly readOnly: boolean;
  readonly onApproveChange?: QuestionDraftReviewProps['onApproveChange'];
  readonly selectionDisabled: boolean;
  readonly onSelectChange?: QuestionDraftReviewProps['onSelectChange'];
  readonly onEdit?: QuestionDraftReviewProps['onEdit'];
  readonly onCompare?: QuestionDraftReviewProps['onCompare'];
  readonly pageHref?: QuestionDraftReviewProps['pageHref'];
  readonly renderExtra?: QuestionDraftReviewProps['renderExtra'];
}

const DraftItem = memo(function DraftItem({
  draft,
  state,
  readOnly,
  onApproveChange,
  selectionDisabled,
  onSelectChange,
  onEdit,
  onCompare,
  pageHref,
  renderExtra,
}: DraftItemProps) {
  const n = draftNumber(draft);
  const published = draft.publishedQuestionId !== null;
  const pending = state.approving !== undefined;
  const approved = state.approving ?? draft.reviewStatus === 'approved';
  const blocker = approved ? null : approvalBlocker(draft);
  const status = published ? 'published' : draft.reviewStatus;
  const headingId = `draft-${draft.id}-title`;

  return (
    <li
      className={styles.item}
      data-review-status={status}
      aria-labelledby={headingId}
      aria-busy={pending || undefined}
    >
      <div className={styles.header}>
        <h3 id={headingId} className={styles.title}>
          {n}번 문제
        </h3>
        <Badge>{QUESTION_TYPE_LABELS[draft.type]}</Badge>
        <Badge tone={status === 'published' || status === 'approved' ? 'success' : 'neutral'}>
          {status === 'published' || status === 'approved' ? (
            <CheckIcon width={12} height={12} aria-hidden="true" />
          ) : null}
          {REVIEW_STATUS_LABELS[status]}
        </Badge>
        {draft.origin !== 'pdf_import' ? <Badge>{DRAFT_ORIGIN_LABELS[draft.origin]}</Badge> : null}
        {draft.answerMissing ? <Badge tone="warning">정답 없음</Badge> : null}
      </div>

      <p className={styles.stem}>{draft.stem}</p>

      {draft.type === 'MCQ' ? (
        <div className={styles.options}>
          {draft.options.map((option, index) => (
            <p key={option.id} className={styles.option} data-correct={option.correct || undefined}>
              <span className={styles.optionLabel}>{index + 1}.</span>
              <span className={styles.optionText}>{option.text}</span>
              {option.correct ? (
                <span className={styles.correctMark}>
                  <CheckIcon width={14} height={14} aria-hidden="true" />
                  정답
                </span>
              ) : null}
            </p>
          ))}
        </div>
      ) : (
        <AnswerSummary draft={draft} />
      )}

      {draft.explanation ? (
        <p className={styles.note}>
          <span className={styles.noteLabel}>해설</span> {draft.explanation}
        </p>
      ) : null}

      {draft.issues.length > 0 ? (
        <div className={styles.issues}>
          {draft.issues.map((issue, index) => (
            <p key={`${issue.code}-${index}`} data-severity={issue.severity}>
              <AlertIcon width={14} height={14} aria-hidden="true" />
              {issue.severity === 'error' ? '승인 불가: ' : '확인: '}
              {issueMessage(issue.code)}
            </p>
          ))}
        </div>
      ) : null}

      {renderExtra?.(draft)}

      <div className={styles.footer}>
        {draft.pages.length > 0 ? (
          <p className={styles.pages}>
            <span className={styles.noteLabel}>원본</span>
            {draft.pages.map((page) => {
              const href = pageHref?.(draft, page) ?? null;
              return href ? (
                <Link key={page} href={href} className={styles.pageLink}>
                  {page}쪽
                </Link>
              ) : (
                <span key={page}>{page}쪽</span>
              );
            })}
          </p>
        ) : null}
        <div className={styles.actions}>
          {onCompare && draft.pages.length > 0 ? (
            <Button
              size="sm"
              aria-haspopup="dialog"
              aria-label={`원본 비교: ${n}번 문제`}
              onClick={() => onCompare(draft)}
            >
              원본 비교
            </Button>
          ) : null}
          {!readOnly && !published && onEdit ? (
            <Button
              size="sm"
              aria-haspopup="dialog"
              aria-label={`편집: ${n}번 문제`}
              onClick={() => onEdit(draft)}
            >
              편집
            </Button>
          ) : null}
          {!readOnly && !published && onSelectChange ? (
            <DraftSelectBox
              draft={draft}
              disabled={selectionDisabled}
              onSelectChange={onSelectChange}
            />
          ) : null}
          {!readOnly && !published && onApproveChange && !onSelectChange ? (
            <Checkbox
              className={styles.approve}
              label="승인"
              aria-label={`${n}번 문제 승인`}
              checked={approved}
              disabled={pending || blocker !== null}
              onCheckedChange={(checked) => onApproveChange(draft, checked === true)}
              {...(blocker ? { description: blocker } : {})}
            />
          ) : null}
        </div>
      </div>

      {state.error ? (
        <p role="alert" className={styles.error}>
          <AlertIcon width={16} height={16} aria-hidden="true" />
          {state.error}
        </p>
      ) : null}
    </li>
  );
});

/** The draft's "선택" checkbox: the only part of a row that follows the selection. */
function DraftSelectBox({
  draft,
  disabled,
  onSelectChange,
}: {
  readonly draft: ReviewDraft;
  readonly disabled: boolean;
  readonly onSelectChange: NonNullable<QuestionDraftReviewProps['onSelectChange']>;
}) {
  const store = useContext(SelectionContext);
  const read = () => store?.has(draft.id) ?? false;
  const selected = useSyncExternalStore(store?.subscribe ?? noSubscribe, read, read);
  const blocker = selectionBlocker(draft);
  return (
    <Checkbox
      className={styles.approve}
      label="선택"
      aria-label={`${draftNumber(draft)}번 문제 선택`}
      checked={selected && blocker === null}
      disabled={disabled || blocker !== null}
      onCheckedChange={(checked) => onSelectChange(draft, checked === true)}
      {...(blocker ? { description: blocker } : {})}
    />
  );
}

const noUnsubscribe = (): void => undefined;
function noSubscribe(): () => void {
  return noUnsubscribe;
}

function AnswerSummary({ draft }: { draft: ReviewDraft }) {
  if (draft.type === 'SHORT_ANSWER') {
    return draft.acceptedAnswers && draft.acceptedAnswers.length > 0 ? (
      <p className={styles.note}>
        <span className={styles.noteLabel}>허용 답안</span> {draft.acceptedAnswers.join(', ')}
      </p>
    ) : null;
  }
  return draft.rubric ? (
    <p className={styles.note}>
      <span className={styles.noteLabel}>채점 기준</span> {draft.rubric}
    </p>
  ) : null;
}

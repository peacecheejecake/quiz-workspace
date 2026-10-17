// VariationDiffViewer (docs/design-system.md component list, docs/questions.md §5): what a
// generated draft changed against the source revision it was generated from, with the
// generator's justification, the cited book passages (page links into the document viewer) and
// the validation state as text ("검증 통과" or what blocks approval).
//
// Accessibility: changes use <ins>/<del> (roles insertion/deletion) and are drawn with an
// underline / strike-through, never by color alone; the legend says so in words. Nothing here is
// a list item, so the draft list it is rendered in keeps announcing "N drafts".
import { AlertIcon, Badge, CheckIcon } from '@quiz/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ReviewDraft } from '@/lib/questions/drafts';
import { VARIATION_LABELS } from '@/lib/questions/generation-model';
import {
  diffOptions,
  diffWords,
  unchanged,
  type DiffSegment,
  type OptionLike,
} from '@/lib/questions/variation-diff';
import styles from './question-generation.module.css';

/** The source revision the variants are compared with. */
export interface VariationOriginal {
  readonly stem: string;
  readonly options: readonly OptionLike[];
}

export interface VariationDiffViewerProps {
  /** The source revision the run was generated from; null while it loads (or failed). */
  readonly original: VariationOriginal | null;
  readonly draft: ReviewDraft;
  /** Shown instead of the diff while `original` is null. */
  readonly originalPending?: string;
  /** Deep link of a cited page (document viewer at `?page=`); null = plain text. */
  readonly pageHref?: (documentId: string, page: number) => string | null;
  /** Heading level of the block titles inside (default 4: under the draft's h3). */
  readonly headingLevel?: 3 | 4;
  /** Extra controls under the validation state (e.g. confirming a changed type). */
  readonly actions?: ReactNode;
}

export function DiffText({ segments }: { segments: readonly DiffSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'insert' ? (
          <ins key={index} className={styles.ins}>
            {segment.text}
          </ins>
        ) : segment.kind === 'delete' ? (
          <del key={index} className={styles.del}>
            {segment.text}
          </del>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** "검증 통과" when nothing blocks approval; otherwise the number of blocking items. */
export function ValidationState({ draft }: { draft: ReviewDraft }) {
  const errors = draft.issues.filter((i) => i.severity === 'error').length;
  const warnings = draft.issues.length - errors;
  if (errors === 0 && (draft.publishable || draft.publishedQuestionId !== null)) {
    return (
      <p className={styles.validation} data-state="ok">
        <CheckIcon width={14} height={14} aria-hidden="true" />
        <span>검증 통과</span>
        {warnings > 0 ? <span className={styles.muted}> · 확인할 항목 {warnings}건</span> : null}
      </p>
    );
  }
  return (
    <p className={styles.validation} data-state="blocked">
      <AlertIcon width={14} height={14} aria-hidden="true" />
      <span>
        승인 전에 고쳐야 할 항목 {Math.max(errors, 1)}건
        {warnings > 0 ? ` · 확인할 항목 ${warnings}건` : ''}
      </span>
    </p>
  );
}

export function VariationDiffViewer({
  original,
  draft,
  pageHref,
  headingLevel = 4,
  actions,
  originalPending,
}: VariationDiffViewerProps) {
  const H = `h${headingLevel}` as const;
  const info = draft.generation;
  return (
    <div className={styles.diff}>
      <div className={styles.diffHeader}>
        <H className={styles.diffTitle}>원본 대비 변경</H>
        {info?.variationType ? (
          <Badge tone="accent">{VARIATION_LABELS[info.variationType]}</Badge>
        ) : null}
      </div>
      <p className={styles.legend}>밑줄은 추가된 말, 취소선은 빠진 말입니다.</p>

      {original ? (
        <Changes original={original} draft={draft} />
      ) : (
        <p className={styles.muted}>{originalPending ?? '생성 당시 원본을 불러오는 중입니다.'}</p>
      )}

      {info?.justification ? (
        <p className={styles.note}>
          <span className={styles.noteLabel}>정답 근거</span> {info.justification}
        </p>
      ) : null}

      {info && info.evidence.length > 0 ? (
        <div className={styles.evidence}>
          <H className={styles.diffTitle}>문서 근거</H>
          {info.evidence.map((e, index) => (
            <div key={`${e.documentId}-${index}`} className={styles.evidenceItem}>
              {e.quote ? <blockquote className={styles.quote}>{e.quote}</blockquote> : null}
              <p className={styles.evidencePages}>
                {e.pages.map((page) => {
                  const href = pageHref?.(e.documentId, page) ?? null;
                  return href ? (
                    <Link key={page} href={href} className={styles.link}>
                      {page}쪽
                    </Link>
                  ) : (
                    <span key={page}>{page}쪽</span>
                  );
                })}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <div className={styles.validationRow}>
        <ValidationState draft={draft} />
        {actions}
      </div>
    </div>
  );
}

/** Stem and option changes of `draft` against `original`. */
function Changes({ original, draft }: { original: VariationOriginal; draft: ReviewDraft }) {
  const stem = diffWords(original.stem, draft.stem);
  const options =
    draft.type === 'MCQ' || original.options.length > 0
      ? diffOptions(original.options, draft.options)
      : [];
  const optionsChanged = options.some((o) => o.change !== 'same' || o.answerChanged);
  return (
    <>
      <p className={styles.diffStem}>
        {unchanged(stem) ? <span className={styles.muted}>문제 문구 변경 없음: </span> : null}
        <DiffText segments={stem} />
      </p>

      {options.length > 0 ? (
        optionsChanged ? (
          <div className={styles.diffOptions}>
            {options.map((o, index) => {
              const correctNow = o.after?.correct ?? false;
              return (
                <p
                  key={`${o.after?.id ?? o.before?.id ?? index}-${o.change}`}
                  className={styles.diffOption}
                  data-change={o.change}
                >
                  <span className={styles.optionNumber}>
                    {o.after ? `${draft.options.indexOf(o.after) + 1}.` : '−'}
                  </span>
                  <span>
                    <DiffText segments={o.segments} />
                  </span>
                  {correctNow ? <span className={styles.mark}>정답</span> : null}
                  {o.answerChanged ? (
                    <span className={styles.mark}>
                      {correctNow ? '원본에서는 오답' : '원본에서는 정답'}
                    </span>
                  ) : null}
                  {o.change === 'removed' ? <span className={styles.mark}>빠진 보기</span> : null}
                  {o.change === 'added' ? <span className={styles.mark}>새 보기</span> : null}
                </p>
              );
            })}
          </div>
        ) : (
          <p className={styles.muted}>보기와 정답은 원본과 같습니다.</p>
        )
      ) : null}
    </>
  );
}

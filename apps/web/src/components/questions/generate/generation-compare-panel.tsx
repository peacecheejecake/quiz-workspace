'use client';

// "원본 비교" for QGEN-01: the source question next to the generated variant in the shared
// FloatingSidePanel, wide (≥ 600px comparison drawer, design-system §5.1 — the review needs more
// room than the 500px panel). Non-modal, so the draft list stays usable while it is open.
import { FloatingSidePanel } from '@quiz/ui';
import { draftNumber, type ReviewDraft } from '@/lib/questions/drafts';
import { VariationDiffViewer, type VariationOriginal } from './variation-diff-viewer';
import styles from './question-generation.module.css';

export interface GenerationComparePanelProps {
  readonly original: VariationOriginal;
  /** Null while closed. */
  readonly draft: ReviewDraft | null;
  readonly onClose: () => void;
  readonly pageHref: (documentId: string, page: number) => string | null;
}

export function GenerationComparePanel({
  original,
  draft,
  onClose,
  pageHref,
}: GenerationComparePanelProps) {
  return (
    <FloatingSidePanel
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      modal={false}
      size="wide"
      mobileLayout="full"
      title="원본과 비교"
      description={
        draft ? `원본 문제와 ${draftNumber(draft)}번 변형 초안을 나란히 봅니다.` : undefined
      }
      closeLabel="비교 닫기"
    >
      {draft ? (
        <div className={styles.compare}>
          <section className={styles.compareColumn} aria-labelledby="qgen-compare-original">
            <h3 id="qgen-compare-original" className={styles.diffTitle}>
              원본
            </h3>
            <p className={styles.compareStem}>{original.stem}</p>
            {original.options.length > 0 ? (
              <ol className={styles.compareOptions}>
                {original.options.map((o) => (
                  <li key={o.id}>
                    {o.text}
                    {o.correct ? <span className={styles.mark}>정답</span> : null}
                  </li>
                ))}
              </ol>
            ) : null}
          </section>
          <section className={styles.compareColumn} aria-labelledby="qgen-compare-variant">
            <h3 id="qgen-compare-variant" className={styles.diffTitle}>
              {draftNumber(draft)}번 변형
            </h3>
            <p className={styles.compareStem}>{draft.stem}</p>
            {draft.options.length > 0 ? (
              <ol className={styles.compareOptions}>
                {draft.options.map((o) => (
                  <li key={o.id}>
                    {o.text}
                    {o.correct ? <span className={styles.mark}>정답</span> : null}
                  </li>
                ))}
              </ol>
            ) : null}
          </section>
          <div className={styles.compareDiff}>
            <VariationDiffViewer
              original={original}
              draft={draft}
              pageHref={pageHref}
              headingLevel={3}
            />
          </div>
        </div>
      ) : null}
    </FloatingSidePanel>
  );
}

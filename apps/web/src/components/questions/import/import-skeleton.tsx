// QIMPORT-02 / QOV-01-AC09: the import page's route skeleton — header blocks, then the `검토할 PDF`
// column and the review side by side (one column below 768px). Decorative blocks inside an
// `aria-busy` region with a text status.
import { Skeleton } from '@quiz/ui';
import styles from './import-review-layout.module.css';

export function ImportSkeleton() {
  return (
    <div aria-busy="true" className={styles.screen}>
      <p role="status" className="qz-visually-hidden">
        문제 PDF 가져오기를 불러오는 중입니다.
      </p>
      <Skeleton width="16rem" />
      <Skeleton shape="rect" width="14rem" height="2rem" />
      <div className={styles.columns}>
        <div className={styles.listColumn}>
          <Skeleton width="8rem" />
          <Skeleton shape="rect" height="4rem" />
          <Skeleton shape="rect" height="4rem" />
          <Skeleton shape="rect" height="4rem" />
        </div>
        <div className={styles.reviewColumn}>
          <Skeleton width="12rem" />
          <Skeleton shape="rect" height="4.5rem" />
          <Skeleton shape="rect" height="4.5rem" />
          <Skeleton shape="rect" height="4.5rem" />
        </div>
      </div>
    </div>
  );
}

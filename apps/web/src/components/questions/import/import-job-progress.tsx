// ImportJobProgress (docs/design-system.md component list): the step and progress of a question
// PDF import — upload, PDF processing, question extraction. The step is text; the bar is an
// accessible progressbar named "가져오기 진행률" (indeterminate when the job reports no progress).
import styles from './question-import.module.css';

export type ImportStep = 'uploading' | 'processing' | 'starting' | 'extracting';

export const IMPORT_STEP_LABELS: Readonly<Record<ImportStep, string>> = {
  uploading: 'PDF 업로드 중',
  processing: 'PDF 분석 중',
  starting: '문제 추출 준비 중',
  extracting: '문제 추출 중',
};

/** Once the PDF is uploaded the server finishes processing and extraction on its own
 * (QIMPORT-01-AC06): only the upload itself needs the page. */
export const IMPORT_BACKGROUND_HINT =
  '이 페이지를 떠나도 PDF 분석과 문제 추출은 서버에서 계속됩니다. 다시 열면 결과를 이어서 볼 수 있습니다.';

export interface ImportJobProgressProps {
  readonly step: ImportStep;
  /** 0-100; undefined = indeterminate. */
  readonly value?: number;
  readonly filename?: string;
}

export function ImportJobProgress({ step, value, filename }: ImportJobProgressProps) {
  const indeterminate = value === undefined;
  const label = IMPORT_STEP_LABELS[step];
  return (
    <div className={styles.progressBox}>
      <p className={styles.progressText}>
        {label}
        {filename ? <span className={styles.progressFile}> · {filename}</span> : null}
        {indeterminate ? null : <span> · {value}%</span>}
      </p>
      <div
        role="progressbar"
        aria-label="가져오기 진행률"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : value}
        aria-valuetext={indeterminate ? label : `${label} ${value}%`}
        className={styles.progress}
        data-indeterminate={indeterminate || undefined}
      >
        <div
          className={styles.progressFill}
          style={indeterminate ? undefined : { width: `${value}%` }}
        />
      </div>
      {step === 'uploading' ? null : (
        <p className={styles.progressHint}>{IMPORT_BACKGROUND_HINT}</p>
      )}
    </div>
  );
}

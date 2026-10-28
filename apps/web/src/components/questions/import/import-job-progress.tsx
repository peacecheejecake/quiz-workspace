// ImportJobProgress (docs/design-system.md component list): the step and progress of a question
// PDF import — upload, PDF processing, question extraction. The step is text and a step list
// 업로드 → PDF 분석 → 문제 추출 (UX6-PROGRESS StepProgress) over one bar named "가져오기 진행률"
// whose segment per step fills in turn, so it never drops back when the next step starts at 0 %
// (indeterminate while the current step reports no progress).
import { StepProgress } from '@quiz/ui';
import styles from './question-import.module.css';

export type ImportStep = 'uploading' | 'processing' | 'starting' | 'extracting';

/** The visible steps; `starting` (the extraction being started) belongs to 문제 추출. */
export const IMPORT_STEPS = [
  { id: 'upload', label: '업로드' },
  { id: 'process', label: 'PDF 분석' },
  { id: 'extract', label: '문제 추출' },
] as const;

const STEP_INDEX: Readonly<Record<ImportStep, number>> = {
  uploading: 0,
  processing: 1,
  starting: 2,
  extracting: 2,
};

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
      <StepProgress
        className={styles.progress}
        label="가져오기 진행률"
        steps={IMPORT_STEPS}
        current={STEP_INDEX[step]}
        value={value}
        currentText={label}
      />
      {step === 'uploading' ? null : (
        <p className={styles.progressHint}>{IMPORT_BACKGROUND_HINT}</p>
      )}
    </div>
  );
}

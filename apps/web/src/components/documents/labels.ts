// DOC-01 display labels (Korean first). Status text always accompanies color (Badge dot is
// secondary), so state is never conveyed by color alone.
import type { DocumentType } from '@/lib/documents/client-api';
import type { DocumentRow, UploadPhase } from '@/lib/documents/upload-machine';

export const DOCUMENT_TYPE_LABELS: Readonly<Record<DocumentType, string>> = {
  book: '책',
  question_paper: '문제지',
};

const UPLOAD_PHASE_LABELS: Partial<Record<UploadPhase, string>> = {
  hashing: '파일 확인 중',
  requesting: '업로드 준비 중',
  uploading: '업로드 중',
  completing: '업로드 확인 중',
};

export function uploadPhaseLabel(phase: UploadPhase): string {
  return UPLOAD_PHASE_LABELS[phase] ?? '업로드 중';
}

const STAGE_LABELS: Readonly<Record<string, string>> = {
  loading: '파일 읽는 중',
  downloading: '파일 읽는 중',
  parsing: '파싱 중',
  structuring: '분석 중',
  chunking: '분석 중',
  indexing: '색인 중',
  publishing: '게시 중',
};

/** "처리 대기 중" / "처리 중 · 색인 중" for a processing row. */
export function processingLabel(row: DocumentRow): string {
  const job = row.job;
  if (!job || job.status === 'queued') return '처리 대기 중';
  const stage = job.stage ? (STAGE_LABELS[job.stage] ?? '처리 중') : null;
  return stage && stage !== '처리 중' ? `처리 중 · ${stage}` : '처리 중';
}

export function percent(loaded: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
}

const DATE_FORMAT = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Seoul',
});

export function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : DATE_FORMAT.format(date);
}

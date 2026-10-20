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

/** "처리 대기 중" / "처리 준비 중" / "처리 중 · 색인 중" for a processing row. */
export function processingLabel(row: DocumentRow): string {
  const job = row.job;
  if (!job || job.status === 'queued') return '처리 대기 중';
  // A cold worker loads the parser's models first (UX3-JOB, DOC-01-AC05).
  if (job.stage === 'preparing') return '처리 준비 중';
  const stage = job.stage ? (STAGE_LABELS[job.stage] ?? '처리 중') : null;
  return stage && stage !== '처리 중' ? `처리 중 · ${stage}` : '처리 중';
}

/** After this long without finishing, a processing row shows its elapsed time and a hint. */
export const SLOW_PROCESSING_MS = 30_000;
export const SLOW_PROCESSING_HINT = '첫 처리나 큰 PDF는 몇 분 걸릴 수 있습니다.';

/** "45초", "3분 5초", "1시간 2분". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
  if (minutes > 0) return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`;
  return `${seconds}초`;
}

/**
 * "3분 5초째 대기 중" / "3분 5초째 처리 중" once a processing row's job has waited or run longer
 * than SLOW_PROCESSING_MS (queued: since it was queued; running: since it started), else null.
 * Timestamps come from the server, so a client clock behind it never shows a negative time.
 */
export function processingElapsed(row: DocumentRow, now: number): string | null {
  const job = row.job;
  if (row.status !== 'processing' || !job) return null;
  if (job.status !== 'queued' && job.status !== 'running') return null;
  const since = job.status === 'running' ? (job.startedAt ?? job.queuedAt) : job.queuedAt;
  const start = since ? Date.parse(since) : Number.NaN;
  if (Number.isNaN(start) || now - start <= SLOW_PROCESSING_MS) return null;
  return `${formatElapsed(now - start)}째 ${job.status === 'queued' ? '대기' : '처리'} 중`;
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

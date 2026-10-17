// DOC-01-AC03 client-side checks, mirroring the API (apps/api documents.py upload-intent): a PDF
// (`.pdf` name, application/pdf) of 1 byte .. 50 MiB. The API and Storage enforce the same rules;
// these only spare the user a round trip and give the reason up front.

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const PDF_CONTENT_TYPE = 'application/pdf';
/** Above this size the upload uses TUS (resumable, 6 MiB chunks as Supabase Storage requires). */
export const RESUMABLE_THRESHOLD_BYTES = 6 * 1024 * 1024;

export const FILE_REJECTION_MESSAGES = {
  type: 'PDF 파일(.pdf)만 업로드할 수 있습니다.',
  size: '파일이 너무 큽니다. PDF는 최대 50MB(50MiB)까지 업로드할 수 있습니다.',
  empty: '빈 파일은 업로드할 수 없습니다.',
} as const;

export type FileRejection = keyof typeof FILE_REJECTION_MESSAGES;

export interface FileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

export type FileCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: FileRejection; readonly message: string };

/** Accepts `.pdf` files whose browser-reported type is application/pdf (or unknown). */
export function validatePdfFile(file: FileLike): FileCheck {
  const type = file.type.trim().toLowerCase();
  const isPdf =
    file.name.toLowerCase().endsWith('.pdf') && (type === '' || type === PDF_CONTENT_TYPE);
  if (!isPdf) return reject('type');
  if (file.size > MAX_UPLOAD_BYTES) return reject('size');
  if (file.size <= 0) return reject('empty');
  return { ok: true };
}

function reject(reason: FileRejection): FileCheck {
  return { ok: false, reason, message: FILE_REJECTION_MESSAGES[reason] };
}

/** Display title the API defaults to: the file name without its extension. */
export function defaultTitle(filename: string): string {
  const stem = filename
    .replace(/\.[^.]*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stem || filename;
}

/** "512 B", "3.4 KB", "12.0 MB" (binary units, as the 50 MiB limit). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

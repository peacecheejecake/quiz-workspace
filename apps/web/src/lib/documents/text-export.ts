// DOC-03 full-text export in the browser: fetch the file from this app's relay
// (`/api/documents/:id/text`, bff.ts), save it through a blob link (a real download with the
// server's file name) or copy its Markdown to the clipboard. The text stays in memory only: it is
// never logged, stored or put into a URL.

export type TextExportFormat = 'md' | 'txt';
/** `published`, the correction `draft`, or one revision's id (the revision DOC-02 shows). */
export type TextExportRevision = 'published' | 'draft' | (string & {});

export const TEXT_EXPORT_MESSAGES = {
  notReady: '아직 처리 중인 문서입니다.',
  failed: '텍스트를 내보내지 못했습니다. 다시 시도하세요.',
  copied: '복사했습니다',
  copyFailed: '복사하지 못했습니다. 파일로 내려받으세요.',
} as const;

const DOCUMENT_NOT_READY = 'urn:quiz-workspace:problem:document-not-ready';

export class TextExportError extends Error {
  constructor(readonly reason: 'notReady' | 'failed') {
    super(TEXT_EXPORT_MESSAGES[reason]);
    this.name = 'TextExportError';
  }
}

export function textExportPath(
  documentId: string,
  format: TextExportFormat,
  revision: TextExportRevision = 'published',
): string {
  const query = `format=${format}${revision === 'published' ? '' : `&revision=${encodeURIComponent(revision)}`}`;
  return `/api/documents/${encodeURIComponent(documentId)}/text?${query}`;
}

/** The RFC 5987 `filename*` (or the plain `filename`) of an attachment Content-Disposition. */
export function attachmentName(header: string | null): string | null {
  if (!header || !/^attachment\b/i.test(header)) return null;
  let plain: string | null = null;
  for (const part of header.split(';').slice(1)) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim();
    if (name === 'filename*' && /^utf-8''/i.test(value)) {
      try {
        return decodeURIComponent(value.slice("utf-8''".length));
      } catch {
        continue;
      }
    }
    if (name === 'filename') plain = value.replace(/^"(.*)"$/, '$1');
  }
  return plain;
}

function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** File name the browser saves when the server's header is unusable: `<title>.<ext>`. */
export function fallbackName(
  title: string,
  format: TextExportFormat,
  revision: TextExportRevision,
): string {
  const base =
    Array.from(title)
      .filter((c) => c !== '/' && c !== '\\' && !isControl(c))
      .join('')
      .trim() || 'document';
  return `${base.slice(0, 120)}${revision === 'draft' ? ' (초안)' : ''}.${format}`;
}

export interface ExportedText {
  readonly name: string;
  readonly blob: Blob;
}

type FetchLike = typeof fetch;

export async function fetchDocumentText(
  documentId: string,
  title: string,
  format: TextExportFormat,
  revision: TextExportRevision,
  fetchImpl: FetchLike = (...a) => fetch(...a),
): Promise<ExportedText> {
  let response: Response;
  try {
    response = await fetchImpl(textExportPath(documentId, format, revision), {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new TextExportError('failed');
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const type = typeof body === 'object' && body !== null ? (body as { type?: unknown }).type : '';
    throw new TextExportError(
      response.status === 409 && type === DOCUMENT_NOT_READY ? 'notReady' : 'failed',
    );
  }
  const bytes = await response.arrayBuffer();
  const type = format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8';
  return {
    name:
      attachmentName(response.headers.get('content-disposition')) ??
      fallbackName(title, format, revision),
    blob: new Blob([bytes], { type }),
  };
}

/** Saves `file` as a download (an `<a download>` on a short-lived object URL). */
export function saveExportedText(file: ExportedText): void {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Revoke after the browser picked the download up.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/**
 * Copies the text `load` resolves to. With `ClipboardItem` the write starts inside the user's
 * click (Safari requires that) and the text arrives as a promise; otherwise it is written once
 * loaded. Rejects when the clipboard refuses or `load` fails.
 */
export async function copyText(load: () => Promise<string>): Promise<void> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clipboard) throw new Error('clipboard unavailable');
  const text = load();
  if (typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
    const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
    try {
      await clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return;
    } catch (error) {
      // A failed load is final; a refused promise-item write falls back to writeText.
      await text;
      if (typeof clipboard.writeText !== 'function') throw error;
    }
  }
  await clipboard.writeText(await text);
}

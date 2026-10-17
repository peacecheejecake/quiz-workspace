// Display helpers shared by the QBANK-01 list, detail panel and editor.
import type { Question } from '@/lib/questions/form';
import type { ChapterOption, DocumentOption } from '@/lib/questions/server';

export type QuestionSource = Question['sources'][number];

/** "4쪽" / "4–6쪽" (pageLabel in the E2E fixtures); null without a page. */
export function pageText(source: Pick<QuestionSource, 'page_start' | 'page_end'>): string | null {
  const start = source.page_start;
  if (start == null) return null;
  const end = source.page_end;
  return end != null && end !== start ? `${start}–${end}쪽` : `${start}쪽`;
}

/** Document viewer deep link for a source (DOC-02 opens at `?page=`). */
export function sourceHref(workspaceId: string, source: QuestionSource): string | null {
  if (!source.document_id) return null;
  const base = `/workspaces/${workspaceId}/documents/${source.document_id}`;
  return source.page_start != null ? `${base}?page=${source.page_start}` : base;
}

export function documentTitle(
  documents: readonly DocumentOption[],
  documentId: string | null,
): string {
  return documents.find((d) => d.id === documentId)?.title ?? '출처 문서';
}

/** Chapter option label; the document title disambiguates when several books are ready. */
export function chapterLabel(chapter: ChapterOption, withDocument: boolean): string {
  return withDocument ? `${chapter.title} (${chapter.documentTitle})` : chapter.title;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(date);
}

export const NO_CHAPTER_TITLE = '챕터 없음';

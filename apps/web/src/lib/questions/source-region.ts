// QSRC-01 문제 원문 보기 (docs/screens/question-source-preview.md): the client of this app's
// same-origin source-region relays. The response holds only document id, revision id, page and
// bbox; the PDF itself comes from the source-url relay. A 404 (or any failure) means "no button".
import type { Schemas } from '@quiz/api-client';

export type SourceRegion = Schemas['SourceRegionItem'];

export interface SourceRegionTarget {
  readonly kind: 'question' | 'mock';
  readonly id: string;
}

export function sourceRegionPath(target: SourceRegionTarget): string {
  const id = encodeURIComponent(target.id);
  return target.kind === 'question'
    ? `/api/questions/${id}/source-region`
    : `/api/mock-exam-questions/${id}/source-region`;
}

/** The regions to show, or null when the question has none (404) or the request failed. */
export async function fetchSourceRegions(
  target: SourceRegionTarget,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<readonly SourceRegion[] | null> {
  try {
    const response = await fetchImpl(sourceRegionPath(target), {
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { regions?: unknown };
    if (!Array.isArray(body.regions)) return null;
    const regions = (body.regions as SourceRegion[]).filter(isDrawable);
    return regions.length > 0 ? regions : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

function isDrawable(r: SourceRegion): boolean {
  const b = r.bbox;
  return (
    r.page >= 1 && [b.x0, b.y0, b.x1, b.y1].every(Number.isFinite) && b.x1 > b.x0 && b.y1 > b.y0
  );
}

export interface FigureSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Display size of a region: the bbox's own aspect ratio, as large as `maxWidth` allows (and
 * `maxHeight` when given), never magnified past `maxScale` times its size in PDF points.
 */
export function fitRegion(
  bbox: SourceRegion['bbox'],
  maxWidth: number,
  maxHeight: number | null,
  maxScale = 3,
): FigureSize {
  const w = bbox.x1 - bbox.x0;
  const h = bbox.y1 - bbox.y0;
  let scale = Math.min(Math.max(maxWidth, 1) / w, maxScale);
  if (maxHeight !== null) scale = Math.min(scale, Math.max(maxHeight, 1) / h);
  return { width: w * scale, height: h * scale };
}

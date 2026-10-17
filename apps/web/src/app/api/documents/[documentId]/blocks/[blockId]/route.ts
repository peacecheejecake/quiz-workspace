// DOC-02 relay: one canonical block (GET) and its correction into the draft revision (PATCH;
// editor+ and `base_version` conflicts are decided by the API).
import {
  forwardQuery,
  isBlockId,
  isUuid,
  notFound,
  problemResponse,
  relayToApi,
  REVISION_SELECTOR,
} from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

/** A block's text may be up to 200 000 characters (JSON-escaped, UTF-8). */
const MAX_CORRECTION_BYTES = 1024 * 1024;

type Ctx = RouteContext<'/api/documents/[documentId]/blocks/[blockId]'>;

async function target(ctx: Ctx): Promise<string | null> {
  const { documentId, blockId } = await ctx.params;
  let block: string;
  try {
    block = decodeURIComponent(blockId);
  } catch {
    return null;
  }
  if (!isUuid(documentId) || !isBlockId(block)) return null;
  return `/documents/${documentId}/blocks/${encodeURIComponent(block)}`;
}

export async function GET(request: Request, ctx: Ctx) {
  const path = await target(ctx);
  if (path === null) return notFound();
  const query = forwardQuery(request, { revision: REVISION_SELECTOR });
  if (query === null) return problemResponse(400, 'Bad Request', 'Invalid query parameters.');
  return relayToApi(`${path}${query}`, { method: 'GET' });
}

export async function PATCH(request: Request, ctx: Ctx) {
  const path = await target(ctx);
  if (path === null) return notFound();
  return relayToApi(path, { method: 'PATCH', body: request, maxBodyBytes: MAX_CORRECTION_BYTES });
}

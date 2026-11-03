// HILITE-01 relay (write): a new highlight of the signed-in reader (a note version's item or a
// question's explanation), merging the overlapping ones it names (`replace_ids`). The browser's
// Idempotency-Key makes a retried request yield the same highlight. FastAPI checks membership and
// cuts the quote from the stored text itself.
import { relayToApi } from '@/lib/documents/bff';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return relayToApi('/my-highlights', {
    method: 'POST',
    body: request,
    idempotencyFrom: request,
  });
}

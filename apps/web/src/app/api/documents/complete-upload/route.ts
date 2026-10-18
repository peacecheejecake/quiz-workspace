// DOC-01 relay: complete-upload (202 + job id; idempotent per upload intent).
import { relayToApi } from '@/lib/documents/bff';

export async function POST(request: Request) {
  return relayToApi('/documents/complete-upload', { method: 'POST', body: request });
}

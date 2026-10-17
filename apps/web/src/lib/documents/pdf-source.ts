// Original PDF bytes for the DOC-02 viewer. FastAPI hands out a short-lived signed Storage URL
// (`GET /documents/{id}/source-url`, ~300 s); we download the whole file once with a plain GET
// (HTTP 200, no range requests — the bytes are hashed by DOC-02-AC02 and PDF.js then works from
// memory, so the URL expiring later does not matter). A URL that is about to expire, or that
// Storage refuses (expired/invalid signature), is replaced by a fresh one and the download is
// tried once more. The signed URL is never logged, stored or put into a page URL.
import type { SignedReadUrl } from './editor-api';

export type PdfLoadFailure = 'network' | 'expired' | 'unavailable' | 'tooLarge';

export const PDF_LOAD_MESSAGES: Readonly<Record<PdfLoadFailure, string>> = {
  network: 'PDF를 불러오지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.',
  expired: 'PDF 열람 링크가 만료되었습니다. 다시 시도하면 새 링크로 불러옵니다.',
  unavailable: 'PDF 원본을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
  tooLarge: 'PDF 원본이 너무 커서 열 수 없습니다.',
};

export class PdfLoadError extends Error {
  constructor(readonly kind: PdfLoadFailure) {
    super(PDF_LOAD_MESSAGES[kind]);
    this.name = 'PdfLoadError';
  }
}

/** Refresh a signed URL this long before it expires (clock skew, slow first byte). */
export const EXPIRY_MARGIN_MS = 20_000;
/** Upload limit is 50 MiB; anything far beyond is not ours. */
const MAX_PDF_BYTES = 64 * 1024 * 1024;

export type SignedUrlSource = (signal?: AbortSignal) => Promise<SignedReadUrl>;

/** Caches the current signed URL and asks for a new one when it is (about to be) expired. */
export class SignedUrlCache {
  private current: SignedReadUrl | null = null;

  constructor(
    private readonly source: SignedUrlSource,
    private readonly now: () => number = () => Date.now(),
    private readonly marginMs = EXPIRY_MARGIN_MS,
  ) {}

  isFresh(url: SignedReadUrl | null): url is SignedReadUrl {
    if (url === null) return false;
    const expires = Date.parse(url.expires_at);
    return Number.isFinite(expires) && expires - this.now() > this.marginMs;
  }

  async get(signal?: AbortSignal, { force = false } = {}): Promise<string> {
    if (force || !this.isFresh(this.current)) this.current = await this.source(signal);
    return this.current.url;
  }

  invalidate(): void {
    this.current = null;
  }
}

/** Storage answers an expired or tampered signature with 400 (`InvalidJWT`), 401 or 403. */
function looksExpired(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

/** Downloads the whole PDF (one 200 GET), refreshing the signed URL once if Storage refuses it. */
export async function loadPdfBytes(
  urls: SignedUrlCache,
  {
    signal,
    fetchImpl = (...a) => fetch(...a),
  }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const url = await urls.get(signal, { force: attempt > 0 });
    let response: Response;
    try {
      response = await fetchImpl(url, {
        signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new PdfLoadError('network');
    }
    if (response.ok) {
      if (Number(response.headers.get('content-length') ?? 0) > MAX_PDF_BYTES) {
        await response.body?.cancel();
        throw new PdfLoadError('tooLarge');
      }
      return new Uint8Array(await response.arrayBuffer());
    }
    await response.body?.cancel().catch(() => undefined);
    if (!looksExpired(response.status)) throw new PdfLoadError('unavailable');
    urls.invalidate();
  }
  throw new PdfLoadError('expired');
}

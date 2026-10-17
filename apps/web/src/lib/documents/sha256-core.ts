// Shared by the hashing worker and its main-thread fallback (no DOM or worker globals).

export interface HashRequest {
  readonly id: number;
  readonly blob: Blob;
}

export type HashResponse =
  { readonly id: number; readonly hex: string } | { readonly id: number; readonly error: true };

export function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lower-case hex SHA-256 of the blob (WebCrypto; asynchronous, native implementation). */
export async function digestBlob(blob: Blob): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
}

// Client-side Idempotency-Key bookkeeping for "create workspace": one key per intended creation.
// A retry or double submit of the same name reuses the key (the API replays the first result);
// a different name, a success, or a `idempotency-key-reused` conflict starts a new key.

export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Non-secure contexts lack randomUUID; build a v4 UUID from getRandomValues.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface PendingCreate {
  readonly key: string;
  readonly name: string;
}

/** The key to send for `name`, reusing `current` when it was minted for the same name. */
export function keyForAttempt(
  current: PendingCreate | null,
  name: string,
  mint: () => string = newIdempotencyKey,
): PendingCreate {
  return current && current.name === name ? current : { key: mint(), name };
}

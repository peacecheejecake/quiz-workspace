/** Browser-only invalidation signal; only a verified server response can publish an ID. */
export const VERIFIED_USER_EVENT = 'quiz:verified-user';
export const VERIFIED_USER_PENDING_EVENT = 'quiz:verified-user-pending';
let verifiedUserId: string | null = null;
let pending = false;
let initialized = false;

export function currentVerifiedUserId(): string | null {
  return verifiedUserId;
}
export function hasVerifiedUser(): boolean {
  return initialized;
}
export function verifiedUserPending(): boolean {
  return pending;
}
export function suspendVerifiedUser(): void {
  if (pending) return;
  pending = true;
  if (typeof window !== 'undefined') {
    document.body.dataset.identityPending = 'true';
    window.dispatchEvent(new Event(VERIFIED_USER_PENDING_EVENT));
  }
}
export function publishVerifiedUser(id: string | null, keepSuspended = false): void {
  const changed = !initialized || verifiedUserId !== id;
  initialized = true;
  const wasPending = pending;
  verifiedUserId = id;
  pending = keepSuspended;
  if (typeof window !== 'undefined' && (changed || wasPending)) {
    if (!keepSuspended) delete document.body.dataset.identityPending;
    window.dispatchEvent(new CustomEvent(VERIFIED_USER_EVENT, { detail: id }));
  }
}

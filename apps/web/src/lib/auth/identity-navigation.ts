/** A confirmed account transition starts a new document with freshly verified server state. */
export function navigateForIdentity(id: string | null): void {
  window.location.replace(id ? '/workspaces' : '/login');
}

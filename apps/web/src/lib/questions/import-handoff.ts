// QIMPORT-01-AC05 (UX3c): a PDF dropped on the "문제 PDF 관리" dialog is handed to the import page,
// which starts its upload on arrival. The File stays in this tab's memory only (a client-side
// navigation keeps the module alive): never in a URL, storage or the server. One pending file at a
// time, bound to the workspace it was dropped in.

let pending: { readonly workspaceId: string; readonly file: File } | null = null;

export function setPendingImportFile(workspaceId: string, file: File): void {
  pending = { workspaceId, file };
}

/** The file waiting for `workspaceId`'s import page (not consumed). */
export function peekPendingImportFile(workspaceId: string): File | null {
  return pending?.workspaceId === workspaceId ? pending.file : null;
}

export function clearPendingImportFile(): void {
  pending = null;
}

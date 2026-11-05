/** Restore a rejected send only when the user has not edited the cleared composer since. */
export function recoverFailedDraft(
  snapshot: string,
  currentDraft: string,
  sentAtEdit: number,
  currentEdit: number,
): string {
  return sentAtEdit === currentEdit ? snapshot : currentDraft;
}

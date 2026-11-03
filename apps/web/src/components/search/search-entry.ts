'use client';

// SEARCH-02 "돌아가기" (docs/screens/search-page.md): the search page's BackLink acts like the
// browser's Back when the page was entered from the workspace home's `본문 검색` link, so the home
// comes back at the address it had (문제 search, filters) and Forward returns to the search; a page
// opened directly links to the home instead. The home's link marks the navigation it starts; the
// page, once mounted, records the mark in its own history entry (beside Next's keys), so it also
// holds after a reload, a trip to the PDF viewer and back, or Back/Forward.
const ENTRY_KEY = 'quizSearchFromHome';

let entering = false;

/** Called by the home's `본문 검색` link on a plain click (same tab). */
export function markSearchEntryFromHome(): void {
  entering = true;
}

/** Called once by the search page on mount: records an entry from the home in this entry. */
export function adoptSearchEntry(): void {
  if (!entering) return;
  entering = false;
  const state: unknown = window.history.state;
  const own = state !== null && typeof state === 'object' ? (state as Record<string, unknown>) : {};
  window.history.replaceState({ ...own, [ENTRY_KEY]: true }, '', window.location.href);
}

/** Whether this history entry of the search page was entered from the home. */
export function enteredFromHome(): boolean {
  const state: unknown = window.history.state;
  return (
    state !== null &&
    typeof state === 'object' &&
    (state as Record<string, unknown>)[ENTRY_KEY] === true
  );
}

/** Whether `event` is a plain left click that navigates in the same tab. */
export function isPlainClick(event: {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

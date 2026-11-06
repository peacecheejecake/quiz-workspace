let quiet = false;

/**
 * Moves focus to a dot without opening its preview: for programmatic focus return, such as after
 * the practice panel closes. The focus event fires inside `focus()`, so the flag covers it.
 */
export function focusQuestionDotQuietly(element: HTMLElement): void {
  quiet = true;
  try {
    element.focus();
  } finally {
    quiet = false;
  }
}

export function isQuietDotFocus(): boolean {
  return quiet;
}

/**
 * Inline edit controls inside a dialog (a rename field, an inline edit form) cancel their edit on
 * Escape. Radix handles Escape on the document in the capture phase, before the control's own
 * keydown handler, so a dialog would close instead. Marking the control with these props makes
 * `FloatingSidePanel` and `ModalDialog` leave such a press to it; the next Escape (focus back on
 * the control that started the edit) closes the dialog as usual.
 */
export const ownEscapeProps = { 'data-own-escape': '' } as const;

/** Whether an Escape press started inside an element marked with `ownEscapeProps`. */
export function handlesOwnEscape(event: Event): boolean {
  const target = event.target;
  return target instanceof Element && target.closest('[data-own-escape]') !== null;
}

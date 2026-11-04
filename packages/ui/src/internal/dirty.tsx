'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

/**
 * Unsaved input inside a modal panel or dialog (design-system §5.5, HOMEDLG-01): while any part of
 * the dialog reports unsaved input, a backdrop click leaves the dialog open. Parts deep inside a
 * dialog (a form, an inline rename field) report through `useUnsavedChanges` instead of threading
 * a flag up to the dialog's `dirty` prop.
 */
type Report = (id: object, dirty: boolean) => void;

const DirtyContext = createContext<Report | null>(null);

/** Wraps a dialog's content so `useUnsavedChanges` below it reports to that dialog. */
export const DirtyProvider = DirtyContext.Provider;

/** The dialog side: whether any descendant reports unsaved input, and the value to provide. */
export function useDirtyRegistry(): { readonly dirty: boolean; readonly report: Report } {
  const [reporters, setReporters] = useState<ReadonlySet<object>>(() => new Set());
  const report = useCallback<Report>((id, dirty) => {
    setReporters((prev) => {
      if (prev.has(id) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  return { dirty: reporters.size > 0, report };
}

/**
 * Marks the enclosing `FloatingSidePanel`/`ModalDialog` as holding unsaved input while `dirty`
 * (e.g. a typed but unsaved name): its backdrop click then does nothing. Outside a dialog it is a
 * no-op. Unmounting clears the report.
 */
export function useUnsavedChanges(dirty: boolean): void {
  const report = useContext(DirtyContext);
  const [id] = useState(() => ({}));
  useEffect(() => {
    report?.(id, dirty);
  }, [report, id, dirty]);
  useEffect(() => () => report?.(id, false), [report, id]);
}

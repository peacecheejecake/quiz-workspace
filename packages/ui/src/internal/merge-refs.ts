'use client';

import { useCallback, type Ref, type RefCallback } from 'react';

function attach<T>(ref: Ref<T> | undefined, el: T): () => void {
  if (typeof ref === 'function') {
    const cleanup = ref(el);
    return typeof cleanup === 'function' ? cleanup : () => ref(null);
  }
  if (ref) {
    ref.current = el;
    return () => {
      ref.current = null;
    };
  }
  return () => undefined;
}

/** One callback ref that feeds both refs (callback refs may return a React 19 cleanup). */
export function useMergedRefs<T>(a: Ref<T> | undefined, b: Ref<T> | undefined): RefCallback<T> {
  return useCallback(
    (el: T | null) => {
      if (el === null) return undefined;
      const detachA = attach(a, el);
      const detachB = attach(b, el);
      return () => {
        detachA();
        detachB();
      };
    },
    [a, b],
  );
}

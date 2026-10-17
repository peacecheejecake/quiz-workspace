import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom lacks the layout APIs Radix poppers and scroll locking touch.
const noop = (): void => undefined;

class ResizeObserverStub {
  observe = noop;
  unobserve = noop;
  disconnect = noop;
}
globalThis.ResizeObserver ??= ResizeObserverStub;

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: noop,
      removeEventListener: noop,
      addListener: noop,
      removeListener: noop,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// axe probes canvas for icon-font detection; jsdom has none and would log on every call.
HTMLCanvasElement.prototype.getContext = () => null;

Element.prototype.scrollIntoView ??= noop;
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= noop;

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});

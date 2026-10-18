// Setup for component tests (files that opt into `// @vitest-environment jsdom`).
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

const noop = (): void => undefined;

// jsdom lacks the layout APIs Radix poppers and scroll locking touch.
class ResizeObserverStub {
  observe = noop;
  unobserve = noop;
  disconnect = noop;
}
globalThis.ResizeObserver ??= ResizeObserverStub;
Element.prototype.scrollIntoView ??= noop;
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= noop;

afterEach(() => {
  cleanup();
});

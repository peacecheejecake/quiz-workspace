// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  currentVerifiedUserId,
  publishVerifiedUser,
  VERIFIED_USER_EVENT,
} from '../src/lib/auth/verified-user-events';

afterEach(() => publishVerifiedUser(null));
it('publishes each verified account transition synchronously and exposes the current ID', () => {
  const listener = vi.fn();
  window.addEventListener(VERIFIED_USER_EVENT, listener);
  publishVerifiedUser('account-a');
  expect(currentVerifiedUserId()).toBe('account-a');
  expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toBe('account-a');
  publishVerifiedUser('account-a');
  expect(listener).toHaveBeenCalledTimes(1);
  publishVerifiedUser(null);
  expect(currentVerifiedUserId()).toBeNull();
  expect((listener.mock.calls[1]?.[0] as CustomEvent).detail).toBeNull();
  window.removeEventListener(VERIFIED_USER_EVENT, listener);
});

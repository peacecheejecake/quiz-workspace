// @vitest-environment jsdom
import './dom-setup';
import { act, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useState } from 'react';
import {
  observedPracticeEpoch,
  practiceResetVersion,
  rememberPracticeEpoch,
  setPracticeViewer,
} from '../src/lib/questions/practice-reset-events';

vi.mock('../src/lib/supabase/client', () => ({
  getSupabaseBrowserClient: () => ({
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }) },
  }),
}));
const { PracticeViewerScope } =
  await import('../src/components/questions/viewer/practice-viewer-scope');

let nextSession = 0;
function PrivateSession() {
  const [id] = useState(() => ++nextSession);
  return <p>session {id}</p>;
}

it('switches verified users before rendering and rejects late work from the previous user', () => {
  const view = render(
    <PracticeViewerScope viewerId="user-a">
      <PrivateSession key="user-a" />
    </PracticeViewerScope>,
  );
  expect(screen.getByText('session 1')).toBeTruthy();
  rememberPracticeEpoch('workspace', 'question', 9);
  const oldVersion = practiceResetVersion('workspace', 'question');
  const oldResponse = () => {
    if (practiceResetVersion('workspace', 'question') === oldVersion)
      rememberPracticeEpoch('workspace', 'question', 9);
  };
  view.rerender(
    <PracticeViewerScope viewerId="user-b">
      <PrivateSession key="user-b" />
    </PracticeViewerScope>,
  );
  expect(screen.getByText('session 2')).toBeTruthy();
  expect(observedPracticeEpoch('workspace', 'question')).toBeUndefined();
  rememberPracticeEpoch('workspace', 'question', 1);
  act(oldResponse);
  expect(observedPracticeEpoch('workspace', 'question')).toBe(1);
  view.unmount();
  setPracticeViewer(null);
});

it('suspends without remount on uncertainty and invalidates old work on confirmed account change', async () => {
  const { publishVerifiedUser, suspendVerifiedUser } =
    await import('../src/lib/auth/verified-user-events');
  publishVerifiedUser('user-a');
  const view = render(
    <PracticeViewerScope viewerId="user-a">
      <PrivateSession />
    </PracticeViewerScope>,
  );
  const old = screen.getByText(/session/).textContent;
  rememberPracticeEpoch('workspace', 'question', 7);
  const version = practiceResetVersion('workspace', 'question');
  act(() => suspendVerifiedUser());
  expect(screen.getByText(old ?? '')).not.toBeVisible();
  act(() => publishVerifiedUser('user-a'));
  expect(screen.getByText(old ?? '')).toBeVisible();
  act(() => publishVerifiedUser('user-b'));
  expect(screen.queryByText(old ?? '')).toBeNull();
  expect(practiceResetVersion('workspace', 'question')).not.toBe(version);
  view.unmount();
  publishVerifiedUser(null);
});

it('does not mount a stale server scope after a different owner was confirmed', async () => {
  const { publishVerifiedUser } = await import('../src/lib/auth/verified-user-events');
  publishVerifiedUser('user-b');
  const view = render(
    <PracticeViewerScope viewerId="user-a">
      <PrivateSession />
    </PracticeViewerScope>,
  );
  expect(screen.queryByText(/session/)).toBeNull();
  view.unmount();
  publishVerifiedUser(null);
});

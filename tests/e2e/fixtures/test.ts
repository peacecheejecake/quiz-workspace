// Shared Playwright `test` for every E2E spec: import { test, expect } from '../fixtures/test'.
//
// Writing tests get their own users (and later workspaces/documents) per test; teardown deletes
// them even when the test fails. Fixtures refuse non-local URLs (see local-env.ts).
//
// Data fixtures (same pattern: create through the public API with per-test unique data, delete in
// teardown):
//   - `workspaceFactory` (M3.0): per-test members with an API session + workspaces through
//     /api/v1/workspaces; teardown purges every workspace owned by this test's users.
//   - documents.ts (M3.0): synthetic PDFs from tests/fixtures/pdfs through the public upload flow
//     (upload-intent → direct Storage upload → complete-upload), job polling, search.
//   - questions.ts (M4.0): questions, question-PDF imports and drafts through the public API,
//     the questions-ko paper truth, and the QBANK-01/QIMPORT-01 UI label contract.
//   - S0: owner/guest/recipient share fixtures on top of the two above.
// Never add test-only seed/reset endpoints to the production app (AGENTS.md §5).
import { test as base, expect } from '@playwright/test';
import { UserFactory } from './auth.ts';
import { deleteMessagesFor } from './mailpit.ts';
import { WorkspaceFactory } from './workspaces.ts';

export interface E2EFixtures {
  /** Per-test synthetic users (confirmed by default); all deleted after the test. */
  userFactory: UserFactory;
  /** Per-test members and workspaces (public API); purged before the users are deleted. */
  workspaceFactory: WorkspaceFactory;
}

export const test = base.extend<E2EFixtures>({
  // Playwright reads fixture dependencies from the destructuring pattern; none are needed here.
  // eslint-disable-next-line no-empty-pattern
  userFactory: async ({}, use) => {
    const factory = new UserFactory();
    try {
      await use(factory);
    } finally {
      await factory.cleanup();
      await Promise.all(factory.emails.map((email) => deleteMessagesFor(email)));
    }
  },
  // Torn down before `userFactory` (it depends on it), so users are deletable afterwards.
  workspaceFactory: async ({ userFactory }, use) => {
    const factory = new WorkspaceFactory(userFactory);
    try {
      await use(factory);
    } finally {
      factory.cleanup();
    }
  },
});

export { expect };
export type { AuthSession, CreateUserOptions, TestUser } from './auth.ts';
export {
  canSignIn,
  findUserIdByEmail,
  isEmailConfirmed,
  newCredentials,
  refreshStatus,
  requestPasswordRecovery,
  signIn,
  userExists,
  verifyTokenHashStatus,
} from './auth.ts';
export * from './auth-ui.ts';
export { ApiClient, PROBLEM_TYPES, type ApiResponse, type Problem } from './api.ts';
export * from './documents.ts';
export { attemptRevision, seedGradedAttempt, seedMembership } from './db.ts';
export * from './questions.ts';
export * from './workspace-ui.ts';
export { uniqueWorkspaceName, type Member, type Workspace } from './workspaces.ts';
export {
  deleteMessagesFor,
  extractLinks,
  waitForLatestMessage,
  waitForMailLink,
} from './mailpit.ts';

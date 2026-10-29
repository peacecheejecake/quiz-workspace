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
//     the questions-ko paper truth, and the QBANK-01/QIMPORT-01 UI label contract; M5.0 adds the
//     overview/practice/my-state/attempts API helpers and the QOV-01/QPLAY-01 UI contract.
//   - S0: owner/guest/recipient share fixtures on top of the two above.
//   - generation.ts (M6.0): scenario-driven source questions (fake LLM markers, G1), generation
//     run API helpers and the QGEN-01 UI contract.
//   - history.ts (M7.0): activities/jobs/attempts read-API helpers, document corrections that
//     produce history, and the HISTORY-01 UI contract.
// Never add test-only seed/reset endpoints to the production app (AGENTS.md §5).
import { test as base, expect } from '@playwright/test';
import { UserFactory } from './auth.ts';
import { FakeTurnstile } from './turnstile.ts';
import { deleteMessagesFor } from './mailpit.ts';
import { WorkspaceFactory } from './workspaces.ts';

export interface E2EFixtures {
  /** Per-test synthetic users (confirmed by default); all deleted after the test. */
  userFactory: UserFactory;
  /** Per-test members and workspaces (public API); purged before the users are deleted. */
  workspaceFactory: WorkspaceFactory;
  /**
   * Deterministic Cloudflare Turnstile for every context (auto): no request ever reaches
   * challenges.cloudflare.com. Set `turnstile.mode` before navigating (default `pass`).
   */
  turnstile: FakeTurnstile;
}

export const test = base.extend<E2EFixtures>({
  turnstile: [
    async ({ context }, use) => {
      const fake = new FakeTurnstile();
      await fake.install(context);
      await use(fake);
    },
    { auto: true },
  ],
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
export * from './turnstile.ts';
export { ApiClient, PROBLEM_TYPES, type ApiResponse, type Problem } from './api.ts';
export * from './documents.ts';
export * from './generation.ts';
export * from './history.ts';
export {
  attemptRevision,
  forgetImportRuns,
  holdDocumentProcessing,
  seedGradedAttempt,
  seedImportDraftCopies,
  seedMembership,
} from './db.ts';
export * from './questions.ts';
export * from './workspace-ui.ts';
export { uniqueWorkspaceName, type Member, type Workspace } from './workspaces.ts';
export {
  deleteMessagesFor,
  extractLinks,
  waitForLatestMessage,
  waitForMailLink,
} from './mailpit.ts';

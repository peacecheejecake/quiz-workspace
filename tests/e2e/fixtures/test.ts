// Shared Playwright `test` for every E2E spec: import { test, expect } from '../fixtures/test'.
//
// Writing tests get their own users (and later workspaces/documents) per test; teardown deletes
// them even when the test fails. Fixtures refuse non-local URLs (see local-env.ts).
//
// Extension points (add here, same pattern: create through an API with per-test unique data,
// track, delete in teardown):
//   - M3.1a: `workspaceFactory` (POST /api/v1/workspaces as a `userFactory` user's session).
//   - M3.2a: `documentFactory` (upload a tests/fixtures/pdfs synthetic PDF into a workspace).
//   - S0:    owner/guest/recipient share fixtures on top of the two above.
// Never add test-only seed/reset endpoints to the production app (AGENTS.md §5).
import { test as base, expect } from '@playwright/test';
import { UserFactory } from './auth.ts';
import { deleteMessagesFor } from './mailpit.ts';

export interface E2EFixtures {
  /** Per-test synthetic users (confirmed by default); all deleted after the test. */
  userFactory: UserFactory;
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
});

export { expect };
export type { AuthSession, CreateUserOptions, TestUser } from './auth.ts';
export { signIn, userExists } from './auth.ts';
export {
  deleteMessagesFor,
  extractLinks,
  waitForLatestMessage,
  waitForMailLink,
} from './mailpit.ts';

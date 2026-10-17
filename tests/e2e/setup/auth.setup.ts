// `setup` project: one confirmed synthetic user per run, signed in through the real `/login` UI,
// whose browser state the `authenticated-*` projects reuse (ACCOUNT-01 and every later
// authenticated spec).
//
// playwright.config.ts only registers this project once authenticated specs exist. It cannot pass
// before A2.1/A2.2: `/login` is a stub today. A2.1 owns the session format (Supabase SSR cookies);
// this flow only types into the form and saves whatever state the app sets. Never fake a cookie.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createUser } from '../fixtures/auth.ts';
import { expect, PROTECTED_LANDING, submitLogin, test as setup } from '../fixtures/test.ts';
import { AUTH_META_PATH, AUTH_STATE_PATH } from './paths.ts';

setup('authenticate the shared E2E user through /login', async ({ page }) => {
  const user = await createUser({ label: 'setup' });
  mkdirSync(dirname(AUTH_META_PATH), { recursive: true });
  // Teardown deletes the user even if login below fails. Id and synthetic email only (specs
  // assert the email on screen); no password or token is stored.
  writeFileSync(AUTH_META_PATH, JSON.stringify({ userId: user.id, email: user.email }), {
    mode: 0o600,
  });

  await submitLogin(page, user);
  await expect(page).toHaveURL(PROTECTED_LANDING);
  await page.context().storageState({ path: AUTH_STATE_PATH });
});

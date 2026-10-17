// `setup` project: one confirmed synthetic user per run, signed in through the real `/login` UI,
// whose browser state the `authenticated-*` projects reuse.
//
// playwright.config.ts only registers this project once authenticated specs exist. It cannot pass
// before A2.1/A2.2: `/login` is a stub today. A2.1 owns the session format (Supabase SSR cookies)
// and must finalize this flow (form labels, post-login URL); do not fake a cookie format here.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createUser } from '../fixtures/auth.ts';
import { expect, test as setup } from '../fixtures/test.ts';
import { AUTH_META_PATH, AUTH_STATE_PATH } from './paths.ts';

setup('authenticate the shared E2E user through /login', async ({ page }) => {
  const user = await createUser({ label: 'setup' });
  mkdirSync(dirname(AUTH_META_PATH), { recursive: true });
  // Teardown deletes the user even if login below fails. No password or token is stored.
  writeFileSync(AUTH_META_PATH, JSON.stringify({ userId: user.id }), { mode: 0o600 });

  await page.goto('/login');
  await page.getByRole('textbox', { name: /이메일|email/i }).fill(user.email);
  await page.getByLabel(/비밀번호|password/i).fill(user.password);
  await page.getByRole('button', { name: /로그인|sign in/i }).click();
  await expect(page).toHaveURL(/\/workspaces/);
  await page.context().storageState({ path: AUTH_STATE_PATH });
});

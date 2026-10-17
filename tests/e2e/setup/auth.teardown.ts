// `teardown` project (runs after every project that depends on `setup`): deletes the setup user
// and its saved browser state.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { deleteUser } from '../fixtures/auth.ts';
import { test as teardown } from '../fixtures/test.ts';
import { AUTH_META_PATH, AUTH_STATE_PATH } from './paths.ts';

teardown('delete the shared E2E user', async () => {
  if (existsSync(AUTH_META_PATH)) {
    const { userId } = JSON.parse(readFileSync(AUTH_META_PATH, 'utf8')) as { userId: string };
    await deleteUser(userId);
  }
  rmSync(AUTH_META_PATH, { force: true });
  rmSync(AUTH_STATE_PATH, { force: true });
});

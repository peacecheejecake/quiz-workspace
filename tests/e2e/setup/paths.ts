import { join } from 'node:path';
import { REPO_ROOT } from '../fixtures/local-env.ts';

/** Git-ignored (`playwright/.auth/`): session cookies of a synthetic local user. */
export const AUTH_STATE_PATH = join(REPO_ROOT, 'playwright/.auth/user.json');
/** User id of the setup user so teardown can delete it. */
export const AUTH_META_PATH = join(REPO_ROOT, 'playwright/.auth/user.meta.json');

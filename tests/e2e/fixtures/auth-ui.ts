// Role/label locators and small helpers shared by the AUTH-* / ACCOUNT-01 specs and the `setup`
// project. Korean-first names with English alternatives (AGENTS.md §5); labels are matched
// exactly where screens carry several password fields.
//
// Label contract assumed by A0 for A2.2/A2.3 (see docs/screens/auth-*.md):
//   이메일 / Email, 비밀번호 / Password, 비밀번호 확인 / Confirm password,
//   새 비밀번호 / New password, 새 비밀번호 확인 / Confirm new password.
import {
  expect,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';

/**
 * A field-level error as the @quiz/ui `Field`/`Input` renders it: `aria-invalid` on the control
 * and the message reachable through its accessible description (aria-describedby).
 */
export async function expectFieldError(field: Locator, message: RegExp): Promise<void> {
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(message);
}

/** `toHaveURL` predicate on the pathname only, so a `?next=/workspaces` query never matches. */
export function atPath(pathname: RegExp): (url: URL) => boolean {
  return (url) => pathname.test(url.pathname);
}

/** Default landing after sign-in: the workspace list (or a workspace inside it). */
export const PROTECTED_LANDING = atPath(/^\/workspaces(?:\/|$)/);
export const LOGIN_SCREEN = atPath(/^\/login$/);

export const authUi = {
  email: (page: Page) => page.getByRole('textbox', { name: /이메일|email/i }),
  password: (page: Page) => page.getByLabel(/^\s*(비밀번호|password)\s*\*?\s*$/i),
  confirmPassword: (page: Page) =>
    page.getByLabel(/^\s*(비밀번호 확인|confirm password)\s*\*?\s*$/i),
  newPassword: (page: Page) => page.getByLabel(/^\s*(새 비밀번호|new password)\s*\*?\s*$/i),
  confirmNewPassword: (page: Page) =>
    page.getByLabel(/^\s*(새 비밀번호 확인|confirm new password)\s*\*?\s*$/i),
  signInButton: (page: Page) => page.getByRole('button', { name: /^(로그인|sign in|log in)$/i }),
  signUpButton: (page: Page) =>
    page.getByRole('button', { name: /^(회원가입|가입하기|sign up|create account)$/i }),
  sendResetButton: (page: Page) =>
    page.getByRole('button', {
      name: /재설정 (링크|메일|이메일).*(보내기|전송|요청)|send (password )?reset (link|email)/i,
    }),
  updatePasswordButton: (page: Page) =>
    page.getByRole('button', {
      name: /비밀번호 (변경|재설정|저장)|(update|change|reset|save) password/i,
    }),
  resendButton: (page: Page) =>
    page.getByRole('button', { name: /(메일|이메일).*(다시 보내기|재전송)|resend/i }),
  signOutButton: (page: Page) => page.getByRole('button', { name: /로그아웃|log ?out|sign ?out/i }),
  /**
   * App-shell account menu trigger: shows the signed-in email (an account icon below 768px),
   * named "계정 <email>".
   */
  accountButton: (page: Page) =>
    page
      .getByRole('banner')
      .first()
      .getByRole('button', { name: /^(계정|account)(?!\p{L})/iu }),
} as const;

/**
 * Form-level error/notice inside the page's `main` landmark (scoped so Next.js' own route
 * announcer, which also has role=alert, never matches).
 */
export function formAlert(page: Page): Locator {
  return page.getByRole('main').getByRole('alert');
}

/** Signs in through the real `/login` form (optionally with `?next=`); does not wait for a URL. */
export async function submitLogin(
  page: Page,
  user: { readonly email: string; readonly password: string },
  next?: string,
): Promise<void> {
  await page.goto(next === undefined ? '/login' : `/login?next=${encodeURIComponent(next)}`);
  await expect(authUi.email(page)).toBeVisible();
  await authUi.email(page).fill(user.email);
  await authUi.password(page).fill(user.password);
  await authUi.signInButton(page).click();
}

/** Same-origin pathname + search of the current page (throws if the page left the app origin). */
export function appPath(page: Page, baseURL: string | undefined): string {
  const url = new URL(page.url());
  if (baseURL && url.origin !== new URL(baseURL).origin) {
    throw new Error(`page left the app origin: ${url.origin}`);
  }
  return `${url.pathname}${url.search}`;
}

/**
 * Records every non-GET request the page sends from now on (form posts, server actions, Auth API
 * calls). Client-side validation ACs assert this stays empty.
 */
export function recordMutations(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'GET' && req.method() !== 'HEAD' && req.method() !== 'OPTIONS') {
      seen.push(req);
    }
  });
  return seen;
}

/** Records attempts to reach `evil.example` (aborted, so the test never leaves the local stack). */
export async function blockForeignHosts(context: BrowserContext): Promise<string[]> {
  const attempts: string[] = [];
  await context.route(/^https?:\/\/([^/]+\.)?evil\.example(?:[/:?#]|$)/, async (route) => {
    attempts.push(new URL(route.request().url()).host);
    await route.abort();
  });
  return attempts;
}

/**
 * Refresh token of the Supabase SSR session cookie (`sb-<ref>-auth-token`, possibly chunked as
 * `.0`, `.1`, …; value `base64-<base64url JSON>` or plain JSON). Read-only use for ACCOUNT-01-AC03;
 * nothing here writes or fakes a session cookie. Undefined when there is no session cookie.
 */
export async function sessionRefreshToken(context: BrowserContext): Promise<string | undefined> {
  const cookies = (await context.cookies()).filter((c) =>
    /^sb-[^.]+-auth-token(?:\.\d+)?$/.test(c.name),
  );
  if (!cookies.length) return undefined;
  const chunkIndex = (name: string) => Number(/\.(\d+)$/.exec(name)?.[1] ?? '-1');
  const raw = cookies
    .sort((a, b) => chunkIndex(a.name) - chunkIndex(b.name))
    .map((c) => c.value)
    .join('');
  const json = raw.startsWith('base64-')
    ? Buffer.from(raw.slice('base64-'.length), 'base64url').toString('utf8')
    : decodeURIComponent(raw);
  const session = JSON.parse(json) as { refresh_token?: string };
  return session.refresh_token;
}

// Open-redirect guard for every `next` / return URL the app accepts (docs/auth.md §2, AUTH-01-AC01,
// AUTH-04-AC02, AUTH-07-AC02). Only internal relative paths under an allowlisted prefix survive;
// everything else falls back to the default landing page.

/** Default landing after sign-in (the workspace list; "last workspace" arrives with M3). */
export const DEFAULT_AFTER_SIGN_IN = '/workspaces';

/** Path prefixes a `next` value may point into (segment-aligned: `/settings` ≠ `/settingsx`). */
export const NEXT_PATH_ALLOWLIST = [
  '/workspaces',
  '/documents',
  '/questions',
  '/settings',
  '/reset-password',
  '/share',
] as const;

const MAX_LENGTH = 2048;
// Never a valid host in practice; only used to resolve the candidate and compare origins.
const PROBE_ORIGIN = 'http://next-path.invalid';
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function decodeRepeatedly(value: string): string[] {
  const forms = [value];
  let current = value;
  for (let i = 0; i < 3; i += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return [...forms, '\\'];
    }
    if (decoded === current) break;
    forms.push(decoded);
    current = decoded;
  }
  return forms;
}

function looksExternal(form: string): boolean {
  return (
    !form.startsWith('/') ||
    form.startsWith('//') ||
    form.includes('\\') ||
    CONTROL_CHARS.test(form)
  );
}

function isAllowlisted(pathname: string): boolean {
  return NEXT_PATH_ALLOWLIST.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Returns `raw` normalised to `pathname + search` when it is an internal path under
 * {@link NEXT_PATH_ALLOWLIST}; otherwise `fallback`. Rejects absolute and protocol-relative URLs,
 * backslashes, control characters, percent-encoded variants of those, and paths that leave the
 * allowlist after dot-segment normalisation. The fragment is dropped.
 */
export function safeNextPath(raw: unknown, fallback: string = DEFAULT_AFTER_SIGN_IN): string {
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim();
  if (!value || value.length > MAX_LENGTH) return fallback;
  if (decodeRepeatedly(value).some(looksExternal)) return fallback;

  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;
  if (!isAllowlisted(url.pathname)) return fallback;
  return `${url.pathname}${url.search}`;
}

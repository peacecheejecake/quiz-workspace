// Deterministic stand-in for Cloudflare Turnstile (A4, docs/auth.md §5.1). E2E never contacts
// Cloudflare: every request to https://challenges.cloudflare.com is answered here.
//
// - `/turnstile/v0/api.js` → a fake implementing the explicit-render API the app uses
//   (`turnstile.render/reset/remove/getResponse/isExpired/ready`, `callback`, `error-callback`,
//   `expired-callback`, `timeout-callback`, the `onload=` query parameter).
// - Each widget is an iframe on the Cloudflare origin (so the page's CSP `frame-src` and
//   `script-src` are exercised exactly as in production) served from `FRAME_PATH`.
// - Modes: `pass` issues a token right after render/reset (like the always-passes test sitekey),
//   `fail` calls `error-callback` (always-fails sitekey), `interactive` waits for the checkbox in
//   the iframe (forces-interactive sitekey), `unreachable` aborts the script request.
// - Tokens are Cloudflare's test token `XXXX.DUMMY.TOKEN.XXXX`, the only value the test secret
//   keys accept, so the same browser flow also passes against a Supabase stack with CAPTCHA on.
//
// Installed for every context by fixtures/test.ts (auto fixture `turnstile`). Test-only: nothing
// here is part of the app build. The web build under test uses NEXT_PUBLIC_TURNSTILE_SITE_KEY =
// TEST_SITE_KEY (playwright.config.ts).
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

export type TurnstileMode = 'pass' | 'fail' | 'interactive' | 'unreachable';

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const TURNSTILE_SCRIPT_PATH = '/turnstile/v0/api.js';
export const FRAME_PATH = '/fake-turnstile/frame';
/** Cloudflare's always-passes visible test sitekey (docs: Turnstile → Testing). */
export const TEST_SITE_KEY = '1x00000000000000000000AA';
export const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

export interface TurnstileStats {
  readonly renders: number;
  readonly resets: number;
  readonly removes: number;
  readonly issued: number;
  readonly sitekeys: readonly string[];
  readonly languages: readonly string[];
}

interface FakeWindow {
  __fakeTurnstile?: {
    stats: TurnstileStats;
    setMode(mode: TurnstileMode): void;
    expire(): void;
  };
}

/** The script served as api.js. `mode` is the mode at load time; `setMode` changes it live. */
function fakeApi(mode: TurnstileMode): string {
  const config = JSON.stringify({ mode, origin: TURNSTILE_ORIGIN, framePath: FRAME_PATH });
  return `(() => {
  const config = ${config};
  const DUMMY = ${JSON.stringify(DUMMY_TOKEN)};
  let mode = config.mode;
  let seq = 0;
  const widgets = new Map();
  const stats = { renders: 0, resets: 0, removes: 0, issued: 0, sitekeys: [], languages: [] };
  const call = (w, name, ...args) => {
    const fn = w.params[name];
    if (typeof fn === 'function') fn(...args);
  };
  const issue = (w) => {
    if (!widgets.has(w.id)) return;
    w.token = DUMMY;
    stats.issued += 1;
    call(w, 'callback', DUMMY);
  };
  const run = (w) => {
    w.token = undefined;
    w.expired = false;
    w.generation += 1;
    const generation = w.generation;
    w.iframe.src = config.origin + config.framePath + '?id=' + encodeURIComponent(w.id) +
      '&mode=' + encodeURIComponent(mode);
    if (mode === 'pass') {
      setTimeout(() => { if (w.generation === generation) issue(w); }, 30);
    } else if (mode === 'fail') {
      setTimeout(() => { if (w.generation === generation) call(w, 'error-callback', '600010'); }, 30);
    }
  };
  const find = (id) => (id === undefined ? widgets.values().next().value : widgets.get(id));
  window.addEventListener('message', (event) => {
    if (event.origin !== config.origin) return;
    const data = event.data;
    if (!data || data.source !== 'fake-turnstile') return;
    const w = widgets.get(data.id);
    if (w && !w.token) issue(w);
  });
  window.turnstile = {
    render(container, params) {
      const el = typeof container === 'string' ? document.querySelector(container) : container;
      if (!el) throw new Error('turnstile.render: container not found');
      const id = 'fake-turnstile-' + ++seq;
      const iframe = document.createElement('iframe');
      iframe.title = 'Widget containing a Cloudflare security challenge';
      iframe.style.cssText = 'width:300px;height:65px;border:0;display:block;';
      el.appendChild(iframe);
      const w = { id, params: params || {}, iframe, token: undefined, generation: 0 };
      widgets.set(id, w);
      stats.renders += 1;
      stats.sitekeys.push(String(w.params.sitekey));
      stats.languages.push(String(w.params.language));
      run(w);
      return id;
    },
    reset(id) {
      const w = find(id);
      if (!w) return;
      stats.resets += 1;
      run(w);
    },
    remove(id) {
      const w = find(id);
      if (!w) return;
      w.generation += 1;
      w.iframe.remove();
      widgets.delete(w.id);
      stats.removes += 1;
    },
    getResponse(id) {
      return find(id)?.token;
    },
    isExpired(id) {
      return find(id)?.expired === true;
    },
    ready(cb) {
      cb();
    },
    execute() {},
  };
  window.__fakeTurnstile = {
    stats,
    setMode(next) {
      mode = next;
    },
    expire() {
      for (const w of widgets.values()) {
        if (!w.token) continue;
        w.token = undefined;
        w.expired = true;
        call(w, 'expired-callback', DUMMY);
      }
    },
  };
  const src = document.currentScript && document.currentScript.src;
  const onload = src ? new URL(src).searchParams.get('onload') : null;
  if (onload && typeof window[onload] === 'function') window[onload]();
})();
`;
}

/** The widget iframe document (system colors only; it stands in for Cloudflare's own UI). */
function frameHtml(id: string, mode: string): string {
  const body =
    mode === 'interactive'
      ? `<label><input type="checkbox" id="human"> 사람인지 확인합니다</label>`
      : mode === 'fail'
        ? '<p>확인 실패</p>'
        : '<p>확인됨</p>';
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>Cloudflare 보안 확인 (테스트)</title>
<style>:root{color-scheme:light dark}body{margin:0;height:65px;display:flex;align-items:center;
padding:0 12px;box-sizing:border-box;font:14px system-ui,sans-serif;background:Canvas;color:CanvasText;
border:1px solid GrayText}p{margin:0}</style></head>
<body><div>${body}</div>
<script>
const box = document.getElementById('human');
if (box) box.addEventListener('change', () => {
  if (box.checked) parent.postMessage({ source: 'fake-turnstile', id: ${JSON.stringify(id)} }, '*');
});
</script></body></html>`;
}

export class FakeTurnstile {
  /** Mode for the next api.js load (pages loaded later). Use `setMode` for a page already open. */
  mode: TurnstileMode = 'pass';
  scriptRequests = 0;

  async install(context: BrowserContext): Promise<void> {
    await context.route(`${TURNSTILE_ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === TURNSTILE_SCRIPT_PATH) {
        this.scriptRequests++;
        if (this.mode === 'unreachable') {
          await route.abort('internetdisconnected');
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'text/javascript; charset=utf-8',
          body: fakeApi(this.mode),
        });
        return;
      }
      if (url.pathname === FRAME_PATH) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: frameHtml(url.searchParams.get('id') ?? '', url.searchParams.get('mode') ?? ''),
        });
        return;
      }
      await route.abort('blockedbyclient');
    });
  }

  /** Changes the mode for future loads and, when the fake is loaded, for the open page. */
  async setMode(page: Page, mode: TurnstileMode): Promise<void> {
    this.mode = mode;
    await page.evaluate((m) => (window as FakeWindow).__fakeTurnstile?.setMode(m), mode);
  }

  /** Expires every issued token (Turnstile tokens live 300 s): fires `expired-callback`. */
  async expire(page: Page): Promise<void> {
    await page.evaluate(() => (window as FakeWindow).__fakeTurnstile?.expire());
  }

  async stats(page: Page): Promise<TurnstileStats> {
    const stats = await page.evaluate(() => (window as FakeWindow).__fakeTurnstile?.stats);
    if (!stats) throw new Error('the Turnstile script was not loaded on this page');
    return stats;
  }

  /** Ticks the interactive checkbox inside the widget iframe (a user solving the challenge). */
  async solve(page: Page): Promise<void> {
    await page
      .frameLocator(`iframe[src^="${TURNSTILE_ORIGIN}${FRAME_PATH}"]`)
      .getByRole('checkbox')
      .check();
  }
}

// --- UI contract of the app's security-check region (docs/auth.md §5.1) -------------------------

export const CAPTCHA_REQUIRED = /보안 확인을 (먼저 )?완료하면|complete the security check/i;
export const CAPTCHA_VERIFIED = /보안 확인(이)? 완료|security check (complete|passed)/i;
export const CAPTCHA_FAILED = /보안 확인을 완료하지 못했|security check failed/i;
export const CAPTCHA_EXPIRED = /보안 확인 시간이 지났|security check expired/i;
export const CAPTCHA_LOAD_FAILED = /보안 확인을 불러오지 못했|could not load the security check/i;
export const CAPTCHA_REJECTED = /보안 확인에 실패했습니다|security check was rejected/i;

export const captchaUi = {
  group: (page: Page): Locator =>
    page.getByRole('main').getByRole('group', { name: /보안 확인|security check/i }),
  status: (page: Page): Locator => captchaUi.group(page).getByRole('status'),
  retry: (page: Page): Locator =>
    page
      .getByRole('main')
      .getByRole('button', { name: /보안 확인 다시 하기|retry security check/i }),
} as const;

/** Waits until the widget holds a token and the region says so. */
export async function expectCaptchaVerified(page: Page): Promise<void> {
  await expect(captchaUi.status(page)).toContainText(CAPTCHA_VERIFIED);
}

/** A submit control that is blocked for lack of a token and says why. */
export async function expectBlockedForCaptcha(button: Locator): Promise<void> {
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(button).toHaveAccessibleDescription(CAPTCHA_REQUIRED);
}

/**
 * No element in the security-check region animates or transitions (reduced motion). Durations up
 * to 1 ms count as none: the global reduced-motion reset (design-tokens base.css) sets 0.01 ms.
 */
export async function expectNoMotion(region: Locator): Promise<void> {
  const moving = await region.evaluate((root) => {
    const seconds = (value: string) =>
      Math.max(
        ...value.split(',').map((d) => {
          const n = parseFloat(d);
          return d.trim().endsWith('ms') ? n / 1000 : n;
        }),
      );
    return [root, ...root.querySelectorAll('*')]
      .map((el) => getComputedStyle(el))
      .filter(
        (s) =>
          (s.animationName !== 'none' && seconds(s.animationDuration) > 0.001) ||
          seconds(s.transitionDuration) > 0.001,
      ).length;
  });
  expect(moving, 'animated elements in the security-check region').toBe(0);
}

/** `gotrue_meta_security.captcha_token` of a browser-side Supabase Auth request body. */
export function captchaTokenOf(postData: string | null): string | undefined {
  if (!postData) return undefined;
  try {
    const body = JSON.parse(postData) as { gotrue_meta_security?: { captcha_token?: string } };
    return body.gotrue_meta_security?.captcha_token;
  } catch {
    return undefined;
  }
}

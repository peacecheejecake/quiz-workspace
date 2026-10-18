// @vitest-environment jsdom
// Auth CAPTCHA (docs/auth.md §5.1, A4): `useCaptcha`/`CaptchaField` against a scripted
// `window.turnstile`, the loader, and the error classification. Off without a sitekey.
import './dom-setup';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCaptcha } from '../src/components/auth/captcha-field';
import {
  loadTurnstile,
  resetTurnstileLoaderForTests,
  TURNSTILE_SCRIPT_URL,
  type TurnstileApi,
  type TurnstileRenderOptions,
} from '../src/lib/auth/captcha';
import { classifyMailRequestError, classifySignUpError } from '../src/lib/auth/flow-errors';
import { classifySignInError } from '../src/lib/auth/sign-in-errors';

const SITE_KEY = '1x00000000000000000000AA';

function Harness({ onSubmit }: { onSubmit: (token: string | undefined) => void }) {
  const captcha = useCaptcha('로그인할');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (captcha.blocked) {
          captcha.remind();
          return;
        }
        onSubmit(captcha.token);
        captcha.reset();
      }}
    >
      {captcha.field}
      <button type="submit" {...captcha.submitProps}>
        로그인
      </button>
    </form>
  );
}

function fakeTurnstile() {
  const calls: TurnstileRenderOptions[] = [];
  const api = {
    render: vi.fn((container: HTMLElement, options: TurnstileRenderOptions) => {
      calls.push(options);
      container.appendChild(document.createElement('iframe'));
      return 'w1';
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  } satisfies TurnstileApi;
  window.turnstile = api;
  const last = () => calls[calls.length - 1] as TurnstileRenderOptions;
  return { api, last };
}

const button = () => screen.getByRole('button', { name: '로그인' });
const status = () => screen.getByRole('status');

describe('useCaptcha', () => {
  beforeEach(() => {
    resetTurnstileLoaderForTests();
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    delete window.turnstile;
  });

  it('is off without a sitekey: no region, no blocking, no token', async () => {
    const submitted = vi.fn();
    render(<Harness onSubmit={submitted} />);
    expect(screen.queryByRole('group')).toBeNull();
    expect(button()).not.toHaveAttribute('aria-disabled');
    await userEvent.click(button());
    expect(submitted).toHaveBeenCalledWith(undefined);
  });

  it('blocks submit until a token, sends it once and resets the widget', async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = SITE_KEY;
    const { api, last } = fakeTurnstile();
    const submitted = vi.fn();
    render(<Harness onSubmit={submitted} />);

    const group = await screen.findByRole('group', { name: '보안 확인' });
    expect(api.render).toHaveBeenCalledTimes(1);
    expect(last()).toMatchObject({
      sitekey: SITE_KEY,
      language: 'ko',
      'response-field': false,
      'refresh-expired': 'manual',
    });
    expect(status()).toHaveTextContent('보안 확인 중');
    expect(button()).toHaveAttribute('aria-disabled', 'true');
    expect(button()).toHaveAccessibleDescription('보안 확인을 완료하면 로그인할 수 있습니다.');

    await userEvent.click(button());
    expect(submitted).not.toHaveBeenCalled();
    expect(group).toHaveFocus();

    act(() => last().callback?.('token-1'));
    expect(status()).toHaveTextContent('보안 확인 완료');
    expect(button()).not.toHaveAttribute('aria-disabled');
    await userEvent.click(button());
    expect(submitted).toHaveBeenCalledWith('token-1');
    expect(api.reset).toHaveBeenCalledWith('w1');
    expect(button()).toHaveAttribute('aria-disabled', 'true');

    await userEvent.click(button());
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it('reports failure and expiry in text and retries from a button', async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = SITE_KEY;
    const { api, last } = fakeTurnstile();
    render(<Harness onSubmit={vi.fn()} />);
    await screen.findByRole('group', { name: '보안 확인' });

    act(() => {
      last()['error-callback']?.('600010');
    });
    expect(status()).toHaveTextContent('보안 확인을 완료하지 못했습니다');
    await userEvent.click(screen.getByRole('button', { name: '보안 확인 다시 하기' }));
    expect(api.reset).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '보안 확인 다시 하기' })).toBeNull();

    act(() => last().callback?.('token-2'));
    act(() => last()['expired-callback']?.());
    expect(status()).toHaveTextContent('보안 확인 시간이 지났습니다');
    expect(button()).toHaveAttribute('aria-disabled', 'true');
  });

  it('says when the script cannot load and loads it again on retry', async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = SITE_KEY;
    render(<Harness onSubmit={vi.fn()} />);
    const script = () =>
      document.head.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT_URL}"]`);
    expect(script()).not.toBeNull();
    await act(async () => {
      script()?.dispatchEvent(new Event('error'));
      await Promise.resolve();
    });
    expect(status()).toHaveTextContent('보안 확인을 불러오지 못했습니다');
    expect(script()).toBeNull();

    const { api } = fakeTurnstile();
    await userEvent.click(screen.getByRole('button', { name: '보안 확인 다시 하기' }));
    expect(api.render).toHaveBeenCalledTimes(1);
    expect(status()).toHaveTextContent('보안 확인 중');
  });
});

describe('loadTurnstile', () => {
  beforeEach(() => resetTurnstileLoaderForTests());
  afterEach(() => {
    delete window.turnstile;
    document.head.innerHTML = '';
  });

  it('adds api.js once (explicit render) and resolves with window.turnstile', async () => {
    const first = loadTurnstile();
    const second = loadTurnstile();
    const scripts = document.head.querySelectorAll('script');
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.src).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    );
    const { api } = fakeTurnstile();
    scripts[0]?.dispatchEvent(new Event('load'));
    await expect(first).resolves.toBe(api);
    await expect(second).resolves.toBe(api);
  });
});

describe('Auth error classification', () => {
  const refused = { code: 'captcha_failed', status: 400 };
  it('maps captcha_failed to the security-check notice on every CAPTCHA-protected call', () => {
    expect(classifySignUpError(refused)).toBe('captchaFailed');
    expect(classifyMailRequestError(refused)).toBe('captchaFailed');
    expect(classifySignInError(refused)).toBe('captchaFailed');
  });
});

import { describe, expect, it } from 'vitest';
import { parsePublicEnv } from '../src/env';

const valid = {
  supabaseUrl: 'http://127.0.0.1:54321/',
  supabasePublishableKey: 'sb_publishable_test',
  apiBaseUrl: 'http://127.0.0.1:8000',
};

describe('parsePublicEnv', () => {
  it('returns trimmed values with trailing slashes removed from URLs', () => {
    expect(parsePublicEnv(valid)).toEqual({
      supabaseUrl: 'http://127.0.0.1:54321',
      supabasePublishableKey: 'sb_publishable_test',
      apiBaseUrl: 'http://127.0.0.1:8000',
    });
  });

  it('names every missing or invalid variable without echoing values', () => {
    const run = () =>
      parsePublicEnv({
        supabaseUrl: 'not-a-url-secretish',
        supabasePublishableKey: ' ',
        apiBaseUrl: undefined,
      });
    expect(run).toThrow(/NEXT_PUBLIC_SUPABASE_URL must be an http\(s\) URL/);
    expect(run).toThrow(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set/);
    expect(run).toThrow(/NEXT_PUBLIC_API_BASE_URL is not set/);
    expect(run).not.toThrow(/secretish/);
  });
});

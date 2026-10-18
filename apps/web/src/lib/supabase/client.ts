'use client';

// Browser Supabase client (publishable key only). Session cookies are shared with the server
// client; the browser never uses the Supabase Data API (AGENTS.md §5) — Auth only.
import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPublicEnv } from '@/env';

let browserClient: SupabaseClient | undefined;

export function getSupabaseBrowserClient(): SupabaseClient {
  if (!browserClient) {
    const { supabaseUrl, supabasePublishableKey } = getPublicEnv();
    browserClient = createBrowserClient(supabaseUrl, supabasePublishableKey);
  }
  return browserClient;
}

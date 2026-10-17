import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type * as NextEnv from '@next/env';
import type { NextConfig } from 'next';

// The monorepo keeps one git-ignored `.env` at the repo root (AGENTS.md §7). Load it as a
// fallback; values from the environment or apps/web/.env* keep precedence.
// `@next/env` is CommonJS; require() keeps this working whether Next compiles this file to CJS
// or Node loads it as ESM.
const { loadEnvConfig } = createRequire(import.meta.url)('@next/env') as typeof NextEnv;
loadEnvConfig(
  fileURLToPath(new URL('../..', import.meta.url)),
  process.env.NODE_ENV !== 'production',
);

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

// docs/workspace-sharing.md §2: shared pages never cached, never leak the URL via Referer,
// never indexed. Listed after the global headers so these values win for /share/**.
const shareHeaders = [
  { key: 'Cache-Control', value: 'private, no-store' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Workspace packages ship TypeScript/CSS sources.
  transpilePackages: ['@quiz/design-tokens'],
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/share', headers: shareHeaders },
      { source: '/share/:path*', headers: shareHeaders },
    ];
  },
};

export default nextConfig;

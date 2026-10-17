import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { loadRootEnvFallback } from './load-root-env.ts';

// The monorepo keeps its git-ignored `.env*` at the repo root (AGENTS.md §7). Fill only keys that
// the process environment and apps/web/.env* (already loaded by Next) left unset.
loadRootEnvFallback(fileURLToPath(new URL('../..', import.meta.url)));

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
  // `next dev` would otherwise generate apps/web/AGENTS.md + CLAUDE.md; agent rules live in the
  // repo-root AGENTS.md.
  agentRules: false,
  // Workspace packages ship TypeScript/CSS sources.
  transpilePackages: ['@quiz/design-tokens', '@quiz/ui', '@quiz/api-client'],
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/share', headers: shareHeaders },
      { source: '/share/:path*', headers: shareHeaders },
    ];
  },
};

export default nextConfig;

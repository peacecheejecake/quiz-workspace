import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { loadRootEnvFallback } from './load-root-env.ts';

// The monorepo keeps its git-ignored `.env*` at the repo root (AGENTS.md §7). Fill only keys that
// the process environment and apps/web/.env* (already loaded by Next) left unset.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
loadRootEnvFallback(repoRoot);

// apps/web/Dockerfile builds with NEXT_OUTPUT=standalone: a self-contained server.js plus only the
// traced node_modules (workspace packages included, hence the repo-root tracing root). Local runs
// and E2E keep the default output so `next start` behaves as before.
const standalone = process.env.NEXT_OUTPUT === 'standalone';

// Static headers for every response. The Content-Security-Policy (nonce-based, per request) and
// HSTS come from `src/proxy.ts` (src/lib/http/security-headers.ts).
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
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
  ...(standalone ? { output: 'standalone' as const, outputFileTracingRoot: repoRoot } : {}),
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
      // The share relay (src/app/api/shared/**) sets the same values itself; listed for redirects
      // and framework-generated responses on those paths.
      { source: '/api/shared/:path*', headers: shareHeaders },
    ];
  },
};

export default nextConfig;

// Build-only fixture: proves the public @quiz/ui API can be imported and rendered from a
// Next.js App Router Server Component (`pnpm --filter @quiz/ui check:rsc`). Never deployed.
/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@quiz/ui', '@quiz/design-tokens'],
  agentRules: false,
};

export default nextConfig;

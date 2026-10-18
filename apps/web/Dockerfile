# Next.js web image (M7.3): standalone output (`NEXT_OUTPUT=standalone`, apps/web/next.config.ts).
# Build from the repo root, once per environment:
#
#   docker build -f apps/web/Dockerfile -t quiz-web \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co \
#     --build-arg NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key> \
#     --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.example.org \
#     --build-arg NEXT_PUBLIC_TURNSTILE_SITE_KEY=<Turnstile sitekey> .
#
# NEXT_PUBLIC_TURNSTILE_SITE_KEY is optional: empty builds the auth forms without CAPTCHA, which
# only works against a Supabase project with CAPTCHA off (docs/auth.md §5.1).
#
# - `NEXT_PUBLIC_*` values are inlined into the client bundles at build time, so they are build
#   arguments. They are public by definition (docs/deployment.md §6); nothing else is. Server-only
#   secrets (SUPABASE_SECRET_KEY, AUTH_RECOVERY_MARKER_SECRET, RELAY_CLIENT_SECRET, …) are runtime
#   environment variables only and never enter a layer (.dockerignore drops every `.env*`).
# - pnpm workspace, frozen lockfile, only @quiz/web and its workspace dependencies.
# - Runtime: node + server.js + traced node_modules, unprivileged user, listens on $PORT (3000).
#
# Base image pinned by version and digest (at least two weeks old when pinned). The pnpm version
# comes from package.json `packageManager` through corepack.

ARG NODE_IMAGE=node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /src
# Dependencies first (cached until the lockfile or a manifest changes).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json
COPY packages/api-client/package.json packages/api-client/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter '@quiz/web...'
COPY packages packages
COPY apps/web apps/web
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" && test -n "$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" \
      && test -n "$NEXT_PUBLIC_API_BASE_URL" \
      || { echo 'NEXT_PUBLIC_* build arguments are required' >&2; exit 1; }
RUN NEXT_OUTPUT=standalone pnpm --filter @quiz/web build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /srv
# The node image's unprivileged `node` user (uid 1000) owns nothing here: the app is read-only.
COPY --from=build /src/apps/web/.next/standalone ./
COPY --from=build /src/apps/web/.next/static ./apps/web/.next/static
# Only Next's runtime cache directory is writable.
RUN install -d -o node -g node /srv/apps/web/.next/cache
USER node:node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/login', { redirect: 'manual' }).then((r) => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/web/server.js"]

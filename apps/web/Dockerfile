FROM node:24-slim AS builder
WORKDIR /app
RUN corepack enable

COPY . .
# Install from the lockfile. The pnpm version comes from the root packageManager field.
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --store-dir /pnpm-store

# Build-time placeholders so Varlock validates the env schema. They are not secrets, nothing is
# deployed from this stage, and the runner stage gets none of them. Runtime values come from the
# environment at run time.
ENV NODE_ENV=production
RUN cd apps/web && BETTER_AUTH_SECRET=ci-only-secret-0123456789abcdef0123456789 \
    BETTER_AUTH_URL=http://localhost:3001 \
    DATABASE_URL=postgresql://postgres:password@localhost:5432/ai-chat \
    KEY_ENCRYPTION_SECRET=ci-only-key-encryption-0123456789abcdef \
    RESEND_API_KEY=ci-resend-key-not-sent EMAIL_FROM="AI Chat <no-reply@example.com>" APP_NAME="AI Chat" \
    GITHUB_CLIENT_ID=ci-github-client-id GITHUB_CLIENT_SECRET=ci-github-client-secret-not-for-production \
    GOOGLE_CLIENT_ID=ci-google-client-id GOOGLE_CLIENT_SECRET=ci-google-client-secret-not-for-production \
    pnpm run build

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app /app

ENV HOST=0.0.0.0
ENV PORT=3001
EXPOSE 3001

# SSR chunks require workspace dependencies at runtime.
# One-off migrations: `node scripts/migrate.ts` (Better Auth, then the Chat SDK schema).
# One-off key rotation, never in pre-deploy: `node scripts/rotate-keys.ts` (ADR 0010).
WORKDIR /app/apps/web
CMD ["node", ".output/server/index.mjs"]

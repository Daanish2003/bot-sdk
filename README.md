# ai-chat

This project was created with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack), a modern TypeScript stack that combines React, TanStack Start, Self, ORPC, and more.

## Features

- **TypeScript** - For type safety and improved developer experience
- **TanStack Start** - SSR framework with TanStack Router
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **Shared UI package** - shadcn/ui primitives live in `packages/ui`
- **oRPC** - End-to-end type-safe APIs with OpenAPI integration
- **Drizzle** - TypeScript-first ORM
- **PostgreSQL** - Database engine
- **Authentication** - Better-Auth
- **Husky** - Git hooks for code quality
- **Oxlint** - Oxlint + Oxfmt (linting & formatting)
- **Turborepo** - Optimized monorepo build system

## Getting Started

First, install the dependencies:

```bash
pnpm install
```

## Database Setup

This project uses PostgreSQL with Drizzle ORM.

1. Make sure you have a PostgreSQL database set up.
2. Update your `apps/web/.env` file with your PostgreSQL connection details.

3. Apply the schema to your database:

```bash
pnpm run db:push
```

Then, run the development server:

```bash
pnpm run dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser to see the fullstack application.

To connect a ChatGPT plan (optional), set `BETTER_AUTH_URL=http://127.0.0.1:3001`, `CHATGPT_CLIENT_ID` and `CHATGPT_HOST_ID` in `apps/web/.env`, and open the app at [http://127.0.0.1:3001](http://127.0.0.1:3001), not `localhost`. ChatGPT redirects to `<BETTER_AUTH_URL>/auth/callback`, and the session cookie must be on that same host.

## Testing

Vitest runs every package's tests from the root config (`vitest.config.ts`):

```bash
pnpm db:start          # the compose Postgres
pnpm test              # whole suite, through Turbo
pnpm test:vitest packages/bot-sdk/test/core/server/routers   # one file or folder, without Turbo
pnpm test:watch        # watch mode
```

The compose Postgres image is `pgvector/pgvector:0.8.7-pg18-trixie` (Postgres 18 with pgvector, which Knowledge needs). A container started on the old `postgres:18` image has no pgvector. To move it to the new image and keep its data, pull the image and recreate only that service; the `ai-chat_postgres_data` volume is kept:

```bash
docker compose pull postgres
docker compose up -d --force-recreate postgres
```

- `*.test.ts` files are unit tests. `*.integration.test.ts` files run one at a time against a real Postgres database: it is created if missing, migrated once per run, and every table is truncated before each test.
- The test database defaults to `postgresql://postgres:password@localhost:5432/ai-chat_test`. Point `TEST_DATABASE_URL` at another one, for example to give parallel runs their own database: `TEST_DATABASE_URL=postgresql://postgres:password@localhost:5434/ai-chat_test_2 pnpm test`.
- Tests never call a Provider, Tavily or the network. Build a real instance with `createTestSdk`, over the fakes in `packages/bot-sdk/test/support/` (scripted text adapter, search client, in-process router client).

CI (`.github/workflows/ci.yml`) runs lint, typecheck and tests on every pull request.

## UI Customization

React web apps in this stack share shadcn/ui primitives through `packages/ui`.

- Change design tokens and global styles in `packages/ui/src/styles/globals.css`
- Update shared primitives in `packages/ui/src/components/*`
- Adjust shadcn aliases or style config in `packages/ui/components.json` and `apps/web/components.json`

### Add more shared components

Run this from the project root to add more primitives to the shared UI package:

```bash
npx shadcn@latest add accordion dialog popover sheet table -c packages/ui
```

Import shared components like this:

```tsx
import { Button } from "@ai-chat/ui/components/button";
```

### Add app-specific blocks

If you want to add app-specific blocks instead of shared primitives, run the shadcn CLI from `apps/web`.

## Environment Configuration

Each app owns its environment schema in `.env.schema`. Varlock generates `src/env.ts` during installation; run `pnpm run env:generate` after changing a schema. Commit schemas, and keep secrets in ignored env files or your deployment platform.

Import the generated `ENV` accessor in application code. Shared database and auth packages receive configuration or initialized clients from the application. See [Varlock's monorepo guide](https://varlock.dev/guides/monorepos/).

Bun's automatic env loading is disabled in `bunfig.toml`; the framework integration or server bootstrap loads Varlock. Node deployments must include Varlock and its dependencies alongside the app schema.

Run standalone Node/Bun tools that use Varlock from the owning app directory so they load that app's schema and env files. `env:generate` only generates TypeScript files; it does not initialize environment values in a subsequent command.

## Deployment

Rate limits count each client by its IP, read from `x-forwarded-for` unless `TRUSTED_IP_HEADERS` names other headers (e.g. `cf-connecting-ip` on Cloudflare). Production must run behind a proxy that sets that header. Otherwise no client IP is found, and every client shares one rate-limit bucket keyed `no-trusted-ip|<path>`.

### Docker Compose

- Target: web + server
- Config: `docker-compose.yml` (app Dockerfiles live in `apps/*/Dockerfile`)
- Build images: pnpm run docker:build
- Start: pnpm run docker:up
- Logs: pnpm run docker:logs
- Stop: pnpm run docker:down

Environment variables are read from each app's `.env` file (baked into web builds for public variables) and overridden in `docker-compose.yml` for container networking.

For more details, see the guide on [Deploying with Docker Compose](https://www.better-t-stack.dev/docs/guides/docker).

## Git Hooks and Formatting

- Initialize hooks: `pnpm run prepare`
- Run checks: `pnpm run check`

## Project Structure

```
ai-chat/
├── apps/
│   └── web/         # Fullstack application (React + TanStack Start)
├── packages/
│   ├── ui/          # Shared shadcn/ui components and styles
│   ├── api/         # API layer / business logic
│   ├── auth/        # Authentication configuration & logic
│   └── db/          # Database schema & queries
```

## Available Scripts

- `pnpm run dev`: Start all applications in development mode
- `pnpm run build`: Build all applications
- `pnpm run dev:web`: Start only the web application
- `pnpm run check-types`: Check TypeScript types across all apps
- `pnpm run db:push`: Push schema changes to database
- `pnpm run db:generate`: Generate database client/types
- `pnpm run db:migrate`: Run database migrations
- `pnpm run db:studio`: Open database studio UI
- `pnpm run check`: Run Oxlint and Oxfmt
- `pnpm run docker:build`: Build the Docker Compose images
- `pnpm run docker:up`: Build and start the Docker Compose stack
- `pnpm run docker:logs`: Tail logs from the Docker Compose stack
- `pnpm run docker:down`: Stop the Docker Compose stack

## Better Auth Schema Generation

After changing auth plugins or schema options, run `pnpm run auth:generate` from the project root. The script runs the Better Auth CLI through `varlock run` from the owning app directory, loading the auth instance from `src/services.ts`. Review the schema changes, then use your ORM's migration workflow to apply them.

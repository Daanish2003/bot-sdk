# Example Host: Next.js + Prisma + Auth.js

A second Host for the Bot SDK, deliberately different from `apps/web`: Next.js App Router, Prisma
for `public` (Auth.js users), Auth.js v5 with the Credentials provider, and its own shadcn theme.
The chat lives in `src/bot-sdk/`, a committed copy made by the SDK's copy script. Do not edit its
`core/`; change `packages/bot-sdk` and re-copy. `tsconfig.json` excludes `src/bot-sdk/extras` (the optional runners, such as Trigger.dev, need packages this Host does not install).

## Layout

- `src/bot-sdk/`: the copied SDK, reached through the `@ai-chat/bot-sdk/*` alias in `tsconfig.json`. `core/` and each plugin's server and client code are replaced on every copy; every `ui/` folder is the Host's to edit. `VERSION` records the commit and time of the copy.
- `src/lib/chat.ts`: `createBotSdk({ plugins: [models(), runner(), assistant()] })` (plus `computer` when the E2B variables are set) with `getUser` from `auth()`.
- `src/app/api/chat/[...path]/route.ts`: the catch-all handler under `/api/chat`.
- `src/instrumentation.ts` and `src/instrumentation-node.ts`: `chat.start()` and the SIGTERM drain.
- `src/components/chat-root.tsx`: `<ChatProvider>` with a `router` adapter on `next/link` and `next/navigation`.
- `prisma/schema.prisma`: Auth.js's `User` (with a scrypt `passwordHash`), in `public`.
- `scripts/migrate.ts`, `scripts/fake-ollama.ts`: the chat migration and the fake Provider.

## Setup

Requires Node 24 and a Postgres where the role can create extensions (`pg_trgm`). Set these in the
environment or in a gitignored `.env` (see `.env.example`):

- `DATABASE_URL`
- `AUTH_SECRET`: `openssl rand -base64 32`
- `AUTH_TRUST_HOST=true` for local hosts
- `KEY_ENCRYPTION_SECRET`: keep it stable, since it encrypts saved Provider keys
- `E2B_API_KEY`, `E2B_API_URL`, `E2B_SANDBOX_URL` (optional): the three self-hosted E2B values that turn on the `computer` plugin, so Bots get a Computer. Set all three or none; with none, Bots work without one. See `packages/bot-sdk/README.md` for the setup.

```sh
pnpm -F @ai-chat/example-next-prisma db:migrate   # prisma migrate deploy, then the chat schema
pnpm -F @ai-chat/example-next-prisma build
pnpm -F @ai-chat/example-next-prisma start         # or dev
```

`db:migrate` runs `prisma migrate deploy` for `public`, then `scripts/migrate.ts`, which calls the
SDK's migrate (the same function `chat.migrate()` uses). Run it before `start`: `chat.start()`
refuses to boot against an unmigrated `chat` schema.

## Trying the chat without a real Provider key

1. Start the fake Provider on a free port (default 11436): `pnpm -F @ai-chat/example-next-prisma fake-provider`.
   Set `FAKE_PROVIDER_PORT` to change it.
2. Sign up at `/sign-up`, then open Keys & settings (`/settings/keys`).
3. Under Ollama, enter the host `http://localhost:11436` and save. The Ollama host is a credential
   the user enters, so the fake Provider is selected there rather than by a server setting.
4. Start a Conversation on `/c`. The Model `fake-model` streams a Markdown reply.

## Account deletion and Shared links

- `/settings/account` (linked from the header) deletes the signed-in user. It calls the SDK's
  `chat.deleteUser` first, then deletes the Auth.js user, then signs out. A failure leaves the user
  signed in, so the button can be pressed again.
- `/share/<token>` is a server-rendered read-only page from `chat.getSharedConversation`. An unknown
  or removed token answers 404.

## Checks

- `pnpm -F @ai-chat/example-next-prisma smoke`: recreates the `ai-chat_smoke` database on the server
  in `SMOKE_ADMIN_URL` (default `localhost:5434`), runs `db:migrate` on it, then sends a Run through
  the SDK handler to the fake Provider and checks the streamed reply and the saved Message. Start
  the fake Provider first; the script waits 10 s for it, then fails.
- The copy drift check (CI runs it): `pnpm -F @ai-chat/bot-sdk copy examples/next-prisma/src/bot-sdk`
  and then fail if `git diff`/untracked files show a change under `src/bot-sdk`, except
  `VERSION`, at the root, which records each copy's commit and time.

## Verified

Checked with `next build` and `next start` on a free port, then curl against the handler: sign up
(201, and 409 for a duplicate), Auth.js credentials sign-in (a session cookie, and an error for a
wrong password), the 401 for an anonymous chat call, saving the fake Ollama credential, creating a
Conversation, and a streamed Run (`RUN_STARTED`, `TEXT_MESSAGE_*`, `RUN_FINISHED`) whose reply was
saved as the assistant Message. Signed-in `/c`, `/c/<id>` and `/settings/keys` returned 200.
Shared links (200 for a shared Conversation with its title as the page title, 404 for an unknown
token) and account deletion (user, Conversations and the Shared link removed, session cleared) were
checked the same way. Browser interaction and Stop were not exercised.

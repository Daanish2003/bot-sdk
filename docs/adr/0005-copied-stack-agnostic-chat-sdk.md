---
Status: accepted
---

# The chat SDK is a copied, stack-agnostic core with Host-owned UI

ai-chat becomes a Chat SDK that its author copies into company repos to speed up prototypes there. Those repos use other stacks (Next.js, Prisma, their own auth), so the SDK may not assume TanStack Start, Drizzle on the Host side, oRPC on the Host side or Better Auth. It is **copied, never published**: the canonical source is one workspace package, `packages/chat-sdk/`, laid out exactly as a Host receives it, and `apps/web` is just one Host, importing only its public entry points.

- **Three units.** `core/` holds `shared` (isomorphic types, Message parts, model metadata, citation parsing), `server` and `client` (the headless client plus the React provider and hooks). A Host never edits the core and updates it by copying it again. `ui/` holds the components, which the Host owns and may change. The client never imports the server, and both import `shared`.
- **In a Host**, the folders go into its source tree (for example `src/chat-sdk/`). Imports inside the SDK are relative. `ui/` reaches shadcn primitives through the Host's own `@/components/ui/*`: the Host needs Tailwind v4, shadcn and the listed components, and the SDK ships no copies of the primitives. In this repo that alias points at `packages/ui`.
- **The server** is `createChat({ databaseUrl, getUser, keyEncryptionSecret, basePath, blobStore?, pubsub?, logger? })` (amended 2026-10-10: `providers?` is struck, its role is `hostProviders` and `byok` in ADR 0007), which returns `{ handler, migrate, deleteUser, start, stop, getSharedConversation }`. `createChat` has no side effects. The Host calls `start()` at boot and `stop()` on SIGTERM.
- **Auth comes from the Host.** `getUser(request)` returns `{ id } | null`. The SDK stores user ids as plain strings with no foreign key, and the Host calls `chat.deleteUser(id)` when it deletes a user. Display names and avatars stay with the Host, which renders them in the shell's `userMenu` slot.
- **One web-standard handler**, `chat.handler(request) → Response`, mounted on `${basePath}/*`. It serves the RPC calls, the streaming run endpoint and the public Shared link read. oRPC is internal, with no OpenAPI reference and no public contract.
- **Postgres is required.** The SDK owns its tables in their own Postgres schema, creates its own pool from `databaseUrl`, uses Drizzle internally behind a storage interface, and ships its migrations as SQL run by `chat.migrate()`.
- **React only** for the UI. `<ChatProvider client router queryClient?>` takes the headless client from `createChatClient({ baseUrl })`, a `router` adapter (`Link`, `navigate(page)`, `useLocation()`, `shareUrl(token)`) that maps the pages `new | conversation | keys` to the Host's URLs, and optionally the Host's `QueryClient` (otherwise it creates its own).
- **Shared link pages are rendered on the server by the Host.** Its route calls `chat.getSharedConversation(token)` and renders `<SharedConversationPage data>`. The Host owns the URL, the 404 and the meta tags.
- **Dependencies and tests.** The `chat-sdk` `package.json` is the list of npm dependencies a Host installs, and its README says which ones `core` needs and which `ui` needs. Tests stay in the canonical repo and are not copied.
- **`apps/web` keeps** Better Auth and its tables, login, env, logging, the thin routes and the user menu.

## Considered Options

- **Publish npm packages** (tsdown, Changesets, trusted publishing): rejected. The SDK is personal code reused by copying, and Hosts get to change the UI.
- **Assume this repo's stack** (TanStack Start, Better Auth, Drizzle in the Host): rejected because the target repos differ.
- **Let the Host edit everything**: rejected because re-copying would become a merge. The no-edit line sits between state logic (core) and markup (ui).
- **Ship copies of the shadcn primitives with the SDK**: rejected because they would drift from the Host's theme.

## Consequences

- The chat tables lose their foreign keys to `user`, and existing data has to move into the SDK's schema.
- The process-local run registry and the boot sweep move behind `start()` / `stop()` and the pub/sub seam.
- A Host needs Postgres, Tailwind v4 and shadcn.

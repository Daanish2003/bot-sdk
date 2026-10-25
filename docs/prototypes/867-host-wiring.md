# PROTOTYPE (throwaway): Host wiring under the new architecture

Ticket: [Host wiring under the new architecture](https://github.com/Daanish2003/bot-sdk/issues/867) (map #853).

These are type-level sketches, not working code. They exist so the owner can react to the shape. Everything already decided on the map is used as given: adapter slots, features, the `users` slot, `models`, `createHttpHandler`, contracts, `@botsdk/*`. Two things are still open, and each has two variants:

1. **How the config is nested**: flat slots (A) or one `adapters` group (B).
2. **How a feature is written**: one object literal (X) or a builder that infers its types (Y).

---

## 1. `apps/web/src/services.ts`

### Variant A: flat slots

```ts
import { createBotSdk, postgres } from "@botsdk/bot";
import { createHttpHandler } from "@botsdk/bot/http";
import { e2bComputer } from "@botsdk/computer-e2b";
import { s3Blobs } from "@botsdk/blobs-s3";
import { redisPubSub } from "@botsdk/pubsub-redis";
import { emailChannel } from "@botsdk/channel-email";
import { memory } from "@botsdk/memory";
import { skills } from "@botsdk/skills";
import { knowledge } from "@botsdk/knowledge";
import { mcp } from "@botsdk/mcp";
import { anthropic } from "@tanstack/ai-anthropic";
import { openai } from "@tanstack/ai-openai";

export const sdk = createBotSdk({
  database: postgres({ connectionString: ENV.DATABASE_URL }),
  keyEncryptionSecrets: [ENV.KEY_ENCRYPTION_SECRET],
  // runner: omitted → the in-process Executor
  computer: e2bComputer({ apiKey: ENV.E2B_API_KEY, template }),
  blobs: s3Blobs({ bucket, endpoint }),
  pubsub: redisPubSub({ url: ENV.REDIS_URL }),
  models: {
    providers: [anthropic, openai],
    hostCredentials: { anthropic: { apiKey: ENV.ANTHROPIC_API_KEY } },
    byok: true,
    getQuota,
    linkedCredentials,
    defaultImageModel,
  },
  channels: [emailChannel({ provider: resend(ENV.RESEND_KEY), domain })],
  users: { isBlocked, verifiedEmail },
  features: [memory(), skills(), knowledge(), mcp({ servers })],
  logger: log,
});

export const http = createHttpHandler(sdk, {
  basePath: "/api/bots",
  getUser: async (req) => {
    const s = await auth.api.getSession({ headers: req.headers });
    return s?.user ? { id: s.user.id } : null;
  },
  rateLimits: { "bots.send": { window: 60, max: 30 } },
});
```

### Variant B: one `adapters` group

```ts
export const sdk = createBotSdk({
  adapters: {
    database: postgres({ connectionString: ENV.DATABASE_URL }),
    computer: e2bComputer({ ... }),
    blobs: s3Blobs({ ... }),
    pubsub: redisPubSub({ ... }),
    channels: [emailChannel({ ... })],
    // executor: inngestExecutor({ client })
  },
  models: { providers: [anthropic, openai], hostCredentials, byok: true, getQuota },
  users: { isBlocked, verifiedEmail },
  features: [memory(), skills(), knowledge(), mcp({ servers })],
  keyEncryptionSecrets: [ENV.KEY_ENCRYPTION_SECRET],
  logger: log,
});
```

**Trade-off.**

- A is shorter and reads like Better Auth or the Chat SDK.
- B makes "what is swappable" obvious at a glance, and keeps the domain config (`models`, `users`, `features`) apart.

### The route mount, either variant (TanStack Start)

```ts
// src/routes/api/bots/$.ts
export const ServerRoute = createServerFileRoute("/api/bots/$").methods({
  GET: ({ request }) => http(request),
  POST: ({ request }) => http(request),
});
// The Routine webhook, email inbound and screens now live under the same mount.
// The screen socket is one crossws mount:
// server/routes/api/bots/screens/[token]/ws.ts
export default defineWebSocketHandler(sdk.computer.screenSocket); // crossws hooks
```

The lifecycle doesn't change: `await sdk.start()` at boot, `await sdk.stop()` on SIGTERM.

---

## 2. A minimal second Host (Hono, built from packed tarballs)

```ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createBotSdk, postgres } from "@botsdk/bot";
import { createHttpHandler } from "@botsdk/bot/http";
import { anthropic } from "@tanstack/ai-anthropic";

const sdk = createBotSdk({
  database: postgres({ connectionString: process.env.DATABASE_URL! }),
  keyEncryptionSecrets: [process.env.SECRET!],
  models: {
    providers: [anthropic],
    hostCredentials: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! } },
  },
  // no computer, no features: a Bot with SendToUser, Routines, Check-ins, Helpers (General only), web search off
});

const http = createHttpHandler(sdk, {
  basePath: "/api/bots",
  getUser: (req) => ({ id: req.headers.get("x-demo-user") ?? "demo" }), // toy auth
});

const app = new Hono();
app.all("/api/bots/*", (c) => http(c.req.raw));
await sdk.migrate();
await sdk.start();
serve({ fetch: app.fetch, port: 3000 });

// In-process, with no HTTP at all:
await sdk.bots.create({ userId: "demo", name: "Ada", model: "anthropic:claude-sonnet-5-5" });
await sdk.bots.send({ userId: "demo", botId, text: "Remind me to stretch at 3pm" });
for await (const hint of sdk.conversations.watch({ userId: "demo", conversationId })) {
  const { messages } = await sdk.conversations.changes({ userId: "demo", conversationId, since });
}
```

Client side (Vite and React), with the UI added through `shadcn add https://<pages>/r/bots-app.json`:

```tsx
const client = createBotSdkClient({ baseUrl: "/api/bots", features: [] });
<BotSdkProvider client={client} router={reactRouterAdapter}>
  <BotsApp /> {/* from the registry, now owned by the Host */}
</BotSdkProvider>;
```

---

## 3. A third-party feature

### Variant X: one object literal

```ts
import { defineFeature, defineJob, sqlMigrations } from "@botsdk/bot";
import { todoContract } from "./contract"; // oRPC contract, shipped on the package's /client subpath

export function todos(options: { max?: number } = {}) {
  return defineFeature({
    id: "todos",
    needs: ["computer"],
    schema: sqlMigrations(new URL("./migrations", import.meta.url)), // table: botsdk.todo
    contract: todoContract,
    api: ({ db }) => ({
      list: ({ userId, botId }) => db.query.todo.findMany({ where: { userId, botId } }),
    }),
    tools: (turn, { db }) => [addTodoTool(turn, db, options.max ?? 50)],
    prompt: async (turn, { db }) => ({ section: await openTodosLine(db, turn), changeNotes: [] }),
    afterTurn: async (tx, turn) => {
      /* … */
    },
    jobs: [
      defineJob({ name: "todos.digest", payload: z.object({ userId: z.string() }), run: digest }),
    ],
    userData: {
      delete: { before: async (tx, userId) => {}, after: async (userId) => {} },
      export: async (tx, userId) => ({ todos: await listAll(tx, userId) }),
    },
  });
}
```

### Variant Y: a builder that infers types step by step

```ts
export const todos = feature("todos")
  .needs("computer")
  .schema(sqlMigrations(new URL("./migrations", import.meta.url)))
  .api(({ db }) => ({ list: ({ userId, botId }) => /* … */ }))
  .tools((turn, { db, computer }) => [addTodoTool(turn, db)])
  .prompt(async (turn, { db }) => ({ section: await openTodosLine(db, turn) }))
  .jobs(defineJob({ name: "todos.digest", /* … */ }))
  .userData({ delete: { /* … */ }, export: /* … */ })
  .build();
```

**Trade-off.**

- X matches how the rest of the SDK is configured (plain objects, Better Auth style), but `needs` has to be typed with a `const` generic to narrow the context.
- Y gives the narrowest types for free: after `.needs("computer")`, `computer` is non-optional in every later callback. The cost is a second style to learn.

**What a Host sees from a feature:**

- `sdk.todos.list({ userId, botId })` in-process
- `client.todos.list(...)` once `todosClient()` is passed to `createBotSdkClient`
- `/rpc/todos/*` in the HTTP layer, with no route code in the feature

---
Status: accepted
---

# The Bot SDK is published packages: a headless Bot core, features, and adapters

Supersedes ADR 0020 (one core SDK with plugins) and ADR 0017 (no public HTTP contract). Amends ADR 0005, ADR 0011 and ADR 0027. Charted in Wayfinder [#853](https://github.com/Daanish2003/bot-sdk/issues/853); each point below links to the ticket that holds its detail.

The SDK is no longer copied into Hosts. It is **public npm packages under `@botsdk`** that others install and use on their own stack. Four things in the old design made that hard:

- The Better Auth-style plugins mixed infrastructure with features.
- The SDK owned the HTTP layer and called `getUser(request)` itself.
- Every Host got every table.
- One 15.5K-line `bot` plugin reached the others through roughly 110 `sdk.plugin("x")` lookups.

Bot behaviour does not change.

- **A Bot core, features, and adapters** ([#858](https://github.com/Daanish2003/bot-sdk/issues/858)).
  - **The core is the Bot:** Conversations, Turns, Triggers and the Router, Routines, Check-ins, Helpers, Demonstrations, Auto-review, Secrets, SendToUser, context engineering, Models, Channels and the Computer service.
  - **Adapters** fill flat config slots for infrastructure: `database`, `runner`, `computer`, `blobs`, `pubsub` and `channels`.
  - **Features** are optional capabilities: Memory, Skills, Knowledge and MCP Connections.
  - A feature is one `defineFeature({ id, needs, schema, contract, api, tools, prompt, afterTurn, jobs, userData })` object. It declares the core services it needs and receives them typed.

    _Amended 2026-10-30 ([#1013](https://github.com/Daanish2003/bot-sdk/issues/1013), approved by the owner): `defineFeature` also takes an optional `resetBot(botId, userId, context)` hook. `bots.reset` calls it for each enabled feature once the reset commits. The call is best-effort: a failure is logged and the reset stands. Memory implements it by deleting the Bot's memory directory when the user has a Computer, so the core never learns where a feature keeps its files._

    _Amended 2026-11-02 ([#1185](https://github.com/Daanish2003/bot-sdk/issues/1185), spec [#1166](https://github.com/Daanish2003/bot-sdk/issues/1166), for owner review on its PR): `assignments` joins the core services a feature can declare in `needs`. It offers `create`, `read` and `cancel`, and each feature gets its own, which acts only on its owner's Bots and on Assignments that feature made. An Assignment made by a feature names one of the feature's `jobs`, and the core queues that job, with the public `assignmentEnded` payload, in the transaction that ends the Assignment, so the core still never calls a feature directly. A feature's text reaches the Bot as untrusted data, following ADR 0021, and never counts as the user's word in Auto-review. These go beyond the two seams approved for spec 2._

    _Amended 2026-11-03 ([#1202](https://github.com/Daanish2003/bot-sdk/issues/1202), decided by the owner): the `assignments` service's `create` takes the caller's transaction, as the Bot's own `assign_work` does, so a job step's Checkpoint commits with the Assignment and a replay never makes a second one. It returns the Assignment's `id` and the `conversationId` to hint, and the caller wakes the runner and hints the thread once the transaction commits. A refusal comes before anything is written, so the caller may catch it and commit. It takes the Conversation's lock, so any lock of the caller's that others take before a Conversation's comes first. `read`, `cancel` and `move` keep their own transactions._

    _Amended 2026-11-03 ([#1186](https://github.com/Daanish2003/bot-sdk/issues/1186), decided by the owner): the `assignments` service's `create` takes an optional `turnId`, the id of the Bot Turn that started the work, which a feature has as `turn.id` in `tools` and `afterTurn`. The core works out the chain from that Turn, with the logic a Bot's own `assign_work` uses, so a feature can't state its own depth and a Bot → feature → Bot loop stops at the chain limit: past it is CONFLICT, and a Turn that is unknown or not the owner's is NOT_FOUND. Work with no Turn behind it, such as a webhook, starts at depth 1. A Representative's hand-off has no Bot Turn behind it, so it starts at depth 1 too. The Assignment takes the depth and no parent: a feature names none, and only its job hears of the end, so no Bot would wake to carry on a parent it blocked. It takes the lock of the Turn's Bot's 1:1 Conversation as well as the target's, in order._

    _Amended 2026-11-03 ([#1218](https://github.com/Daanish2003/bot-sdk/issues/1218), decided by the owner): the core supplies the Turn in a feature's tools. The `assignments` service in the `context` that `tools` is given is built for that Turn, or for the Turn that started a Helper, so `create` counts from it and leaving out `turnId` can't escape the chain limit. If the tool names a Turn too, that Turn must be the owner's and the deeper of the two counts, so naming one can't lower the depth. The Turn is carried by the service rather than by request-scoped state, so concurrent Turns can't mix and a job the runner starts inside a tool's call can't inherit one. A replay lists the tools for the same Turn and so counts the same. Three limits stand. A job has no live Turn, so it keeps passing `turnId` itself, with the id its payload carries, and without it starts at depth 1. A service kept from `api` or from a job's context knows no Turn, so a tool must use the one it's given. `afterTurn` still passes `turn.id` itself. Parents are not added: a feature's Assignment stays depth-only with its own budget until real use shows a need, and the end paths don't change. Whether a Representative's hand-off needs a limit moved to [#1171](https://github.com/Daanish2003/bot-sdk/issues/1171); it stays at depth 1._

    _Amended 2026-11-08 ([#1355](https://github.com/Daanish2003/bot-sdk/issues/1355), approved by the owner while slicing): `MessagingAdapter` gains an optional `webhook(account, { headers, body }, call)`, declared instead of `listen` by an adapter whose platform only posts to a webhook. The `channel` plugin serves one public route per such adapter, `POST <basePath>/channels/<platform>/<accountId>`, which reads the account, has the adapter check the request's signature over the raw body and turn it into updates, and hands them to the same inbound path a listener's take. Since [#1363](https://github.com/Daanish2003/bot-sdk/issues/1363) it answers 202 only once they are stored. A refused request answers 400 and stores nothing. Each update id is claimed in the runtime's `counters` for a day, so a platform's retry is dropped on any process; the in-process dedupe a listener relies on can't see a retry that lands on another process. The `CounterStore` gains `reset(key, windowMs?)` for that, so a webhook can release an update's id when storing it fails. No new table._

    _Amended 2026-11-05 ([#1334](https://github.com/Daanish2003/bot-sdk/issues/1334)): `MessagingAdapter` gains an optional `verifiesSender`: true when the platform authenticates senders (Telegram), and left out when they can be spoofed. Only an account on such a platform wakes a Bot, since a spoofed sender would speak with the user's Linked identity: saving one on another platform is refused, and one saved before is listed but stays silent._

    _Amended 2026-11-18 (decided by the owner): the Representative feature (spec [#1167](https://github.com/Daanish2003/bot-sdk/issues/1167)) and everything built for it in the later Representative specs ([#1168](https://github.com/Daanish2003/bot-sdk/issues/1168) to [#1180](https://github.com/Daanish2003/bot-sdk/issues/1180)) are removed, and with them the seams they added: the `representativeLoop`, `releaseApprovals`, `factApprovals`, `pages`, `channelAccounts`, `pubsub` and `counters` core services; the `assignments` service's `move`, `markOverdue` and `redact`; `defineFeature`'s public routes and its `onStranger`, `onEmail`, `channelAccountOwner` and `stopTurns` hooks; the feature context's `isUserBlocked`; and `MessagingAdapter`'s `MessagingReach`. The amendments that added them (#1188, #1189, #1194, #1195, #1264, #1288, #1299, #1300, #1305, #1312, #1317, #1331, #1337 and #1339) no longer hold. A Channel account belongs to one Bot again, and the core's `page` table goes with Pages. A feature's jobs keep `cancelIn` and `replaceIfNotStarted` ([#1248](https://github.com/Daanish2003/bot-sdk/issues/1248))._

  - Features never call each other and never add columns to core tables. They contribute no RPC routes. They can serve other routes: `routes`, which get the core context until spec 3 replaces them.
  - `defineFeature` is public, so third parties write features exactly as we do.
- **Memory, Skills and Knowledge sit on the Computer** ([#864](https://github.com/Daanish2003/bot-sdk/issues/864)). They have no store of their own, because the Bot edits these files itself (ADRs 0022, 0025). Any `ComputerProvider` works. An unmet `needs` throws at construction.
- **Headless first, HTTP optional** ([#860](https://github.com/Daanish2003/bot-sdk/issues/860)).
  - Domain methods take `userId` explicitly, for example `sdk.bots.send({ userId, botId, text })`.
  - `createHttpHandler(sdk, { getUser, basePath, rateLimits })` is an optional fetch handler over them. It uses nested oRPC routers, serves the webhook, email and screen routes and the SSE change hints, and has a `toNodeHandler` helper. The screen socket is exported as crossws hooks.
  - The browser client is typed by per-feature oRPC **contracts**. Those contracts are public interface, versioned by semver (this supersedes ADR 0017).
- **Users are opaque ids** ([#863](https://github.com/Daanish2003/bot-sdk/issues/863)).
  - A `users: { isBlocked?, verifiedEmail? }` slot lets the SDK ask the Host about a user. Quota and linked credentials stay in `models`.
  - Bans are checked only on Triggers that don't come from the user, as before.
  - `sdk.users.delete` and `sdk.users.export` compose each feature's `userData`.
- **Postgres only** ([#861](https://github.com/Daanish2003/bot-sdk/issues/861)).
  - Drizzle stays internal. The `database` slot takes a connection string or a pg-compatible `Pool`.
  - The core and each feature ship SQL migrations, and `migrate()` or the `botsdk` CLI applies only the enabled ones (`--print` outputs the SQL).
  - The fixed schema is `botsdk`, starting from a fresh baseline.
- **The durable runner's seam is an Executor** ([#862](https://github.com/Daanish2003/bot-sdk/issues/862)).
  - Only the wake-up and run of a due job varies, through `start`, `notify` and `stop`.
  - The replay engine, job history, leases and transactional enqueue stay core, so Checkpoints stay exactly-once.
  - The adapters are the in-process poller (the default) and Inngest.
  - `defineJob` is public, `replaceIfNotStarted` replaces the Router's reads of the job tables, and Trigger.dev goes.
- **The core's internal modules** ([#865](https://github.com/Daanish2003/bot-sdk/issues/865)).
  - The modules are conversation, triggers, turn, agent-loop, context, tools, routines, helpers, demonstrations and safety, plus the folded-in services.
  - Each module has one entry point, and a lint rule enforces one dependency direction.
- **Packages** ([#859](https://github.com/Daanish2003/bot-sdk/issues/859)).
  - The packages are:
    - `@botsdk/client` (contracts and shared types)
    - `@botsdk/bot` (the core, plus the `/http` subpath)
    - `@botsdk/react`
    - one package per feature
    - one package per adapter, carrying its driver
    - `@botsdk/testing`
  - They are released in one Changesets `fixed` group, built with tsdown, ESM-only, with trusted publishing.
  - The Host installs the `@tanstack/ai-*` providers it registers.
- **UI from a shadcn registry** ([#866](https://github.com/Daanish2003/bot-sdk/issues/866)).
  - `@botsdk/react` (`BotSdkProvider`, with React Query as a peer) needs the HTTP layer.
  - Registry items pin the same version, and Hosts own the files after `shadcn add`.
  - The docs and the registry are served from GitHub Pages.
- **The Host's wiring** is shown in the [prototype](https://github.com/Daanish2003/bot-sdk/blob/prototype/867-host-wiring/docs/prototypes/867-host-wiring.md) ([#867](https://github.com/Daanish2003/bot-sdk/issues/867)).

## Considered Options

- **Keep the Better Auth-style plugins and fix the schema** with a generator: plugins stay the wrong tool for infrastructure, and the locator coupling stays (#854, #858).
- **A generic CRUD storage adapter**: it can't keep `SKIP LOCKED`, advisory locks or `pg_trgm` (#855).
- **A swappable durable-execution engine** (the step and dispatch ports): it would need idempotency keys and an outbox, and would lose prompt abort (#856, #862).
- **One package with subpaths for everything**: every Host would install every driver and parser (#859).
- **A strangler migration**: it doubles the code and tests while behaviour is frozen (#868).
- **Keep copying source (ADR 0005)**: outsiders can't adopt a library they have to copy.

## Consequences

- ADR 0020 is superseded. ADR 0017 is superseded.
- ADR 0005's copy model, the "Host owns `ui/`" rule and `createChat` are superseded. "Auth comes from the Host", "Postgres is required" and "the SDK ships its migrations" still hold.
- ADR 0011's runner interface, its "a Host can't register its own jobs", its Trigger.dev adapter and "the runner is a plugin" are superseded. The history-replay amendment of 2026-10-17 still holds.
- ADR 0027's plugin list becomes the core and features above.
- The work ships as eight specs, in place and green after each one (#868): core and features; the runner seam; headless and HTTP; storage; packages and build; registry, docs and release; the tarball example Host; the Inngest Executor.
- The owner creates the `botsdk` npm org before the first publish.
- New dependencies: `inngest` (adapter package only), `crossws`, tsdown, Changesets and Astro Starlight (docs workspace).

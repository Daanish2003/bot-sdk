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

    _Amended 2026-11-03 ([#1188](https://github.com/Daanish2003/bot-sdk/issues/1188), spec [#1167](https://github.com/Daanish2003/bot-sdk/issues/1167), decided by the owner on that spec): `representativeLoop` joins the core services a feature can declare in `needs`, beyond the two `defineFeature` seams the spec had approved. Its `run` plays `runLoop` in the feature job's own context and accepts only a Representative's identity (its owner, the Representative, the Customer and the Model), so a feature can't run a Bot's loop. That loop has no Computer and no spill, no Auto-review, the tools its caller passes and no others, the `representative` usage kind on the owner's Quota, which it checks once before starting, and a thread and cache key per Customer._

    _Amended 2026-11-03 ([#1194](https://github.com/Daanish2003/bot-sdk/issues/1194), spec [#1167](https://github.com/Daanish2003/bot-sdk/issues/1167), decided by the owner): the `assignments` service gains `move({ userId, id, botId })`. It moves one of the feature's own Assignments that hasn't ended to another of the owner's Bots, keeping its status and log, as a feature that lets the owner choose a Bot needs. It adds a log row, skips the old Bot's unread hand-over, tells the old Bot if it had read it, and wakes the new Bot. An Assignment that ended is CONFLICT; another owner's Assignment or Bot, or one another feature made, is NOT_FOUND. This goes beyond the seams already approved._

    _Amended 2026-11-03 ([#1195](https://github.com/Daanish2003/bot-sdk/issues/1195), spec [#1167](https://github.com/Daanish2003/bot-sdk/issues/1167), decided by the owner on that spec): `releaseApprovals` joins the core services a feature can declare in `needs`, beyond the seams the spec had approved. It offers `post`, `answer` and `drop`, each in the caller's transaction. `post` puts a link-only `release_approval` card in a Bot's Conversation, naming the page the feature gives it; `answer` closes it with the owner's yes or no, given on the Representative's page, and wakes the Bot with a Trigger the core words itself, so a feature's text never reaches the Bot as an answer; `drop` closes it and wakes no one, for a Bot reset or the owner choosing another Bot. The card holds the Approval's state, so the service adds no core table and a Host without the feature carries nothing. Channels get a link and no yes or no. It expires 7 days after it is posted, read from the time it holds rather than by a job as ADR 0030's Approvals are, and the draft stays and can still be approved from the page, which then wakes no one._

  - Features never call each other and never add columns to core tables. They contribute no RPC routes. They can serve other routes: `routes`, which get the core context until spec 3 replaces them, and the public routes below.

    _Amended 2026-11-03 ([#1189](https://github.com/Daanish2003/bot-sdk/issues/1189), spec [#1167](https://github.com/Daanish2003/bot-sdk/issues/1167), approved in the spec): `defineFeature` gains two narrow seams beyond the routes above. Both are for features that serve strangers, and the second is built in a later spec._

    _**Public routes (built in #1189).** An optional `publicRoutes: [{ method, path, handle }]`. `createHttpHandler` serves each under `basePath` with no signed-in user, before `getUser` runs. `handle(request, { context, params, basePath })` gets only the feature's own context (`FeatureContext`, with the services in its `needs`), never the core's `sdk` and never a user. A method and path that another route has, public or not, throws when the instance is built. A feature's existing `routes` are unchanged, and they still get the whole core context and a signed-in user. The original line saying features contribute no routes was wrong, because `routes` already existed; the line above is the correction. Web chat uses these routes (#1173)._

    _**The stranger hook (not built here; built in [#1172](https://github.com/Daanish2003/bot-sdk/issues/1172)).** Nothing can call it until a feature can hold a Channel account, so no code lands in spec 2. Its shape: an optional `onStranger(message, context)`, where `message` is the inbound Channel message (the Channel, the account, the sender's platform identity and whether the Channel verified it, and the text and attachments) and `context` is the feature's own context. The core calls it for an inbound message on a Channel account the feature holds, ahead of the Linked identity check, so everyone there is a stranger to the core and link codes do nothing. It returns nothing: the feature decides what the message becomes, and the core starts no Bot Conversation and no Turn for it. Inbound dedupe stays the core's, namespaced by platform and account. A throw is logged and the update is dropped, as for other inbound failures._

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

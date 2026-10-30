# Messaging inbound transport

Research for [#1037](https://github.com/Daanish2003/bot-sdk/issues/1037) (child of map [#976](https://github.com/Daanish2003/bot-sdk/issues/976), Messaging Channels). Researched 2026-10-30 against each platform's own docs and this repo's code. Builds on `docs/research/messaging-channel-apis.md` (#957), which settled which platforms qualify; this note covers only how messages arrive.

## Question

For Telegram, Discord, Slack, Matrix, WhatsApp Cloud API and Telnyx SMS: which inbound modes exist, which work from a laptop without a tunnel, how a long-running listener or a webhook route fits the runner adapters (in-process poller, Inngest Executor) and the Host's HTTP layer, and what rate limits and duplicate delivery the Trigger's unique ID must absorb.

## Verdict

| Platform               | Inbound modes                                                                            | Laptop, no tunnel            | Duplicate / ID to dedupe on                              | Ack deadline                                               | Verdict                                        |
| ---------------------- | ---------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| **Telegram**           | `getUpdates` long poll, or `setWebhook` (exclusive) [T1]                                 | Yes, long poll               | `update_id` (sequential; offset confirms) [T1]           | Webhook: any 2xx, retry count unspecified [T1]             | Listener or webhook, both fine                 |
| **Discord**            | Gateway WebSocket (default), or Interactions Endpoint URL for interactions only [D1][D2] | Yes, Gateway is outbound     | Message `id` (reasoned, see Gaps)                        | Gateway: heartbeat; Interactions: not covered in page read | Needs a persistent listener for plain messages |
| **Slack**              | Events API over HTTP, or Socket Mode WebSocket [S1][S2]                                  | Yes, Socket Mode             | `event_id`, globally unique [S1]                         | HTTP: 2xx within 3 s [S1]                                  | Either; Socket Mode for dev                    |
| **Matrix**             | Client `/sync` long poll [M1]; appservice pushes `PUT /transactions/{txnId}` [M2]        | Yes, `/sync`                 | Appservice `txnId`; `/sync` `next_batch` cursor [M1][M2] | Appservice: 200 OK                                         | `/sync` listener                               |
| **WhatsApp Cloud API** | Webhook only [W2][W3]                                                                    | No: needs a public HTTPS URL | `wamid` message ID [W3]; duplicates expected [W1][W2]    | 200 OK                                                     | Webhook route only                             |
| **Telnyx SMS**         | Webhook only [X1]                                                                        | No: needs a public URL       | `data.id` of the event [X1]                              | Any 2xx within 2 s [X1]                                    | Webhook route only                             |

Two shapes cover all six:

- **Listeners** (Telegram poll, Discord Gateway, Slack Socket Mode, Matrix `/sync`) are outbound connections the Bot's process holds open. They work from a laptop with no tunnel.
- **Webhook routes** (WhatsApp, Telnyx, and optionally Telegram and Slack) are public HTTPS POSTs. They need a reachable URL, so a laptop needs a tunnel.

## Per platform

### Telegram

- **Modes:** `getUpdates` (long polling) and `setWebhook` are "mutually exclusive ways of receiving updates". `getUpdates` "will not work if an outgoing webhook is set up" [T1].
- **Long poll:** `timeout` is in seconds and defaults to 0 (short polling, "for testing purposes only"). `limit` is 1-100, default 100 [T1].
- **Confirmation and duplicates:** `offset` "must be greater by one than the highest among the identifiers of previously received updates"; an update is confirmed when `getUpdates` is called with a higher offset, and "all previous updates will be forgotten". The docs advise recalculating `offset` after each response to avoid duplicates. `update_id` increases sequentially, but after a quiet week the next identifier is chosen randomly. Unread updates are kept at most 24 hours [T1]. So: persist the last offset, and a crash between receiving and confirming redelivers that batch.
- **Webhook:** HTTPS POST of one Update. A non-2xx response is repeated, "give up after a reasonable amount of attempts" (count and timing unspecified). `max_connections` 1-100, default 40. `secret_token` comes back in `X-Telegram-Bot-Api-Secret-Token`. Ports 443, 80, 88, 8443 [T1].
- **Rate limits (outbound):** about one message per second to one chat, 20 messages per minute to a group, about 30 messages per second for broadcast; excess gives 429 [T2].
- **Local:** long poll from the laptop. No tunnel.

### Discord

- **Gateway:** the app opens a WSS connection (URL from Get Gateway Bot, cached for reconnects), sends a heartbeat every `heartbeat_interval` ms, and must drop the socket if a heartbeat is not acked. Identify is capped at 1000 per 24 hours, plus a concurrent-Identify limit per 5 seconds (exceeding it gives Invalid Session). After a disconnect the app Resumes with `session_id`, `seq` and `resume_gateway_url`, and should resume on a Reconnect (opcode 7) [D1].
- **Gateway limits:** 120 events sent per connection per 60 seconds, beyond which the app is disconnected. A shard holds at most 2500 guilds and apps in 2500+ guilds must shard [D1].
- **Content:** without the privileged Message Content intent, content fields are empty, except in DMs with the app and messages that mention it. DM messages need the DIRECT_MESSAGES intent and arrive on shard 0 [D1].
- **Interactions over HTTP:** by default interactions also arrive on the Gateway. An Interactions Endpoint URL is an opt-in, mutually exclusive with the Gateway for interactions, signed with `X-Signature-Ed25519` and `X-Signature-Timestamp`, and a bad signature gets 401 [D2]. This carries slash commands and components, not plain messages, so it cannot replace the Gateway for a chat Channel.
- **REST rate limits (outbound):** 50 requests per second per bot overall, per-route buckets, 429 with `Retry-After`; 10,000 invalid requests (401/403/429) per 10 minutes gets the IP blocked [D3].
- **Dedupe:** the pages read do not state a redelivery guarantee. Resume replays missed events after the sequence number, so an event already processed can come again; dedupe on the Message `id` (see Gaps).
- **Local:** Gateway is outbound. No tunnel.

### Slack

- **Events API over HTTP:** respond 2xx within 3 seconds. Failures are retried up to 3 times: the first almost immediately, then after 1 minute, then 5 minutes. `x-slack-retry-num` and `x-slack-retry-reason` (`http_timeout`, `http_error`) mark a retry. `event_id` is "globally unique across all workspaces". Deliveries cap at 30,000 per workspace per app per 60 minutes (then `app_rate_limited` events). If more than 95% of deliveries fail within 60 minutes, subscriptions are disabled and the owner emailed [S1].
- **Signing:** `X-Slack-Signature` and `X-Slack-Request-Timestamp`; HMAC-SHA256 of `v0:timestamp:body`, reject if the timestamp is more than five minutes off [S3].
- **Socket Mode:** call `apps.connections.open` with an app-level token to get a WebSocket URL that "refreshes regularly". Each event must be acknowledged using its `envelope_id` "so that Slack knows whether to retry". Up to 10 concurrent connections. Disconnect reasons `link_disabled`, `warning` (about 10 s ahead) and `refresh_requested` mean the listener must reconnect. Socket Mode apps are not allowed in the public Marketplace [S2].
- **Dedupe:** `event_id`. HTTP retries are bounded (3); an unacked Socket Mode envelope is also retried, so the same rule applies.
- **Local:** Socket Mode, no tunnel.

### Matrix

- **Client `/sync`:** the client calls `/sync` with the previous `next_batch` as `since`; the server holds the connection open up to `timeout` ms (default 0, which returns at once) and returns early on an event. `filter` limits the response; `full_state=true` ignores `timeout` [M1]. Persisting `next_batch` is the listener's cursor.
- **Appservice push:** a homeserver with the appservice registered (a registration file in the homeserver config) sends batches to `PUT /_matrix/app/v1/transactions/{txnId}`, keeps a queue, backs off exponentially when unreachable, and must not alter a transaction's events on retry. The `txnId` is for idempotency. It authenticates with an `hs_token` bearer [M2]. This needs the homeserver admin and a reachable URL, so it suits a hosted deployment, not a personal bot on someone else's homeserver.
- **Sending is idempotent:** `PUT .../send/{eventType}/{txnId}` with the same `txnId` and path returns the original response, so a retried send does not double-post [M1]. Inbound relies on `next_batch` and the event ID.
- **Rate limits:** homeservers "SHOULD implement rate limiting"; a 429 should carry `Retry-After` (`retry_after_ms` is deprecated) [M1].
- **Local:** `/sync` against a local Synapse or any homeserver. No tunnel.

### WhatsApp Cloud API

- **Inbound is webhook only.** Incoming messages and delivery statuses arrive by webhook; the pages read describe no polling alternative [W2][W3].
- **Setup:** Meta sends a GET with `hub.mode=subscribe`, `hub.challenge` and `hub.verify_token`; the route checks the token and echoes the challenge. Each event carries `X-Hub-Signature-256` (HMAC-SHA256 of the payload with the App Secret). HTTPS with a valid certificate is required; self-signed is not supported. Return 200 [W1]. Some webhooks are not sent while the app is in Dev mode [W2].
- **Retries and duplicates:** two Meta pages disagree on the window: "decreasing frequency ... for up to 7 days" [W2] against "retries immediately, then ... decreasing frequency over the next 36 hours", then dropped [W1]. Both say retries can produce duplicates and tell you to deduplicate. Design for a late duplicate up to 7 days.
- **Limits (outbound):** 80 messages per second per business number by default; 1 message per 6 seconds to the same user, with a 45-message burst that borrows from future quota (error 131056); retry failed sends after 4^X seconds [W4]. Free-form replies only inside the 24-hour customer service window; after it, templates only [W3].
- **Local:** needs a tunnel. A public HTTPS URL is required to receive anything.

### Telnyx SMS

- **Inbound is webhook only** (`message.received`). Verify `telnyx-signature-ed25519` over `{timestamp}|{raw body}` and reject a `telnyx-timestamp` more than 5 minutes old [X1].
- **Ack and retries:** any 2xx within 2 seconds; up to 3 attempts per URL with exponential backoff, then the failover URL (up to 6 attempts in all). Telnyx may deliver the same webhook more than once, so key on the event's `data.id` (not the message `id`) in a persistent store [X1].
- **Limits and cost:** 429 with `retry-after` on outbound; US off-net sending requires 10DLC, toll-free verification or a short code, else error 40301; the send guide needs purchased numbers and describes no free tier [X2]. #957 already ruled SMS out on cost; it is kept here because the ticket asks.
- **Local:** needs a tunnel.

## How it fits the runner

### What the code has today

- **The seam for webhook-style inbound already exists, for email.** A `channel` plugin adds a public route (`POST <basePath>/channels/email`, `public: true`). The route parses the provider's POST into an `InboundMail`, calls `sdk.channels.receive`, and answers 202 whether it woke the Bot or dropped the mail, so a sender learns nothing (`packages/botsdk/bot/src/bot/channels.ts`). `receive` checks the sender, then hands the Router a Trigger; a mail already handed to the Router is dropped as "a redelivery" without logging (`packages/botsdk/bot/src/bot/turn/email-inbound.ts`). The code comment states the rule: "A provider delivers at least once."
- **A Trigger's unique ID is the dedupe key** (CONTEXT.md, Trigger): "Each carries a unique ID from its source, and one whose ID the Bot has already seen is dropped." For email it is the Message-ID. For the new platforms the source IDs above are: Telegram `update_id` (per bot), Slack `event_id`, WhatsApp `wamid`, Telnyx `data.id`, Discord and Matrix message/event ID. Prefix them by Channel and account so IDs from two platforms cannot collide.
- **Plugins can hold a long-running task.** A plugin has `init` (must open no connection), `start(sdk)` after the schema check, and `stop(sdk)` in reverse order after `stopping` is set (`packages/botsdk/bot/src/plugin.ts`). A listener opens its connection in `start` and closes it in `stop`.
- **The runner is not the transport.** `Executor` is `start(run)`, `notify(jobId, runAfter)`, `stop()`; it wakes and runs due jobs held in `botsdk.job`, and the core keeps replay, leases and exactly-once Checkpoints whatever the Executor (`packages/botsdk/bot/src/runner/jobs/executor.ts`, ADR 0029). The in-process Executor polls `botsdk.job` every `pollMs` (default 2,000); the Inngest Executor delivers events to functions served from the Host's `serve()` handler (`packages/botsdk/executor-inngest/src/index.ts`). Neither holds a socket: inbound arrival happens before a job exists.

### Recommended fit

1. **Inbound adapters only convert a platform message to a Trigger.** Both shapes end at one call, like `sdk.channels.receive`: verify the platform's signature or token, build the Trigger with a prefixed source ID, hand it to the Router, which drops duplicates and queues it per Conversation. Nothing platform-specific reaches the runner. The Router's enqueue is a job in `botsdk.job`, so after that point the Executor choice is irrelevant.
2. **Webhook platforms (WhatsApp, Telnyx; optionally Slack HTTP and Telegram webhook) are public routes** on the Host's HTTP layer, same pattern as `/channels/email`. They work on both the in-process poller and Inngest because the route runs in whatever process serves HTTP. Acknowledge fast (Slack 3 s, Telnyx 2 s): the route's only work is verify, dedupe, enqueue, then 2xx.
3. **Listener platforms (Telegram poll, Discord Gateway, Slack Socket Mode, Matrix `/sync`) are a `start`/`stop` task in the Host's own long-lived process,** not an Executor concern and not a job. Reasons:
   - A socket must be held by one process. An Inngest function is a short invocation that does not suit it; the Inngest Executor is only a wake-up for jobs.
   - On a laptop or a single Node process this is the whole story, and it needs no tunnel.
   - On a serverless Host a listener cannot live there; use the platform's webhook mode instead (Telegram `setWebhook`, Slack Events API). Discord plain messages and Matrix `/sync` have no webhook equivalent for an ordinary account, so they need a long-running worker process.
4. **Persist the cursor after the Trigger.** Telegram `offset` and Matrix `next_batch` should be confirmed only after the Trigger is stored (after the Router's transaction commits). A crash between receive and store then redelivers, and the unique ID absorbs it. This is at-least-once delivery plus ID dedupe, as email already works.
5. **Several instances of the Host need one listener.** Telegram `getUpdates` from two processes with one token fights over the offset; Slack allows up to 10 Socket Mode connections and splits events between them; Discord needs one shard owner. Run the listener on one leader (a Postgres advisory lock is the obvious lever; not tested here) or only in the process configured as the worker.

### What the Trigger's unique ID must absorb

| Platform | Source of duplicates                                                    | Window                           | Key                |
| -------- | ----------------------------------------------------------------------- | -------------------------------- | ------------------ |
| Telegram | crash before offset confirm; webhook retry [T1]                         | until confirmed, max 24 h stored | `update_id`        |
| Discord  | Gateway Resume replays after a drop [D1]                                | session                          | message `id`       |
| Slack    | HTTP retries x3 (immediate, 1 min, 5 min); Socket Mode unacked [S1][S2] | about 6 minutes                  | `event_id`         |
| Matrix   | re-`/sync` from an old `since`; appservice retry [M1][M2]               | until cursor stored              | event ID / `txnId` |
| WhatsApp | webhook retries [W1][W2]                                                | 36 hours to 7 days               | `wamid`            |
| Telnyx   | up to 6 attempts [X1]                                                   | seconds to minutes               | `data.id`          |

The seen-ID record must outlive the longest window, 7 days for WhatsApp by Meta's longer claim. Whether the Router's seen-ID store is kept that long was not checked.

## Gaps

- Discord's Interactions 3-second deadline and deferred-token lifetime were not in the pages fetched, and the Gateway page read does not state a redelivery rule for message events; the Message `id` as key is reasoned, not quoted.
- Matrix event ID uniqueness and `/sync` duplicate/ordering statements were not read; `next_batch` semantics are quoted.
- Slack's Socket Mode page read does not state the retry schedule for unacked envelopes.
- WhatsApp's two Meta pages give different retry windows (36 hours and 7 days); not reconciled.
- Telegram's API page was read only to character 100,000 of 581,925; rate limits came from the FAQ.
- Seen-ID retention in the Router and the single-listener lock are design questions not verified in code.

## Sources

- [T1] Telegram Bot API: https://core.telegram.org/bots/api (`getUpdates`, `setWebhook`)
- [T2] Telegram Bots FAQ: https://core.telegram.org/bots/faq
- [D1] Discord Gateway: https://docs.discord.com/developers/events/gateway
- [D2] Discord Interactions overview: https://docs.discord.com/developers/interactions/overview
- [D3] Discord rate limits: https://docs.discord.com/developers/topics/rate-limits
- [S1] Slack Events API: https://docs.slack.dev/apis/events-api/
- [S2] Slack Socket Mode: https://docs.slack.dev/apis/events-api/using-socket-mode/
- [S3] Slack request verification: https://docs.slack.dev/authentication/verifying-requests-from-slack/
- [M1] Matrix Client-Server API: https://spec.matrix.org/latest/client-server-api/ (Syncing, transaction IDs, rate limiting)
- [M2] Matrix Application Service API: https://spec.matrix.org/latest/application-service-api/
- [W1] Meta webhooks getting started: https://developers.facebook.com/docs/graph-api/webhooks/getting-started
- [W2] WhatsApp Cloud API set up webhooks: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks
- [W3] WhatsApp Cloud API send messages: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
- [W4] WhatsApp Cloud API overview: https://developers.facebook.com/docs/whatsapp/cloud-api/overview/
- [X1] Telnyx receiving webhooks: https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks
- [X2] Telnyx send message: https://developers.telnyx.com/docs/messaging/messages/send-message
- Repo: `packages/botsdk/bot/src/channel/`, `packages/botsdk/bot/src/bot/channels.ts`, `packages/botsdk/bot/src/bot/turn/email-inbound.ts`, `packages/botsdk/bot/src/plugin.ts`, `packages/botsdk/bot/src/runner/jobs/executor.ts`, `packages/botsdk/bot/src/runner/jobs/in-process.ts`, `packages/botsdk/executor-inngest/src/index.ts`, `docs/adr/0029-publishable-packages-a-bot-core-with-features-and-adapters.md`, `CONTEXT.md` (Trigger, Channel).

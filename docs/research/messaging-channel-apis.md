# Messaging Channel APIs survey

Research for [#957](https://github.com/Daanish2003/bot-sdk/issues/957) (child of map [#953](https://github.com/Daanish2003/bot-sdk/issues/953)). Researched 2026-10-29 against each platform's own docs. Prices and terms were read on that date.

## Question

For Slack, Telegram, WhatsApp Cloud API, Discord, SMS (Twilio), Signal, iMessage, Microsoft Teams and Matrix: is there an official bot API, is there a free tier, can it be tested locally (tunnel, emulator, sandbox), does it support group chats, attachments and voice notes, and is there a maintained TypeScript SDK? Which pass the map's Channel rule (**official API, free tier, locally testable**)?

## Verdict

| Platform               | Official bot API                                                                            | Free tier                                                                                                                       | Local test                                                                   | Groups                                    | Verdict                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| **Telegram**           | Yes, Bot API [T1]                                                                           | Yes, no cost in the docs                                                                                                        | Yes: `getUpdates` long polling needs no public URL [T1]                      | Yes (privacy mode) [T1]                   | **Pass**                                                                       |
| **Discord**            | Yes, Gateway + REST [D1]                                                                    | Yes                                                                                                                             | Yes: Gateway WebSocket is outbound only [D1]                                 | Yes (servers)                             | **Pass**                                                                       |
| **Slack**              | Yes, Events/Web API [S1]                                                                    | Yes: free developer sandboxes [S2]                                                                                              | Yes: Socket Mode needs no public URL [S1]                                    | Yes (channels)                            | **Pass**                                                                       |
| **Matrix**             | Yes, open spec [M1]                                                                         | Yes, self-hosted                                                                                                                | Yes: Synapse in Docker on `localhost:8008` [M3]                              | Yes (rooms)                               | **Pass**                                                                       |
| **WhatsApp Cloud API** | Yes [W1]                                                                                    | Yes: test number to 5 recipients; 1,000 free service messages a month per number [W1][W2]                                       | Partly: webhooks only, so a tunnel is needed                                 | Not in the Cloud API docs read            | **Pass, with a tunnel**                                                        |
| **SMS (Twilio)**       | Yes [TW1]                                                                                   | Trial only: 30 days, 5 verified recipients, template bodies only [TW1]                                                          | Partly: webhooks only, so a tunnel is needed                                 | Not really (SMS is one to one)            | **Fail**: no lasting free tier, and a trial can't send a Bot's free-form reply |
| **Microsoft Teams**    | Yes (Teams SDK / M365 Agents SDK) [MS1]                                                     | No for an individual: the free M365 sandbox needs Visual Studio Pro/Enterprise, a partner programme or a Premier contract [MS2] | Partly: Agents Playground emulates Teams on localhost without a tenant [MS3] | Yes (personal, group chat, channel) [MS1] | **Fail**: no free tenant to reach real Teams                                   |
| **Signal**             | No: only unofficial `signal-cli` [SG1]                                                      | n/a                                                                                                                             | n/a                                                                          | n/a                                       | **Fail**: no official API                                                      |
| **iMessage**           | No consumer bot API. Apple Messages for Business needs an approved MSP and live agents [A1] | No                                                                                                                              | No                                                                           | n/a                                       | **Fail**: no open API                                                          |

**Build list candidates: Telegram, Discord, Slack, Matrix, and WhatsApp (needs a tunnel for local tests).** Out of scope with reasons: SMS (trial only, template bodies), Teams (no free tenant), Signal (unofficial only), iMessage (MSP-gated business programme).

"Locally testable" was read as "a developer can run the Channel end to end from a laptop at no cost". A tunnel (ngrok, cloudflared) counts, but is weaker than a polling or socket mode, so WhatsApp passes with that note.

## Per platform

### Telegram

- **API:** the Bot API, HTTPS JSON. Updates come by `getUpdates` (long polling) or `setWebhook`; the two can't be used together. Unread updates are kept for 24 hours [T1].
- **Webhook:** HTTPS only, ports 443, 80, 88 or 8443. A `secret_token` is echoed in `X-Telegram-Bot-Api-Secret-Token` so the route can check the sender [T1]. A self-hosted Bot API server lifts those limits [T1].
- **Files:** `getFile` downloads up to **20 MB**; bots send files, audio and voice up to **50 MB** [T1].
- **Voice notes:** a `Voice` object in, `sendVoice` out (OGG/Opus, MP3 or M4A) [T1].
- **Groups:** yes. In privacy mode a bot in a group only gets commands, replies to its own messages and mentions [T1].
- **Cost:** the Bot API docs name no price [T1].
- **TypeScript SDK:** Telegram publishes none. Community libraries (grammY, Telegraf) exist; not assessed here. The HTTP API is small enough to call with `fetch`.
- **Local test:** `getUpdates` from a laptop, no tunnel.

### Discord

- **API:** the Gateway (a WebSocket the app opens) plus REST [D1].
- **Intents:** `MESSAGE_CONTENT` is privileged. Without it, content is empty **except** in DMs with the app and messages that mention it. Privileged intents are a toggle in the Developer Portal; verified apps (required at 100+ servers) need approval [D1]. A personal Bot reached by DM or mention needs no privileged intent.
- **Voice notes:** a message with the `IS_VOICE_MESSAGE` flag (8192) and an audio attachment [D2]. Upload size limits weren't found in the docs read.
- **Groups:** servers and channels; DMs go only to shard 0 [D1].
- **TypeScript SDK:** Discord publishes none; `discord.js` is the community standard (not assessed). `discord-api-types` gives the types [D2].
- **Local test:** the Gateway is outbound, so no tunnel.

### Slack

- **API:** Events API + Web API. **Socket Mode** delivers events over a WebSocket from `apps.connections.open`, with no public Request URL; it is meant for apps behind a firewall. Socket Mode apps can't be listed in the public Slack Marketplace, and an app may hold up to 10 connections [S1].
- **Free tier:** the Slack Developer Program gives free developer sandboxes, which are Enterprise Grid environments with all paid features. A payment method may be asked for, for identity checks only [S2].
- **Files:** upload by `files.getUploadURLExternal` → POST → `files.completeUploadExternal`; download `url_private` with a Bearer token and `files:read`, after checking the file isn't remote [S3]. No size limit is stated there. Voice clips weren't covered in the docs read (likely files with an audio type; not verified).
- **TypeScript SDK:** **Bolt for JavaScript**, from Slack (`slackapi/bolt-js`) [S4].
- **Local test:** Socket Mode, no tunnel.

### Matrix

- **API:** an open spec. A bot is an ordinary user calling the Client-Server API (`/sync`, `m.room.message`, media upload at `POST /_matrix/media/v3/upload`); bridges use the Application Service API [M1].
- **Free tier:** self-host, or a free account on a public homeserver.
- **TypeScript SDK:** `matrix-js-sdk` (TypeScript, Node and browser, maintained by Element) [M2]. `matrix-bot-sdk` is older; an Element fork exists [M2].
- **Local test:** `matrixdotorg/synapse` in Docker, SQLite by default, on port 8008 [M3]. Fits the repo's `docker-compose.yml` beside Postgres and Mailpit.
- **Note:** end-to-end encrypted rooms need the bot to hold crypto keys; not assessed here.

### WhatsApp Cloud API

- **API:** Meta's Cloud API (Graph API). Inbound comes **only by webhook** (payloads up to 3 MB, retried for up to 7 days) [W1][W3].
- **Test mode:** adding WhatsApp creates a test business number that can message up to **5 verified recipients** for free [W1]. The quickstart's temporary token "expires quickly"; a system user token is needed for development [W1].
- **Messaging rules:** a user's message opens a **24-hour customer service window** for free-form replies; outside it the business needs an approved template [W1]. That clashes with a Bot that speaks first (Check-ins, Routines): those must be templates.
- **Pricing:** per message since 2025-07-01, user-to-business messages are free. From **2026-10-01** each number gets **1,000 free service messages a month**; past that, a payment method is needed or delivery stops [W2].
- **Groups:** not covered in the docs read; treat as one to one.
- **TypeScript SDK:** none confirmed; plain `fetch` to the Graph API.
- **Local test:** a tunnel to the Host's webhook route.

### SMS (Twilio)

- **API:** official, with an official Node helper library (not assessed).
- **Trial:** expires **30 days** after sign-up; messages and calls only to **up to 5 verified numbers**; SMS bodies must be chosen from **pre-defined templates** ("Custom message bodies are not supported"); sends from a shared Twilio number, an own number only after upgrading [TW1]. Sending in the US after upgrade needs A2P compliance registration [TW2].
- **Verdict:** a Bot's reply is free-form text, which a trial can't send, and the trial ends. **Fail** against "free tier".

### Microsoft Teams

- **API:** official. The Bot Framework SDK is **archived and unsupported since 2025-12-31**; Microsoft points to the **Microsoft 365 Agents SDK** and the **Teams SDK** (GA for JavaScript) [MS1][MS4]. Bots run in personal, group chat and channel scopes [MS1].
- **Free tier:** the free Microsoft 365 E5 developer sandbox is limited to Visual Studio Pro/Enterprise subscribers, ISV Success / partner-programme members and Premier/Unified Support customers, and lasts up to 90 days [MS2]. An individual with none of those has no free tenant to install a bot in.
- **Local test:** **Agents Playground** runs against `http://localhost:3978/api/messages` in anonymous mode with no Entra setup, and can mimic the `msteams` channel [MS3]. That is an emulator, not Teams.
- **Verdict:** **Fail** on "free tier". Revisit if the owner has a Visual Studio subscription.

### Signal

- No official bot API is documented by Signal. Bots use **signal-cli**, an unofficial client that registers a phone number and must be kept current because Signal-Server changes break old clients [SG1].
- **Verdict:** **Fail**: unofficial.

### iMessage

- No consumer bot API. **Apple Messages for Business** is for businesses through an Apple-approved Messaging Service Provider (MSP), and needs live agents during business hours; MSP applications "are carefully reviewed" [A1].
- **Verdict:** **Fail**: no open API, no free tier.

## How each fits the Channel seam

Today's seam is email-only (spec #761, ADR 0026):

- `ChannelAdapter` is just `EmailChannel` (`id: "email"`) (`packages/botsdk/bot/src/channel/plugin.ts`).
- `ChannelApi.receive(channel, mail: InboundMail)` takes a parsed email; the Host's route or the HTTP layer's `POST <basePath>/channels/email` feeds it. The Bot wakes only for mail from the user's verified email with a DMARC pass, and drops the rest silently.
- Files come as lazy `MailFile`s, read only once the mail is the owner's, capped by `maxBytes` (`packages/botsdk/bot/src/channel/email.ts`).
- Replies go out by a `channel.deliver` runner job (`deliverIn` in the Message's transaction, `sendDelivery` retried), whose payload carries email headers (`subject`, `inReplyTo`).
- The provider is a seam of its own (`EmailProvider`: `parseInbound`, `send`); Mailpit is the local one (`packages/botsdk/channel-email`), and `@botsdk/testing/fake-channel` the fake.
- ADR 0026: Channels get deliveries, not a view, so they need no change log.

What a second Channel would change:

1. **Adapter union.** `ChannelAdapter` becomes a union keyed by `id`, and `receive` takes a platform-neutral inbound message (sender id, thread id, text, lazy files) instead of `InboundMail`. The `MailFile` shape (`read(maxBytes)`) already fits every platform's "download by URL with a token" model.
2. **Identity.** Email trusts "verified account email + DMARC". Chat platforms give a platform user id instead, so each needs a **link** from that id to the SDK user (a `/start <code>` or a link step in the Host app). The map lists cross-Channel identity as not yet specified; it is the first decision a second Channel forces.
3. **Request checks.** Email checks DMARC; webhook platforms check a signed header instead: Telegram's `X-Telegram-Bot-Api-Secret-Token` [T1]; Slack, WhatsApp and Twilio sign their requests too (headers not verified here). Socket-based modes need no check, since the connection is authenticated [S1].
4. **Two inbound shapes.** Webhook Channels (WhatsApp, Telegram webhook mode, Slack HTTP mode, Teams) fit today's route. Connection Channels (Discord Gateway, Slack Socket Mode, Telegram `getUpdates`, Matrix `/sync`) need a long-lived listener the Host runs that calls `receive`, which is the local-test-friendly mode. `receive` already allows a Host-owned path.
5. **Delivery payload.** The `channel.deliver` job keeps its shape (one Message, retried by the runner), but `subject` / `inReplyTo` become per-Channel thread fields (chat id, thread ts, room id).
6. **Bot speaks first.** Telegram, Discord, Slack and Matrix let a bot message an existing chat at any time. WhatsApp needs a template outside the 24-hour window [W1], so Check-ins and Routines over WhatsApp need a template step.
7. **Groups.** All four "Pass" platforms have groups, but CONTEXT.md keeps group chats for later; a first cut can take DMs only (Discord DMs also avoid privileged intents [D1]).

## Not verified

- Telegram's pricing (the docs just don't name one), Discord and Slack upload size limits, Slack voice-clip shape, WhatsApp group support, and the signature header names for Slack, WhatsApp and Twilio.
- Community SDKs (grammY, Telegraf, discord.js, matrix-bot-sdk) were not assessed for maintenance; Bolt and matrix-js-sdk are first-party or sponsored.
- Signal's own statement on a bot API was not found; the verdict rests on there being no documented one.
- Slack's free-plan app cap (third-party sources say 10) doesn't matter if development uses a developer sandbox.

## Sources

- [T1] Telegram Bot API: https://core.telegram.org/bots/api
- [D1] Discord Gateway: https://docs.discord.com/developers/events/gateway
- [D2] Discord Message object and flags: https://docs.discord.com/developers/resources/message ; https://discord.js.org/docs/packages/discord-api-types/main/MessageFlags:enum
- [S1] Slack Socket Mode: https://docs.slack.dev/apis/events-api/using-socket-mode
- [S2] Slack developer sandboxes: https://api.slack.com/docs/developer-sandbox ; https://slack.com/blog/developers/developer-program-launch
- [S3] Slack working with files: https://docs.slack.dev/messaging/working-with-files
- [S4] Bolt for JavaScript: https://docs.slack.dev/tools/bolt-js/
- [M1] Matrix Client-Server API: https://spec.matrix.org/latest/client-server-api/
- [M2] matrix-js-sdk: https://www.npmjs.com/package/matrix-js-sdk ; matrix-bot-sdk: https://www.npmjs.com/package/matrix-bot-sdk
- [M3] Synapse Docker image: https://hub.docker.com/r/matrixdotorg/synapse
- [W1] WhatsApp Cloud API get started: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
- [W2] WhatsApp pricing: https://developers.facebook.com/docs/whatsapp/pricing
- [W3] WhatsApp webhooks: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks
- [TW1] Twilio trial accounts: https://www.twilio.com/docs/usage/trials
- [TW2] Twilio error 21608: https://www.twilio.com/docs/api/errors/21608
- [MS1] Teams bots overview: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/what-are-bots
- [MS2] Microsoft 365 Developer Program FAQ: https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program-faq
- [MS3] Microsoft 365 Agents Playground: https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/test-with-toolkit-project
- [MS4] Azure Bot Service overview (Bot Framework SDK archived): https://learn.microsoft.com/azure/bot-service/bot-service-overview
- [SG1] signal-cli (unofficial): https://github.com/AsamK/signal-cli
- [A1] Apple Messages for Business documentation: https://register.apple.com/resources/messages/messaging-documentation ; MSP onboarding: https://register.apple.com/resources/messages/msp-onboarding/

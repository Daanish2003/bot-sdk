# Voice calls and SMS with Telnyx and OpenAI realtime

Research for issue #964 (child of the map #953). Researched on 2026-10-29 against `main` at `eb6bfc6d` and the packages installed in `node_modules/.pnpm` (`@tanstack/ai` 1.0.0, `@tanstack/ai-openai` 1.0.0).

How to read the sources:

- **Repo sources.** Paths are relative to the repo root.
- **Package sources.** `ai-openai/…` is relative to `node_modules/@tanstack/ai-openai/src/` of the 1.0.0 install.
- **External sources.** Vendor docs and pricing pages, fetched 2026-10-29. Each claim links its page.
- **Unverified.** Nothing here was built, called or dialled. Claims resting on a search excerpt, a secondary source or inference are marked **unverified**.
- New dependencies, accounts and tunnels are owner decisions (AGENTS.md section 6). This file only lists them.
- Builds on `docs/research/host-surface-options.md` (#959, branch `research/host-surface-options`), which covered Twilio. The owner has since picked Telnyx and option A (#962 amendment on the map).

---

## Summary

1. **"gpt-live 1" exists: `gpt-live-1` (GPT-Live 1).** It is a full-duplex voice model that "can listen and speak at the same time, and delegate reasoning and tool use to a backend agent". It runs only on the new **Live API** (`/v1/live/sessions`), not on the Realtime API; $0.05 per session minute, billed per second, backend usage extra; no free tier ([model page](https://developers.openai.com/api/docs/models/gpt-live-1.md)). Its SIP path needs "GPT-Live SIP access" on the project and an `OpenAI-Alpha: quicksilver=v3` header, so it is **gated, alpha-stage access**, not something any key can call ([Telnyx GPT-Live guide](https://developers.telnyx.com/docs/voice/sip-trunking/gpt-live-configuration-guide.md), [OpenAI voice SIP](https://developers.openai.com/api/docs/guides/voice-sip)).
2. **GPT-Live's "client delegation" is option A built in.** The voice model hands work to _our_ backend (`session.delegation.created`), we run a Bot Turn, and we push the result back for it to say (`session.commentary.append`) ([live delegation](https://developers.openai.com/api/docs/guides/live-delegation)). No delegate function tool needs designing.
3. **Phone route: Telnyx FQDN SIP Connection → `sip.api.openai.com:5061` (TLS + SRTP) → OpenAI webhook → our Host accepts the call and attaches a server-side WebSocket.** No call audio touches our server. Telnyx documents this exact setup for GPT-Live. Fallback if GPT-Live access is refused: the same trunk to the older **Realtime SIP** with `gpt-realtime-2.1` and a `delegate_to_bot` function tool.
4. **TanStack AI 1.0 doesn't help on the phone path.** Its realtime layer is a browser WebRTC client plus an ephemeral-token helper for the Realtime API; it has no SIP, no Live API and no server-side session (section 3).
5. **SMS route: Telnyx Messaging API as a second Channel adapter** (webhook in, `POST /v2/messages` out, Ed25519-signed webhooks, MMS `media[]`, npm `telnyx` 7.29.0). US long codes need **10DLC** registration ($4 brand + $15 campaign vetting one-time; monthly campaign fees not found) or carriers block the traffic.
6. **Costs are small; the trial is tight.** Trial: $5 credit, one number, calls and texts **only to and from one verified number**, 10-minute calls. Per minute: Telnyx inbound SIP ≈ $0.0032 + GPT-Live $0.05 + the Bot's own model calls. SMS ≈ $0.004 per part + carrier fee.
7. **Channel-rule verdicts** (official API, free tier, locally testable): **SMS passes with caveats** (trial credit, verified-number-only, 10DLC before any real use; tunnel). **Phone calls pass only partly**: Telnyx is official and trial-testable with a tunnel, but GPT-Live has no free tier and needs gated access. See section 7.
8. **Safety holds if the voice layer only talks.** Every action runs inside a Bot Turn, so Auto-review and Approvals apply unchanged. Two new problems: **caller ID and SMS sender are spoofable** (no DMARC equivalent), and an **Approval inside a call** has to be asked and answered by voice within the 15-second wait.

---

## 1. What the repo already has

| Fact                                                                                                                                                                                  | Source                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A **Channel** is "anything that sends to a Bot or shows what it sends … Slack, email, webhooks, schedules or phone calls"                                                             | `CONTEXT.md` (Channel)                                                                                                              |
| The only Channel adapter is email: `ChannelAdapter = EmailChannel`, with an `EmailProvider` seam (`parseInbound(request)`, `send(mail)`)                                              | `packages/botsdk/bot/src/channel/plugin.ts`, `channel/email.ts`                                                                     |
| `sdk.channels.receive(channel, mail)` wakes the Bot "only for its user's verified email with a DMARC pass, and drops anything else silently"                                          | `channel/plugin.ts` (`ChannelApi.receive`)                                                                                          |
| A Bot reply goes out on the Channel through a `channel.deliver` runner job enqueued in the Message's transaction (`deliverIn`, `sendDelivery`)                                        | `channel/plugin.ts`                                                                                                                 |
| A Trigger's `channel` is `"web"                                                                                                                                                       | "schedule"                                                                                                                          | "webhook" | "helper" | "email"`; a Message's is `z.literal("email")` | `packages/botsdk/client/src/bot/turn.ts` |
| Auto-review takes "only the user's own Messages, or a Routine the user approved, as permission"; the reviewer prompt labels each Trigger's source and strips a forwarded email's part | `CONTEXT.md` (Auto-review), `packages/botsdk/bot/src/bot/safety/review.ts` (`withoutForwarded`, the "What started this Turn" lines) |
| An Approval waits inside its Turn for at most 15 seconds; silence counts as no                                                                                                        | `CONTEXT.md` (Approval), `safety/review.ts` (`approvalWaitMs`)                                                                      |
| A Bot talks only through SendToUser; its plain model text never reaches the user                                                                                                      | `CONTEXT.md` (SendToUser, Turn)                                                                                                     |
| The map's Channel rule: "official, free-tier API that can be tested locally"                                                                                                          | map #953 Notes                                                                                                                      |
| #957 failed SMS on **Twilio** (trial only, template bodies)                                                                                                                           | `research/messaging-channel-apis` branch, `docs/research/messaging-channel-apis.md`                                                 |
| No dependency on `openai` or `telnyx` today                                                                                                                                           | grep of `packages/*/package.json`, `apps/*/package.json`                                                                            |

---

## 2. OpenAI: which voice API

### 2.1 GPT-Live (`gpt-live-1`) on the Live API

From the [model page](https://developers.openai.com/api/docs/models/gpt-live-1.md):

- Model ID `gpt-live-1`, the only snapshot. Input audio and text, output audio and text; no image or video.
- Endpoints: **Live API (`v1/live/sessions`) supported; Realtime API (`v1/realtime`) not supported**; Responses and Chat Completions not supported.
- **$0.05 per minute** of live session, billed per second; "Backend model and tool usage is billed separately."
- Concurrent sessions: 50 (Build), 300 (Launch), 500 (Grow). **Free tier unsupported.**
- Release stage not stated. The SIP samples send `OpenAI-Alpha: quicksilver=v3`, and the Telnyx guide notes that "the earlier alpha model name and `session.context_management` were rejected in live testing" ([Telnyx GPT-Live guide](https://developers.telnyx.com/docs/voice/sip-trunking/gpt-live-configuration-guide.md)). **Treat it as alpha with per-project access.**

From [live conversations](https://developers.openai.com/api/docs/guides/live-conversations): full duplex (caller and assistant can overlap; transcript deltas per speaker); `session.usage.updated` reports cumulative `usage.seconds`; `session.close` → `session.closed` with `reason` (`close_requested`, `expired`, `content`, `remote_hangup`, `connection_lost`); a session can end `expired` at an unstated duration limit; 128,000-token context; **storage must be enabled for the project** (recordings kept 30 days; Zero Data Retention forces `store: false`). GPT-Live has no function tools of its own: backend work goes through **delegation** only.

Pydantic AI's docs note GPT-Live "is a separate protocol from the OpenAI Realtime API", so Realtime code does not carry over (search excerpt, **unverified**).

### 2.2 Delegation: the delegate seam is built in

Two modes, fixed at session creation ([live delegation](https://developers.openai.com/api/docs/guides/live-delegation)):

- **Responses delegation:** OpenAI runs a Responses model you name, with tools under `delegation.responses.tools`; your app executes the function calls (`response.output_item.done` → `response.item.create` `function_call_output` → `response.create`). This puts a second agent, with its own tools, in front of the Bot. That is option C by another road, which #962 ruled out.
- **Client delegation** (`"delegation": { "type": "client" }`): "your application runs the backend work … You also keep the conversation context, enforce permissions, and decide what results GPT-Live receives." **This is option A.**

Client delegation protocol, all from that page:

| Direction | Event                                                                | Fields / notes                                                                                                                  |
| --------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| in        | `session.delegation.created`                                         | `offset_ms`, `delegation.id`, `delegation.target: "client"`. **Does not carry the user's request**: rebuild it from transcripts |
| in        | `session.input_transcript.delta` / `session.output_transcript.delta` | `delta`, `start_ms`, `end_ms`; "can contain errors and fragments"                                                               |
| out       | `session.commentary.append`                                          | `event_id`, `delegation_id`, `content` (plain string, ≤ 500 tokens). GPT-Live says it aloud, "may paraphrase"                   |
| out       | `session.thinking.append`                                            | same fields; context GPT-Live can use later without saying it now                                                               |
| out       | `session.instructions.append`                                        | `delegation_id: null`; session-wide guidance                                                                                    |
| in        | `session.commentary.appended` etc.                                   | `client_event_id` matches our `event_id`; confirms injection, **not** that speech played                                        |

Latency rules from the same page: with no append, GPT-Live makes "an automatic spoken acknowledgment after the `acknowledgement_delay_ms` delay"; an empty `session.thinking.append` suppresses it; **any** append cancels all pending acknowledgments. No maximum duration for backend work is given. "A user interrupting the spoken conversation does **not** stop backend work." And on safety: "Enforce permissions and required user confirmations in your application. Prompt text and instruction appends are not access controls."

### 2.3 GPT-Live over SIP

From [OpenAI voice SIP](https://developers.openai.com/api/docs/guides/voice-sip) and the [Telnyx GPT-Live guide](https://developers.telnyx.com/docs/voice/sip-trunking/gpt-live-configuration-guide.md):

1. Project webhook subscribed to **`live.transport.incoming`** (also handle the deprecated `live.call.incoming`). Standard Webhooks headers `webhook-id`, `webhook-timestamp`, `webhook-signature`; verify against the raw body (the OpenAI SDK enforces a 5-minute window); dedupe by `webhook-id`.
2. For SIP, `data.type === "sip"`; use **`data.session_id`** unchanged (not the SIP Call-ID). `data.sip_headers` is "untrusted caller metadata, not authorization".
3. `POST /v1/live/sessions/{session_id}/accept` with `Authorization: Bearer <key>`, `OpenAI-Alpha: quicksilver=v3`:
   ```json
   {
     "session": {
       "type": "live",
       "model": "gpt-live-1",
       "audio": { "output": { "voice": "marin" } },
       "delegation": { "type": "client" }
     }
   }
   ```
   Omit `audio.format` (SDP negotiates it). Also `/reject` (`{ "status_code": 486 }`), `/refer` (`{ "target_uri": … }`), `/hangup`. First accept or reject wins (`decision_already_made`).
4. Attach: `wss://api.openai.com/v1/live/sessions/{session_id}/attach` with the same key and header; "Do not send `session.start`". The sideband replays only the last 3 seconds of events, so attach right after accepting.
5. Network: signalling TLS on 5061; media UDP SRTP to four published CIDRs. Voice applies at accept only. Outbound calls exist via `POST /v1/live/sessions` with `transport.type: "sip"` but "must be enabled for your organization"; 2-hour cap on a connected call.

Use **one key, webhook and SIP destination in one project**, or calls fail with `session_id_not_found` (Telnyx guide).

### 2.4 Fallback: Realtime SIP with `gpt-realtime-2.1`

If the project can't get GPT-Live access, the older Realtime SIP flow is the same shape: SIP URI `sip:$PROJECT_ID@sip.api.openai.com;transport=tls`, webhook `realtime.call.incoming` with `data.call_id`, `POST /v1/realtime/calls/{call_id}/accept` (also `reject`, `refer`, `hangup`), and control over `wss://api.openai.com/v1/realtime?call_id={call_id}` ([OpenAI voice SIP](https://developers.openai.com/api/docs/guides/voice-sip); the separate `realtime-sip` guide returned 404 to the fetcher). Here there is no delegation: we give the session one function tool, say `delegate_to_bot({ request })`, and answer its `function_call` with the Bot's reply. Realtime models in the installed adapter: `gpt-realtime` … `gpt-realtime-2.1`, `gpt-realtime-2.1-mini` (`ai-openai/realtime/types.ts`). Price from #959: audio $32 in / $64 out per 1M tokens for `gpt-realtime-2.x`, $10 / $20 for `-mini` ([OpenAI pricing](https://developers.openai.com/api/docs/pricing)). A function call is a model turn, so filler speech while the Bot works has to be prompted ("say you're checking") rather than built in (**unverified** behaviour).

---

## 3. TanStack AI 1.0

What exists, read from the installed source:

- `@tanstack/ai-openai` exports `openaiRealtimeToken` ("Token adapter for server-side use") and `openaiRealtime` ("Client adapter for browser use") (`ai-openai/realtime/index.ts`).
- `openaiRealtimeToken` mints an ephemeral key from `POST https://api.openai.com/v1/realtime/client_secrets` with `{ session: { type: "realtime", model } }`, key read from env only (`ai-openai/realtime/token.ts`).
- `openaiRealtime` connects by WebRTC: `RTCPeerConnection`, SDP posted to the Realtime `/calls` endpoint (`ai-openai/realtime/adapter.ts` lines ~191–196). Default model `gpt-realtime-2.1` (`types.ts`).
- `buildSessionUpdate` builds the GA `session.update` payload but is internal (not exported from `realtime/index.ts`).
- `RealtimeClient` (`@tanstack/ai-client`) and `useRealtimeChat` (`@tanstack/ai-react`) sit on top of that client adapter (#959). Neither is a dependency of the repo.
- grep of `ai/src/realtime` and `ai-openai/src/realtime` for `sip`, `live/sessions`, `gpt-live`: **no matches**. No SIP, no Live API, no server-side session.

**Verdict:** none of it applies to the phone path. A phone call needs a server process that accepts a webhook and holds a WebSocket to OpenAI, which TanStack AI 1.0 doesn't model. It would matter only for an in-browser voice mode (a separate build item), and even then not for GPT-Live. The phone path needs our own small client: a webhook verifier, three `fetch` calls (accept / reject / hangup) and one WebSocket. Node 24 (the dev machine runs v24.10.0) has a global `WebSocket`, but the attach needs an `Authorization` header, which the WHATWG constructor doesn't take; undici's accepts a `headers` option (**unverified**) or the `ws` package does (a new dependency).

---

## 4. Telnyx voice

### 4.1 Direct SIP to OpenAI (recommended)

All from the [Telnyx GPT-Live guide](https://developers.telnyx.com/docs/voice/sip-trunking/gpt-live-configuration-guide.md):

1. Mission Control → Voice → SIP Trunking → new **FQDN** SIP Connection, FQDN `sip.api.openai.com`, record type A, port **5061**.
2. **Encrypted media: SRTP Mandatory**; inbound transport **TLS** ("Enabling TLS alone is insufficient").
3. Codecs: Opus, plus PCMU/PCMA. "Do not configure Media Streaming linear16 for direct SIP."
4. Numbers → the number → assign the connection; in Voice settings set **Translated Number** to the OpenAI project ID (`proj_…`). Resulting destination: `sip:proj_…@sip.api.openai.com:5061;transport=tls`.
5. The guide is **inbound only**. Its sample is a Python FastAPI app; local testing is "tunnel port 8000 over HTTPS and point the OpenAI webhook at `/webhooks/openai`".

Audio stays between Telnyx and OpenAI; our Host sees only the webhook and the attach WebSocket.

### 4.2 Media Streaming to our server (the alternative)

Call Control `answer` with `stream_url`, `stream_track`, and `stream_bidirectional_mode: "rtp"` + `stream_bidirectional_codec` opens a WebSocket from Telnyx to us with `connected` / `start` / `media` (base64 RTP, reorder by `chunk`) / `stop` / `dtmf`; we send `media`, `clear`, `mark` back. Codecs PCMU/PCMA/G722 at 8 kHz, OPUS and AMR-WB at 8 or 16 kHz, L16 at 16 kHz. One stream per call. Telnyx signs the stream with Ed25519 over `{telnyx-timestamp}|{stream_url}` ([Telnyx media streaming](https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming)). We would then bridge audio to GPT-Live ourselves; OpenAI calls that the "server audio bridge" and recommends WebRTC for it, with raw G.711 μ-law/A-law at 8 kHz accepted over WebSocket ([OpenAI voice SIP](https://developers.openai.com/api/docs/guides/voice-sip)).

Costs more (Voice API $0.002/min + streaming $0.0035/min), puts live audio on our server and is **not available on a pretrial account** (no Call Control). Its one gain is provider choice: the bridge could feed Gemini Live or a cascade instead. Not recommended for the first build.

### 4.3 Caller identity

Telnyx puts SHAKEN/STIR results in the `verstat` parameter of `P-Asserted-Identity` on inbound PSTN calls (`TN-Validation-Passed` A/B/C, `TN-Validation-Failed`, `No-TN-Validation`) ([Telnyx SIP header parameters](https://developers.telnyx.com/docs/voice/stir-shaken/sip-header-parameters.md), search excerpt). Whether Telnyx forwards that header on the leg to OpenAI, and whether it appears in `data.sip_headers`, is **unverified**. Even an A attestation says the carrier knows the caller's number, not that the person is our user.

---

## 5. Telnyx SMS

- **Inbound:** webhook `message.received` on the number's Messaging Profile. `payload.id` (dedupe), `payload.from.phone_number` (E.164), `payload.to[].phone_number`, `payload.text` (may be `null` for media-only MMS), `payload.type` `SMS`/`MMS`, `payload.media[]` with `url`, `content_type`, `sha256`, `size`. Answer 2xx **within 2 seconds**; up to 2 retries per URL ([receive message](https://developers.telnyx.com/docs/messaging/messages/receive-message)).
- **MMS files:** each media `url` needs `Authorization: Bearer <API key>` and expires after 30 days (same page). That fits the email seam's lazy `MailFile.read(maxBytes)`: download only after the sender is checked.
- **Signature:** `telnyx-signature-ed25519` (base64) over `{telnyx-timestamp}|{raw body}`, verified with the account public key; the SDK has `telnyx.webhooks.constructEvent(payload, signature, timestamp, publicKey)`. Hookdeck reports that pinned `telnyx@7` versions verify with Standard Webhooks headers and reject real Telnyx webhooks (**unverified**; a hand-rolled Ed25519 check with `node:crypto` needs no dependency).
- **Outbound:** `client.messages.send({ from, to, text })` in the Node SDK (same page); `POST /v2/messages` with `media_urls` for MMS (**unverified**: the page links to Send Message rather than listing fields). npm `telnyx` is at 7.29.0 (`pnpm view telnyx`, 2026-10-28). Plain `fetch` would do instead of the SDK.
- **10DLC (US long codes):** "US long codes without 10DLC registration will experience carrier filtering and potential message blocking" ([number configuration](https://developers.telnyx.com/docs/messaging/messages/phone-number-configuration/index), search excerpt); Telnyx says unregistered 10DLC traffic is blocked from February 2025 ([What is 10DLC](https://telnyx.com/resources/what-is-10dlc)). Fees: one-time $4 brand + $15 campaign vetting, the $15 only when the campaign goes to the aggregator ([Telnyx compliance guide](https://support.telnyx.com/en/articles/16256133-10dlc-campaign-compliance-guide), search excerpt). **Sole Proprietor** brands (an individual without an EIN) get 1 campaign, 1 number, low throughput, and need a mobile for OTP ([sole proprietor guide](https://support.telnyx.com/en/articles/13545282-guide-to-sole-proprietor-10dlc-brand-and-campaign-registration), search excerpt). Monthly campaign fees: **not found**. Toll-free numbers need separate toll-free verification (not opened). Whether trial texts to the verified number get through without 10DLC: **unverified**.
- **Fit with the Channel seam:** the same shape as email. A `SmsProvider` with `parseInbound(request)` and `send(sms)` behind a `{ id: "sms", provider, number }` adapter; `ChannelAdapter` becomes a union (#957 noted the same). `receive` checks the sender against the user's **verified phone number** (Better Auth has a phone-number plugin; not checked here) where email checks a verified address plus DMARC. SMS has no DMARC: sender IDs can be spoofed, so the reviewer should treat an SMS Message as weaker than a web Message (section 6.3). SendToUser text is "what every Channel can always show", so delivery needs no new format beyond splitting long text into parts; a Rich control's simplest SMS form is its text (a choice as numbered options is a design decision for the spec).

---

## 6. Design sketch: GPT-Live as the Bot's voice front end

### 6.1 Flow

```
caller ──PSTN──> Telnyx number ──SIP/TLS+SRTP──> sip.api.openai.com (GPT-Live)
                                                     │ webhook live.transport.incoming
                                                     ▼
                      Host: POST <basePath>/channels/phone/openai  (verify signature, dedupe)
                        1. look up whose number was dialled → user + Bot
                        2. check the caller (section 6.3); reject 486/603 if not the owner
                        3. accept { model: gpt-live-1, delegation: client, instructions: Bot's voice persona }
                        4. attach WebSocket (a "call session" process, see 6.4)
                                                     │
            session.input_transcript.delta ──────────┤ keep a rolling transcript
            session.delegation.created ──────────────┤
                        5. empty session.thinking.append (or let the auto-ack speak)
                        6. Trigger { source: "user", channel: "phone", id: delegation.id,
                                     text: recent caller transcript }
                           → Router → Conversation queue → Turn (Auto-review, Approvals as today)
                        7. SendToUser in that Turn → deliverIn → phone delivery:
                           session.commentary.append { delegation_id, content: Message text }
                        8. Turn ends quiet → session.commentary.append "done" or nothing (spec decides)
```

Each step maps onto what exists: a Trigger with a unique source ID (the `delegation.id`, so a duplicate is dropped by the Router), the Conversation queue, a Turn, SendToUser, and Channel delivery through `deliverIn`. The phone is one more Channel adapter and Trigger `channel` value (`"phone"`), and the call transcript is the Message text. The Bot never learns it's on a call except from the Channel label and a prompt note ("keep it short, it will be spoken").

The voice model only talks. It has no tools and can't act; anything it promises without a Bot reply is just talk. The accept-time instructions should say so ("never claim something was done unless the backend says so"), and the OpenAI guidance says the same ("Report success only after the backend confirms it").

### 6.2 Latency while the Bot works

- A Turn already "waits a moment before it starts so quick Messages land in one batch" (`CONTEXT.md`, Conversation queue). On a call that wait adds directly to dead air; the phone Channel probably wants it near zero.
- GPT-Live covers the gap itself: its automatic acknowledgment fires after `acknowledgement_delay_ms`; we can also send `session.thinking.append` ("Checking your calendar; nothing changed yet") so it can answer "still working" naturally.
- The Bot can send several Messages in one Turn; each becomes its own `commentary.append`, so "On it" → result works with no new mechanism.
- Interruption: in a 1:1 Conversation a new Message already interrupts the running Turn. A new delegation during a running Turn becomes a new Trigger, which ends the current Turn and starts one with its work in view. The OpenAI note that "interrupting … does not stop backend work" is then handled by our existing Turn rule. Stale replies from the interrupted Turn must not be spoken: what an interrupted Turn "already sent stays sent" in the thread, but the phone delivery should drop commentary for a superseded `delegation.id` (spec decision).
- Helpers keep going after the Turn; a Helper's report wakes the Bot as a Trigger, and if the call is still up its SendToUser goes to the call; if the call has ended it goes to the web thread (and maybe SMS). Delivery chooses by "is a call session live for this Conversation".
- Measured numbers: none. "Measure time to the first useful spoken answer on your own workload" (live delegation page).

### 6.3 Auto-review and Approvals

- **Unchanged path.** Every tool call is the Bot's, inside a Turn, so Auto-review sees it as today. The voice layer adds no tools, so there is nothing around the reviewer.
- **What counts as the user's word.** The reviewer takes "only the user's own Messages" as permission. A phone transcript is the user's words _only if the caller is the user_. Caller ID is spoofable and SHAKEN/STIR, if it even reaches us, attests the number, not the person. Options for the spec (not decided): (a) accept only the owner's verified number and label phone Messages "by phone, sender not verified" for the reviewer, as email labels forwards; (b) require a spoken PIN or a one-time code before the session gets delegation; (c) treat phone Messages like a webhook (never the user's word), which would make every risky action on a call need an Approval. Same question for SMS.
- **Transcription errors.** Transcripts "can contain errors and fragments" (OpenAI). The reviewer reading "delete the draft" when the user said "don't delete the draft" is a new risk; the reviewer prompt could get a "speech transcript, may be wrong" note.
- **Approvals on a call.** An Approval is a Rich control and waits at most 15 seconds. On a call its simplest form is a spoken question: the phone delivery sends `commentary.append` ("I need your OK to run X. Say yes or no."), and the caller's next utterance has to come back as the Approval answer, not a new Message. That needs mapping a delegation (or a yes/no in the transcript) to the pending Approval within 15 seconds, including GPT-Live's paraphrase and the caller's reaction time. Alternative: push the Approval to the web app or SMS and say "I sent you an approval". Spec decision; this is the hardest new piece.
- OpenAI's own rule matches ours: "Enforce permissions and required user confirmations in your application. Prompt text and instruction appends are not access controls."

### 6.4 Where the call session runs

The attach WebSocket lives for the whole call (up to the session's limit) and must be held by one process. The runner jobs are short and checkpointed; a call is neither. Options (spec decisions): a long-lived handler in the Host process started from the webhook (simplest for a lab, lost on restart, the call keeps going but we go deaf), or a dedicated worker. The Host already runs a WebSocket _server_ for Screens (`packages/botsdk/bot/src/http/screen-socket.ts`); this is a WebSocket _client_, so the code is new either way.

### 6.5 Fallback shape (Realtime SIP, `gpt-realtime-2.1`)

Same flow, but steps 5–7 become: the realtime model calls a `delegate_to_bot({ request })` function tool; its argument is the Trigger text (the model's paraphrase, not the caller's words, which is worse for the reviewer: pass the input transcript instead); the Bot's SendToUser text goes back as the `function_call_output` plus a response request. Several Messages in one Turn don't map onto one function result cleanly (later ones would need out-of-band conversation items, **unverified**).

---

## 7. Costs, trial and the Channel rule

### 7.1 Costs (US, pay as you go)

| Item                                                 | Price                                                                                   | Source                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Telnyx local number                                  | $1.00 / month                                                                           | [Call Control pricing](https://telnyx.com/pricing/call-control)             |
| Telnyx SIP trunking inbound local                    | from $0.0032 / min                                                                      | [Elastic SIP pricing](https://telnyx.com/pricing/elastic-sip)               |
| Telnyx SIP inbound channels                          | first 10: $12 / mo each (how this combines with per-minute billing is **unverified**)   | same                                                                        |
| Telnyx Voice API + media streaming (alternative 4.2) | $0.002 + $0.0035 / min                                                                  | [Call Control pricing](https://telnyx.com/pricing/call-control)             |
| GPT-Live 1                                           | $0.05 / session min, per second; backend extra                                          | [model page](https://developers.openai.com/api/docs/models/gpt-live-1.md)   |
| `gpt-realtime-2.1` (fallback)                        | $32 in / $64 out per 1M audio tokens                                                    | [OpenAI pricing](https://developers.openai.com/api/docs/pricing) (via #959) |
| The Bot's Turn                                       | the user's Bot Model, as any Turn                                                       | —                                                                           |
| Telnyx SMS 10DLC                                     | $0.004 / part out and in + carrier fee (AT&T $0.0035, T-Mobile and Verizon $0.0045 out) | [Messaging pricing](https://telnyx.com/pricing/messaging)                   |
| Telnyx MMS 10DLC                                     | $0.015 out / $0.005 in per part + carrier fee                                           | same                                                                        |
| 10DLC registration                                   | $4 brand + $15 campaign vetting, one-time; monthly not found                            | section 5                                                                   |

A 5-minute call ≈ $0.016 Telnyx + $0.25 GPT-Live + the Bot's model calls.

### 7.2 Trial

Telnyx **trial**: "USD $5 in testing credit"; 1 verified number (10 changes per lifetime); 1 local number from the account's country, reclaimed within 30 days unless upgraded; voice "Inbound limited to receiving from the verified phone number", outbound only to it, 10 minutes per call; messaging 1 profile, long code only, to and from the verified number, 100 per day; payment "Limited to credit cards" ([trial](https://developers.telnyx.com/docs/account-setup/levels-and-capabilities/trial.md)). A **pretrial** tier ($25 AI credit, no card) has no Call Control, 10 texts a day, and 1 US number ([pretrial](https://developers.telnyx.com/docs/account-setup/levels-and-capabilities/pretrial.md)); whether it allows an FQDN SIP Connection isn't stated.

For a lab where the owner calls and texts their own Bot from their own phone, the verified-number limit is not a problem: it is exactly the one number that should get through.

OpenAI: GPT-Live has no free tier; `gpt-realtime` neither (no free tier listed, **unverified**). OpenAI's paid usage is the cost floor of the phone Channel.

### 7.3 Channel-rule verdicts

| Rule             | SMS (Telnyx Messaging)                                                                                                                              | Phone (Telnyx SIP → GPT-Live)                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Official API     | yes                                                                                                                                                 | yes (Telnyx documents the exact OpenAI setup)                                                                                      |
| Free tier        | trial $5, verified number only; 10DLC fees before real use                                                                                          | Telnyx trial yes; **OpenAI no free tier**, GPT-Live access gated                                                                   |
| Locally testable | yes, with a public HTTPS tunnel for the webhook                                                                                                     | yes, with a tunnel for the OpenAI webhook (attach is outbound, no tunnel)                                                          |
| Verdict          | **Passes with caveats** (trial credit, 10DLC for anything beyond the owner's own number, unverified whether unregistered trial texts are delivered) | **Partial**: passes on Telnyx, fails "free tier" on OpenAI and depends on GPT-Live access; owner already chose it (#962 amendment) |

The tunnel is a new tool and an owner decision (#959 said the same for Twilio). The OpenAI project needs a webhook signing secret and storage enabled.

---

## 8. New dependencies and accounts (owner decisions, only listed)

- Telnyx account (trial, credit card), one number, a Messaging Profile, an FQDN SIP Connection; later 10DLC brand and campaign.
- OpenAI project with GPT-Live SIP access, a project webhook and signing secret, storage enabled.
- A tunnel for local webhooks (ngrok, cloudflared or similar).
- Optional npm: `telnyx` (7.29.0) for SMS; `openai` for webhook verification; `ws` if undici's `WebSocket` can't set the attach headers. Each can be replaced with `fetch` and `node:crypto` (Ed25519 and HMAC are built in).
- Optional: Better Auth phone-number plugin for a verified phone number (not checked).

---

## 9. Open questions for the Voice calls Wayfinder

1. **GPT-Live access:** can the owner's OpenAI project get GPT-Live SIP access (alpha header)? If not, build on Realtime SIP + `gpt-realtime-2.1` with a delegate tool (6.5), or wait?
2. **Caller trust:** which of 6.3 (a)/(b)/(c) for phone and SMS: verified number only, a spoken PIN, or "never the user's word"? Does the reviewer get a "spoken, may be mis-transcribed" note?
3. **Approvals on a call:** answer by voice within 15 seconds, push to web/SMS, or a longer wait for phone? (The map lists "approvals that wait" as its own gap.)
4. **Call session process:** a long-lived handler in the Host, or a worker? What happens to a live call on restart?
5. **What GPT-Live says while a Turn runs:** its automatic acknowledgment, our `thinking.append` progress, or both? Does the batching wait drop to zero on the phone Channel?
6. **Interrupted Turns on a call:** drop commentary for a superseded delegation?
7. **Who speaks first:** a greeting via `commentary.append` with `delegation_id: null`, or the Bot's own first Message? Can the Bot call the user (outbound needs org enablement and isn't in the Telnyx guide)?
8. **Delivery after hang-up:** where a Helper's later report goes (web thread only, or also SMS).
9. **SMS 10DLC:** register a Sole Proprietor brand now, or stay on the trial's verified-number loop? Owner's country: a non-US home country changes which number the trial gives and its rules (**not researched**).
10. **Voice and Memory/Knowledge:** transcripts are Messages, so Memory sees them; is the GPT-Live recording (stored 30 days at OpenAI) acceptable for a lab?

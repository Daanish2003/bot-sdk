# Live call facts

Research for issue #1072 (child of the map #979). Researched on 2026-10-30 against `main` at `1b6314dc`. Builds on `docs/research/telnyx-openai-realtime.md` (#964), which left these five facts **unverified**.

How to read the sources:

- **External sources.** OpenAI and Telnyx developer docs, fetched 2026-10-30 as Markdown (append `.md` to the page URL). Each claim links its page.
- **Local test.** One Node script run on the dev machine against a local HTTP server on `localhost`. Nothing was sent to OpenAI or Telnyx, and no call was placed.
- **Unverified.** Claims the docs don't state, or that only a real call would confirm, are marked **unverified**.

---

## Summary

1. **Caller number: yes, in `data.sip_headers`.** OpenAI passes the INVITE's headers through, minus SIP authorization headers, so `From` is there and `P-Asserted-Identity` is there whenever Telnyx sends it. Telnyx documents `verstat` in `P-Asserted-Identity` for inbound PSTN calls. That it survives the Telnyx → OpenAI leg end to end is **unverified** until a real call shows it.
2. **Node 24's global `WebSocket` can set the headers; `ws` is not needed.** Undici's constructor takes `{ headers }`, and a local test on Node v24.10.0 (undici 7.16.0) showed `Authorization` and `OpenAI-Alpha` reaching the server.
3. **`acknowledgement_delay_ms`: integer 0–800, default 0 for client delegation** (400 only for `decisions` sessions). **Sessions do expire:** `session.started` and `session.updated` carry `session.expires_at`, and `session.closed` gives `reason: "expired"` at "the session duration limit". The limit's length is not documented.
4. **DTMF: yes.** The sideband receives `transport.dtmf.received` with one key (`0`–`9`, `A`–`D`, `*`, `#`). It goes to sideband observers only, so our backend gets the key, not GPT-Live. We can also send tones with `transport.dtmf.send`.
5. **Greeting: yes, with two steps and no guarantee.** Put the greeting instructions in a `developer` message in `session.input` on the accept call, then after attaching send the same text once as `session.commentary.append` with `delegation_id: null`, keeping input audio running. For exact wording (say, a disclosure), use `session.instructions.append` instead. OpenAI says neither guarantees that the model speaks.

---

## 1. Caller number and STIR/SHAKEN

**What OpenAI sends.** The webhook reference for [`live.transport.incoming`](https://developers.openai.com/api/reference/resources/webhooks) defines `data.sip_headers` as "Headers from the SIP INVITE, excluding SIP authorization headers. Retained names, values, repeated entries, and order are preserved. Treat these values as untrusted call metadata." The examples show `From`, `To` and `Call-ID` ([voice SIP](https://developers.openai.com/api/docs/guides/voice-sip), [Telnyx GPT-Live guide](https://developers.telnyx.com/docs/voice/sip-trunking/gpt-live-configuration-guide.md), whose example is `{ "name": "From", "value": "sip:+15551234567@example.com" }`). The same schema also has `data.sip_media_security` (`rtp` / `srtp`).

- So the caller's number is in `From` (a SIP URI with the E.164 number as the user part). The Telnyx sample's `ALLOWED_CALLER_PREFIXES` admission check reads it, and the guide warns this "is a simple example admission check, not caller authentication" ([Telnyx GPT-Live guide](https://developers.telnyx.com/docs/voice/sip-trunking/gpt-live-configuration-guide.md)).
- Nothing lists `P-Asserted-Identity` by name. Going by the schema text, it is passed through if it is on the INVITE. "Retained names" hints that some headers may be dropped, and the docs don't say which, so this is **unverified**.

**What Telnyx sends.** "Telnyx provides call attestation information through the `verstat` parameter in the `P-Asserted-Identity` SIP header", for example `P-Asserted-Identity: "John Doe" <sip:+18889809750@sip.telnyx.com;verstat=TN-Validation-Passed>`. Values: `TN-Validation-Passed` (A), `TN-Validation-Passed-B`, `TN-Validation-Passed-C`, `TN-Validation-Failed` (invalid certificate), `No-TN-Validation` (no Identity header). It "is included for: Inbound calls from the PSTN; On-net calls between Telnyx customers" ([SIP header parameters](https://developers.telnyx.com/docs/voice/stir-shaken/sip-header-parameters.md)). The raw `Identity` JWT header is a separate opt-in ("Receive SHAKEN/STIR Identity SIP header") documented for IP connections ([hosted cert](https://developers.telnyx.com/docs/voice/stir-shaken/hosted-cert.md)); the OpenAI route uses an FQDN connection, so don't count on it.

**Verdict.** The two documented halves line up: Telnyx sets `verstat` on inbound PSTN calls, and OpenAI forwards the INVITE headers. No page shows a `P-Asserted-Identity` carrying `verstat` actually arriving in an OpenAI webhook, so that is **unverified**, and the first real test call should log `data.sip_headers`. Both sides call these headers untrusted metadata. Even an A attestation only says the carrier vouches for the number.

## 2. Node 24 `WebSocket` headers for the attach

The attach is `wss://api.openai.com/v1/live/sessions/{session_id}/attach`, sent with "the same project authentication and connection headers" ([voice SIP](https://developers.openai.com/api/docs/guides/voice-sip)): `Authorization: Bearer …` and, for the tested Telnyx setup, `OpenAI-Alpha: quicksilver=v3` ([Telnyx GPT-Live guide](https://developers.telnyx.com/docs/voice/sip-trunking/gpt-live-configuration-guide.md)).

- **Docs.** Undici's `new WebSocket(url[, protocol])` takes `protocol` as `string | string[] | WebSocketInit` ([undici WebSocket docs](https://github.com/nodejs/undici/blob/v7.16.0/docs/docs/api/WebSocket.md)). The type `WebSocketInit` is `{ protocols?, dispatcher?, headers?: HeadersInit }` (`node_modules/.pnpm/undici-types@8.9.0/node_modules/undici-types/websocket.d.ts`, line 147). `@types/node` 26.6.4 types the global as undici's unless a DOM lib provides one (`@types/node/web-globals/fetch.d.ts`, line 66). So a package whose tsconfig includes `lib: ["dom"]` gets the browser constructor type, which has no `headers`.
- **Local test.** On Node v24.10.0 (`process.versions.undici` = 7.16.0), a plain `http` server that completes the upgrade by hand logged the headers of `new WebSocket("ws://localhost:<port>/v1/live/sessions/x/attach", { headers: { Authorization: "Bearer test", "OpenAI-Alpha": "quicksilver=v3" } })`. It received `{"authorization":"Bearer test","openai-alpha":"quicksilver=v3"}`, and the socket opened. The script is a 20-line `node:http` + `node:crypto` file and wasn't kept.

**Verdict.** The global `WebSocket` is enough, and no new dependency is needed. Only the TypeScript type depends on the lib setting.

## 3. `acknowledgement_delay_ms` and the session limit

**`acknowledgement_delay_ms`** (on `session.delegation`, for each of `client`, `responses` and `decisions`), from the [sideband WebSocket reference](https://developers.openai.com/api/reference/resources/live/sideband-websocket):

> Milliseconds to wait before requesting an automatic spoken acknowledgement for a delegation. The model may still speak before this delay. Any commentary or thinking appended to the session cancels all pending acknowledgements, including those for other delegations. Defaults to 400 for Decisions sessions and 0 (request immediately) for other sessions. Omission in a session update preserves the current value. Updates apply to subsequent delegations.
> `minimum: 0`, `maximum: 800`

- With client delegation and no setting, the acknowledgment is requested **immediately**. To give the Bot time to send a `session.thinking.append` first, set it, up to 800 (the guide's example uses `800`) ([live delegation](https://developers.openai.com/api/docs/guides/live-delegation)).
- An empty or factual `session.thinking.append` ("Lookup in progress.") cancels the pending acknowledgment without asking the model to speak, and any append cancels **all** pending acknowledgments ([live delegation](https://developers.openai.com/api/docs/guides/live-delegation)).
- It can be changed mid-session with a session update, and the change applies to later delegations only.

**Session duration.** `session.closed.reason` includes `expired` "for the session duration limit" ([sideband reference](https://developers.openai.com/api/reference/resources/live/sideband-websocket); [live conversations](https://developers.openai.com/api/docs/guides/live-conversations): "The session reached its duration limit."). `session.started` and `session.updated` carry `session.expires_at`, "The Unix timestamp, in seconds, at which the Live session expires" (same reference). The limit's length is **not documented** in the guides, the model page or the pricing page ([gpt-live-1](https://developers.openai.com/api/docs/models/gpt-live-1.md), [latency and cost](https://developers.openai.com/api/docs/guides/voice-latency-cost)). The design should read `expires_at` and warn the caller before it, not hard-code a number. Whether the sideband receives `session.started` when it attaches after a SIP accept is **unverified** (the reference notes "attaching alone does not trigger" `session.updated`). Sending any `session.update` returns `session.updated` with `expires_at`.

## 4. Caller DTMF

From [voice SIP](https://developers.openai.com/api/docs/guides/voice-sip) ("Send and receive keypad events") and the [sideband reference](https://developers.openai.com/api/reference/resources/live/sideband-websocket):

- **In:** `transport.dtmf.received`, "A SIP DTMF keypress received from the caller. Delivered only to sideband observers." Payload `{ "type": "transport.dtmf.received", "event_id": "event_dtmf_1", "event": "5" }`; `event` matches `^[0-9A-D*#]$`, one key per event.
- **Out:** `transport.dtmf.send` with `event` (one key), "supported only for SIP calls"; success emits `transport.dtmf.sent` with `client_event_id`, failure an `error` with `error.client_event_id`.
- Because only sideband observers get it, GPT-Live itself doesn't react to keys. If a key should matter in the conversation, the Bot has to act on it and, if useful, tell the model through `session.thinking.append` or `commentary.append`. The docs don't say whether in-band DTMF tones in the audio reach the model as sound, so that is **unverified**.
- Telnyx's sample "does not implement … keypad-driven IVR navigation" ([Telnyx GPT-Live guide](https://developers.telnyx.com/docs/voice/sip-trunking/gpt-live-configuration-guide.md)), so the DTMF mode on the Telnyx FQDN connection (RFC 2833 vs SIP INFO) and whether it reaches OpenAI is **unverified**.

## 5. Greeting so GPT-Live speaks first

[Live conversations](https://developers.openai.com/api/docs/guides/live-conversations), "Greet before the caller speaks", repeated in [live delegation](https://developers.openai.com/api/docs/guides/live-delegation):

1. Put the greeting instructions in a `developer` message in `session.input` when creating the session. For SIP that is the **accept call**: its `session.input` takes up to 128 text-only developer, user or assistant messages, one text part each, with an 8,192 rendered-token default limit ([accept reference](https://developers.openai.com/api/reference/resources/live/subresources/sessions/methods/accept)). Example text: "Greet the caller now in English. Introduce yourself as the support assistant and ask how you can help. Then pause and listen."
2. After `session.started` (for SIP, after attaching the sideband), send the same text **once** as `session.commentary.append` with a unique `event_id` and `delegation_id: null`. Keep input audio running, including silence. On SIP the audio comes in over the trunk.
3. Check the output transcript: "Startup instructions can improve greeting behavior, but do not guarantee that the model will speak." `session.commentary.appended` "does not confirm that the greeting was spoken or played. GPT-Live may paraphrase the greeting, add words, or remain silent."

- **Exact wording:** "Use `session.instructions.append` to request specific spoken wording for a disclosure. `session.commentary.append` may paraphrase the text", e.g. "Immediately say the following disclosure exactly and in full before responding to the caller: …". For guaranteed wording, play a recording and use the playback controls ([voice server controls](https://developers.openai.com/api/docs/guides/voice-server-controls)).
- For SIP, don't send `session.start`. The Telnyx troubleshooting entry for "no greeting" says "Send `session.commentary.append` rather than `session.start`" ([Telnyx GPT-Live guide](https://developers.telnyx.com/docs/voice/sip-trunking/gpt-live-configuration-guide.md)). The plain `instructions` field on accept sets how GPT-Live behaves through the call, but on its own it isn't documented to make the model speak first.

**Verdict.** The accept call sets the greeting up through `session.input`, and a `commentary.append` after attaching triggers it. `instructions.append` is the tool for word-for-word lines. OpenAI says none of them guarantees speech.

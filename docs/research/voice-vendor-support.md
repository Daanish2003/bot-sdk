# What each voice vendor supports for a deployed Representative

Research for issue #1368 (route: #1367, map: #979). All sources were read on **2026-11-09**.

How to read the sources:

- **Vendor docs and pricing pages.** Each claim links its page. Most pages were read through a fetch tool that returns an extract, so quoted phrases are as that tool returned them.
- **Vapi's OpenAPI spec** (<https://api.vapi.ai/api-json>) and **Telnyx's call-control OpenAPI source** (<https://developers.telnyx.com/openapi/source/external/call-control/call-control.json>) were downloaded and read directly.
- **(search excerpt)** means the claim comes from a search result's excerpt of that URL, and the page itself wasn't opened.
- **Unverified** means no primary source confirmed it. Nothing here was tested with a real call.

The shape being checked: the vendor holds the call and runs the model. We expose call start, voice tools and call end, and the user pastes our URLs and a secret into the vendor's console. We store no vendor API key.

---

## Recommendation

**Use Vapi for the first real test call.**

- It is the only hosted vendor where the docs cover all of these together: a free number "without a saved payment method", free credit, and a call-start webhook that can return the whole prompt and greeting. Sources are in the Vapi section.
- A static header can be set from the console on the number's Server URL panel, so no vendor API key is needed.
- Its one free number is US-only and inbound-only, which is all a first test needs.

Log the whole `assistant-request` body on that first call. The caller's number field is the main thing that call must settle, because Vapi's docs disagree with its spec.

Why not the others first:

| Vendor     | What rules it out for the first call                                                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retell     | The hooks are the best documented, including a real pre-answer reject. But buying a number needs a payment method, and webhook signatures are keyed with the user's Retell API key. **It is the strongest option once a card is acceptable**, if a secret in the URL is acceptable too. |
| Telnyx     | No card on a pretrial account, but Telnyx's own pages disagree on whether pretrial can create AI Assistants. Inbound is limited to the verified number. The webhook fills variables and is not documented as replacing the prompt.                                                      |
| ElevenLabs | No phone number is documented for ElevenAgents, so it needs a Twilio or SIP number from elsewhere.                                                                                                                                                                                      |
| Bland      | No call-start webhook. Docs conflict on whether a free account can take inbound calls.                                                                                                                                                                                                  |
| LiveKit    | No card and a free number, but the user has to write and deploy an agent. That is a different product shape from pasting URLs.                                                                                                                                                          |

---

## Summary

|                                 | Vapi                                     | Retell                             | ElevenLabs                                   | Bland                                        | Telnyx                                                | LiveKit (user's code)               |
| ------------------------------- | ---------------------------------------- | ---------------------------------- | -------------------------------------------- | -------------------------------------------- | ----------------------------------------------------- | ----------------------------------- |
| 1. Prompt and greeting per call | Yes                                      | Yes                                | Yes, once enabled                            | No webhook; variables through `dynamic_data` | Variables only                                        | Yes, in code                        |
| Start deadline                  | 7.5 s                                    | 10 s per attempt, 3 attempts       | Not documented                               | 2 s default per request                      | 1.5 s default, 10 s max                               | The user's own                      |
| Caller number                   | `customer.number` (spec); docs conflict  | `call_inbound.from_number`         | `caller_id`                                  | `{{phone_number}}` / `{{from}}`              | `telnyx_end_user_target`                              | `sip.phoneNumber`                   |
| Vendor numbers / SIP            | Yes / **unverified** on trunks           | Yes / yes                          | Twilio / yes                                 | **unverified** per-call on SIP               | Yes / **unverified**                                  | Yes / yes                           |
| 2. Decline before answering     | Speaks an error, so not a silent decline | `reject: true`, before setup       | Not documented                               | Static block list                            | `<Reject>` on TeXML; **unverified** with an assistant | Static number lists                 |
| Declined call billed            | **unverified**                           | **unverified**                     | **unverified**                               | **unverified**                               | No, for first-verb `<Reject>`                         | **unverified**                      |
| 3. Tools                        | Yes                                      | Yes                                | Yes                                          | Yes                                          | Yes                                                   | Yes, in code                        |
| 4. Full transcript webhook      | Yes; no retry by default                 | Yes; retried                       | Yes; retries opt-in                          | Yes; retry details undocumented              | Yes (`messages`); retries undocumented                | The agent's code posts it           |
| 5. Secret from console alone    | Yes (header)                             | URL token only; HMAC needs API key | Yes (header on start and tools, HMAC on end) | Partly                                       | Partly                                                | Not applicable: env var in the code |
| 6. Keypad reaches us            | In transcript                            | In transcript                      | In transcript                                | **unverified**                               | Via WebSocket events                                  | In the code                         |
| Max call length                 | Yes                                      | Yes                                | Yes                                          | Yes                                          | Yes                                                   | Yes                                 |
| 7. Number without a card        | Yes (1, with a caveat)                   | No                                 | None documented                              | Conflicting                                  | Yes on pretrial, with conflict                        | Yes (1)                             |
| Price per minute (see section)  | $0.05 + providers                        | $0.055 + TTS, LLM, telephony       | $0.08 + LLM                                  | $0.14 + telephony                            | $0.05 + LLM, about $0.06                              | Example total about $0.048          |

---

## Vapi

**1. Call start.**

- **Mechanism:** an `assistant-request` POST. The response can be `{assistantId}`, a whole transient `{assistant}`, `assistantOverrides`, a `{destination}` transfer or `{error}` ([events](https://docs.vapi.ai/server-url/events), [OpenAPI `ServerMessageResponseAssistantRequest`](https://api.vapi.ai/api-json)). `AssistantOverrides` has `firstMessage` and `variableValues` ([OpenAPI](https://api.vapi.ai/api-json)).
- **Deadline:** "You must respond to the assistant-request webhook within 7.5 seconds end-to-end." The dashboard timeout doesn't apply ([events](https://docs.vapi.ai/server-url/events)).
- **Caller number, with a conflict between sources:**
  - The spec types `customer` on the message and on `call` as `CreateCustomerDTO`, whose `number` is "the number of the customer". So the paths are `message.customer.number` and `message.call.customer.number` ([OpenAPI](https://api.vapi.ai/api-json)).
  - The spam-rejection guide reads `req.body?.call?.from?.phoneNumber` ([spam rejection](https://docs.vapi.ai/server-url/spam-call-rejection)).
  - **Unverified** which one a real inbound call carries. The spec is the more authoritative, so try it first.
- **Vapi numbers:** a phone number with `assistantId` null and a `serverUrl` gets `assistant-request` on each call. The SIP page documents this for Vapi SIP numbers ([SIP](https://docs.vapi.ai/advanced/sip)). The number's Server URL panel is in the dashboard ([setting server URLs](https://docs.vapi.ai/server-url/setting-server-urls)).
- **SIP-trunked numbers:** **unverified**. The trunking page doesn't mention `assistant-request` or the caller's number ([SIP trunk](https://docs.vapi.ai/advanced/sip/sip-trunk)). The spec has `customer.sipUri` ([OpenAPI](https://api.vapi.ai/api-json)), so a SIP caller may have a URI rather than a number.

**2. Declining.** Return `{ "error": "..." }`. The spec says: "This is the error if the call shouldn't be accepted. This is spoken to the customer" ([OpenAPI](https://api.vapi.ai/api-json)). The guide says it is spoken "and end the call" ([spam rejection](https://docs.vapi.ai/server-url/spam-call-rejection)). Because the error is spoken, this isn't a decline before answering. The end reason is `assistant-request-returned-error` ([end reasons](https://docs.vapi.ai/calls/call-ended-reason)). Billing is **unverified**: that page only says `vapifault` calls are typically not charged.

**3. Tools.**

- **Mechanism:** a `tool-calls` POST, answered with a `results` array of `toolCallId` plus a flat-string `result` or `error`, always HTTP 200 ([custom tools](https://docs.vapi.ai/tools/custom-tools)).
- **Timeout:** default 20 s, range 1 to 300 s ([OpenAPI `Server`](https://api.vapi.ai/api-json)). Settable in the tool editor ([custom tools](https://docs.vapi.ai/tools/custom-tools)).
- **Auth:** credentials, or `server.headers` ([authentication](https://docs.vapi.ai/server-url/server-authentication), [OpenAPI](https://api.vapi.ai/api-json)).
- **While waiting:** `request-start` plays, and if none is set one of the default fillers such as "Hold on a sec" is used. `request-response-delayed` plays after 100 to 120,000 ms ([OpenAPI `ToolMessageStart` / `ToolMessageDelayed`](https://api.vapi.ai/api-json)).

**4. Call end.**

- `end-of-call-report` is in the default `serverMessages` ([OpenAPI](https://api.vapi.ai/api-json)).
- It carries `artifact.transcript` (a string), `artifact.messages` (an array), `endedReason`, `cost`, `startedAt`, `endedAt` and `call`. The call id is `call.id` ([OpenAPI](https://api.vapi.ai/api-json)).
- **Retries:** `Server.backoffPlan` defaults to "the request will not be retried", with `maxRetries` up to 10 ([OpenAPI](https://api.vapi.ai/api-json)). So the transcript gets one attempt unless a plan is set. **Unverified** whether the dashboard exposes `backoffPlan`.

**5. Per-account secret.**

- The dashboard's phone-number Server URL panel has HTTP Headers and an Authorization credential ([setting server URLs](https://docs.vapi.ai/server-url/setting-server-urls)).
- Credential types are Bearer Token with a custom header name, OAuth 2.0 and HMAC with a chosen secret, algorithm and signature header ([authentication](https://docs.vapi.ai/server-url/server-authentication)).
- Console-only works, and needs no Vapi API key.
- **Watch for:** Vapi withholds org credentials when the server URL came from an API request's inline assistant. The rule "does not apply to a saved assistant, phone number, tool" ([authentication](https://docs.vapi.ai/server-url/server-authentication)). The page doesn't mention transient assistants returned from `assistant-request`. So a returned assistant should carry its own `server.headers`. That this is delivered is **unverified**.

**6. Keypad and length.**

- `keypadInputPlan` is off by default ([OpenAPI](https://api.vapi.ai/api-json)). When on, digits become a user message such as `User's Keypad Entry: 1234` and are kept in the transcript ([keypad](https://docs.vapi.ai/documentation/assistants/conversation-behavior/keypad-input-settings)). No server message type is dedicated to keypad input ([OpenAPI `serverMessages`](https://api.vapi.ai/api-json)).
- `maxDurationSeconds`: default 600, range 10 to 43,200, dashboard under Advanced ([timeouts](https://docs.vapi.ai/documentation/assistants/conversation-behavior/call-timeout-settings)).

**7. Cost.**

- $5 free credits and $0.05/min hosting plus provider costs, four concurrent calls and one number on the no-package tier ([pricing](https://vapi.ai/pricing)).
- One free US number "which you can create without a saved payment method", inbound only. The same page warns that the Dashboard may show "Payment method required" ([free telephony](https://docs.vapi.ai/free-telephony)).
- Whether signing up needs a card: **unverified** (the pricing page is silent).

---

## Retell

**1. Call start.**

- The inbound webhook is set per number in the dashboard, in the Inbound Webhook URL field. It receives `call_inbound` with `call_id`, `agent_id`, `agent_version`, `from_number`, `to_number` and optional `custom_sip_headers` ([inbound webhook](https://docs.retellai.com/features/inbound-call-webhook)). The caller is `call_inbound.from_number`.
- The response can hold `override_agent_id`, `agent_override`, `dynamic_variables` and `metadata`. The greeting is `begin_message` inside the `retell_llm` or `conversation_flow` group ([inbound webhook](https://docs.retellai.com/features/inbound-call-webhook)). The page's example doesn't show `general_prompt`, so overriding the prompt field by name is **unverified**, though dynamic variables can fill it.
- **Deadline:** 10 s per attempt, 3 attempts in total. The call keeps ringing while it waits. After all fail, the number's inbound agent answers, or the call disconnects ([inbound webhook](https://docs.retellai.com/features/inbound-call-webhook)).
- **Numbers:** purchased and imported numbers are covered, with SIP headers exposed. Dial-to-SIP-URI calls are not ([inbound webhook](https://docs.retellai.com/features/inbound-call-webhook)).

**2. Declining.** Return `{"call_inbound": {"reject": true}}`. Only boolean `true` works. "Calls are hung up before any agent setup, and no call object is created" ([inbound webhook](https://docs.retellai.com/features/inbound-call-webhook)). Billing isn't stated, so it is **unverified**, though no call object suggests no charge.

**3. Tools** ([custom function](https://docs.retellai.com/build/single-multi-prompt/custom-function)).

- Any of GET, POST, PUT, PATCH or DELETE, with static or variable custom headers, set in the dashboard.
- Timeout default 120,000 ms, range 1,000 to 600,000.
- While waiting: Talk While Waiting (generated or static), or a typing sound.
- `max_retry` 0 to 5, default 0. Result capped at 15,000 characters. Requests are signed with `X-Retell-Signature`.

**4. Call end.**

- The `call_ended` event POSTs `event` and `call`, including `transcript`, `transcript_object` and `transcript_with_tool_calls`. The id is `call.call_id` ([webhook overview](https://docs.retellai.com/features/webhook-overview)).
- Timeout is 10 s. Without a 2xx, Retell retries "up to 3 times" ([webhook overview](https://docs.retellai.com/features/webhook-overview)). The inbound webhook is "3 total attempts" ([inbound webhook](https://docs.retellai.com/features/inbound-call-webhook)), so treat the two counts as different.

**5. Per-account secret.**

- HMAC-SHA256 over raw body plus timestamp, keyed with the API key that has the webhook badge, in `X-Retell-Signature: v={timestamp},d={hex}` ([secure webhook](https://docs.retellai.com/features/secure-webhook)).
- **This clashes with not storing a vendor key.** All keys have "the same permission level", and the page doesn't describe restricting one ([API keys](https://docs.retellai.com/accounts/api-keys-overview)).
- No custom headers are documented for webhooks ([webhook overview](https://docs.retellai.com/features/webhook-overview)). The console-only route is a token in the URL: webhook URLs accept query strings ([register webhook](https://docs.retellai.com/features/register-webhook)). Retell doesn't present that as a security feature, and whether the inbound URL field behaves the same is **unverified**.
- Tools can use a static header ([custom function](https://docs.retellai.com/build/single-multi-prompt/custom-function)).

**6. Keypad and length.**

- `allow_user_dtmf` defaults to true ([create agent](https://docs.retellai.com/api-references/create-agent)). Digits appear in the transcript. The docs don't say a webhook carries them separately ([DTMF](https://docs.retellai.com/build/user-dtmf)).
- `max_call_duration_ms`: default 3,600,000, range 60,000 to 7,200,000 ([create agent](https://docs.retellai.com/api-references/create-agent)).

**7. Cost.**

- "$10 in free trial credits, no payment method required", but "You'll only need to add one if you want to purchase a phone number" ([quick start](https://docs.retellai.com/get-started/quick-start)). "You must add a payment method" to buy one ([purchase](https://docs.retellai.com/deploy/purchase-number)).
- US number $2/month. $0.055/min voice infra, TTS from $0.015, LLM by model, US telephony $0.015; 20 concurrent calls free ([pricing](https://www.retellai.com/pricing)).
- A community thread reports inbound calls needing prepaid credit (search excerpt, [thread](https://community.retellai.com/t/credit-balance-exhausted-please-top-up-to-continue/3579)).

---

## ElevenLabs Agents

**1. Call start.**

- **SIP is supported, which resolves the ticket's open question.** "The webhook runs for a new inbound conversation on Twilio voice, Exotel, SIP trunk, WhatsApp, or Twilio SMS" ([personalization](https://elevenlabs.io/docs/eleven-agents/customization/personalization.md)).
- Payload: `caller_id`, `called_number`, `agent_id`, `conversation_id`, `call_sid`, and on SIP possibly `call_id` and `sip_headers` ([personalization](https://elevenlabs.io/docs/eleven-agents/customization/personalization.md)).
- Response: `conversation_initiation_client_data` with `dynamic_variables` and `conversation_config_override`, up to 256 KB ([personalization](https://elevenlabs.io/docs/eleven-agents/customization/personalization.md)). System prompt and first message can be overridden, but overrides are off by default and enabled in the Security tab ([overrides](https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides.md)).
- **Deadline:** not documented. "A failed or timed-out webhook can prevent the conversation from starting" ([personalization](https://elevenlabs.io/docs/eleven-agents/customization/personalization.md)).
- **Nuance on SIP caller id:** the SIP page says to include `X-CALL-ID` and `X-CALLER-ID` headers ([SIP trunking](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking.md)). The personalization page simply says `caller_id` is a phone number on SIP. **Unverified** whether `caller_id` is filled when a carrier doesn't send `X-CALLER-ID`.

**2. Declining.** No per-call decline is documented. The SIP trunk's Allowed Numbers is a static list ([SIP trunking](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking.md)). Failing the webhook may stop the call, but that is a side effect and not a documented decline. Billing is **unverified**.

**3. Tools.**

- Webhook tools support OAuth2, Basic, Bearer and custom headers, with secrets stored in ElevenLabs ([webhook tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools.md)).
- `response_timeout_secs`: default 20, range 5 to 300 ([create tool](https://elevenlabs.io/docs/eleven-agents/api-reference/tools/create.md)).
- While waiting: `pre_tool_speech` (`auto`, `force` or `off`, default `auto`) ([create tool](https://elevenlabs.io/docs/eleven-agents/api-reference/tools/create.md)), and optional tool call sounds ([tools](https://elevenlabs.io/docs/eleven-agents/customization/tools.md)).

**4. Call end.**

- `post_call_transcription`: top-level `type`, `event_timestamp` and `data`; `data.conversation_id`; `data.transcript[]` with `role`, `message`, `tool_calls`, `tool_results`, `time_in_call_secs` ([post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks.md)).
- **Retries are off by default.** When enabled: up to 5, immediate then 30 s, 2 min, 8 min and 30 min. Retries cover 5xx, 429, 408 and connection errors. Auto-disabled after 10+ consecutive failures when the last success was over 7 days ago or never ([webhooks](https://elevenlabs.io/docs/eleven-api/resources/webhooks.md)).

**5. Per-account secret.**

- **Start:** header secrets are chosen in Agents settings ([Twilio personalization](https://elevenlabs.io/docs/eleven-agents/customization/personalization/twilio-personalization.md)). Whether this webhook is also HMAC-signed is **unverified**.
- **Tools:** secret headers ([webhook tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools.md)).
- **End:** HMAC in `ElevenLabs-Signature`, with a secret generated when the webhook is created ([webhooks](https://elevenlabs.io/docs/eleven-api/resources/webhooks.md)). So the user pastes ElevenLabs' webhook secret into us. It isn't an API key, but it is the reverse of the direction we planned. Custom headers on post-call webhooks are SDK or API only ([post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks.md)).
- Webhooks can be created from the settings page ([webhooks](https://elevenlabs.io/docs/eleven-api/resources/webhooks.md)), though the console steps aren't documented.

**6. Keypad and length.**

- DTMF input works for out-of-band tones from Twilio, SIP trunking or Genesys. Digits arrive as one user turn and are in the stored transcript. Sending them to a webhook separately isn't described ([multimodal input](https://elevenlabs.io/docs/eleven-agents/customization/multimodal-input.md)).
- `max_duration_seconds`: default 600, range 60 to 7,200, Advanced tab ([conversation flow](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow.md)).

**7. Cost.**

- Free plan has 15 minutes and 4 concurrent calls. $0.08/min, LLM billed separately, telephony included but external carriers bill directly ([pricing](https://elevenlabs.io/pricing/agents)).
- Card for the free plan: **unverified**.
- No number is documented for ElevenAgents. The native route needs a purchased Twilio number ([Twilio](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/native-integration.md)). The terms mention platform numbers "subject to the allowances" of a plan (search excerpt, [terms](https://elevenlabs.io/agents-terms)); no free allowance was found, so it is **unverified**.

---

## Bland

**1. Call start.**

- **No call-start webhook is documented**, and the docs index has no pre-call page ([llms.txt](https://docs.bland.ai/llms.txt)). `webhook` on an inbound number fires when the call ends ([update inbound](https://docs.bland.ai/api-v1/post/inbound-number-update.md)).
- The nearest thing is `dynamic_data`, requests that run "at the start and throughout your phone call". It has `headers` and a `timeout` defaulting to 2,000 ms, and extracts variables for the prompt ([dynamic data](https://docs.bland.ai/tutorials/dynamic-data.md)).
- `prompt` and `first_sentence` are stored on the number ([update inbound](https://docs.bland.ai/api-v1/post/inbound-number-update.md)). A whole prompt from a response isn't addressed ([dynamic data](https://docs.bland.ai/tutorials/dynamic-data.md)). **Unverified:** whether it finishes before the first sentence, and what happens on failure.
- **Caller number:** system variables `{{phone_number}}` and `{{from}}` ([dynamic data](https://docs.bland.ai/tutorials/dynamic-data.md)).
- **SIP:** SIP numbers are configured like other inbound numbers, with no caller-number detail ([SIP](https://docs.bland.ai/agents/sip.md)). Per-call variables through a session token need an API call ([inbound session](https://docs.bland.ai/api-v1/post/inbound-session.md)), which needs a Bland API key. That is out for us.
- **Console:** a number's Call configuration lists "dynamic data" without detail ([dispatch](https://docs.bland.ai/agents/dispatch.md)). **Unverified** that it can be set fully from the console.

**2. Declining.** Only a static block list, per number or global. A webhook isn't mentioned as deciding it, and billing isn't stated ([blocked numbers](https://docs.bland.ai/tutorials/blocked-numbers.md)). Failed calls on Bland's telephony have a $0.015 minimum ([billing](https://docs.bland.ai/platform/billing.md)); whether a blocked call counts is **unverified**.

**3. Tools** ([custom API](https://docs.bland.ai/tutorials/tools/custom-api.md), [agent tools](https://docs.bland.ai/agents/tools.md)). Webhook tools support GET and POST only. API-key auth from stored secrets, plus custom headers. Timeout 1,000 to 60,000 ms, and "a tool left empty still gets 4 seconds". Agent speech is "What the agent says while the tool runs".

**4. Call end.** Webhook with `call_id` (also `c_id`), `transcripts[]` (`id`, `user`, `text`, `created_at`) and `concatenated_transcript`. Failures "will trigger automatic retries based on the response code"; counts and timing aren't given. Set per number in the dashboard ([post-call webhooks](https://docs.bland.ai/tutorials/post-call-webhooks.md)).

**5. Per-account secret.** HMAC-SHA256 hex in `X-Webhook-Signature`, with an account secret from the Dev Portal's Keys tab ("Replace Secret"), shown once ([signing](https://docs.bland.ai/tutorials/webhook-signing.md)). It isn't the API key, but the user would paste it to us. Custom headers on the post-call webhook aren't mentioned ([signing](https://docs.bland.ai/tutorials/webhook-signing.md)). `dynamic_data` carries `headers` ([dynamic data](https://docs.bland.ai/tutorials/dynamic-data.md)), and tools use stored secrets ([custom API](https://docs.bland.ai/tutorials/tools/custom-api.md)).

**6. Keypad and length.**

- `ignore_button_press` exists on inbound numbers, default false (search excerpt, [update inbound](https://docs.bland.ai/api-v1/post/inbound-number-update)). How a caller's digits reach an agent or our side is **unverified**.
- `max_duration`: default 30 minutes ([update inbound](https://docs.bland.ai/api-v1/post/inbound-number-update.md)), at most 12 hours ([send call](https://docs.bland.ai/api-v1/post/calls.md)); agent-level on the Calls tab ([dispatch](https://docs.bland.ai/agents/dispatch.md)).

**7. Cost, with conflicts between Bland's own pages.**

- Start plan: "2 credits + an inbound number ($15/mo value)", "No card required", $0.14/min ([pricing](https://www.bland.ai/pricing)). Telephony is billed separately ([pricing](https://www.bland.ai/pricing)).
- "2 credits" isn't defined. **Unverified.**
- Buying a number is "$15/mo. subscription using your stored payment method" ([purchase](https://docs.bland.ai/api-v1/post/inbound-purchase.md)).
- Another page's free try "covers outbound calls only... no incoming calls" ([AI phone number](https://www.bland.ai/ai-phone-number)). It may describe a separate product, so whether the Start number takes inbound without a card is **unverified**.

---

## Telnyx AI Assistants

**1. Call start.**

- `dynamic_variables_webhook_url` receives `assistant.initialization` with `data.payload.telnyx_end_user_target` (the caller), `telnyx_agent_target`, `telnyx_conversation_channel`, `call_control_id` and `assistant_id` ([dynamic variables](https://developers.telnyx.com/docs/inference/ai-assistants/dynamic-variables)).
- Timeout: default 1.5 s, up to 10 s; on timeout the call "proceeds with default values" ([create assistant](https://developers.telnyx.com/api-reference/assistants/create-an-assistant.md)).
- The response fills `{{variable}}` placeholders, which may appear in instructions and greeting ([dynamic variables](https://developers.telnyx.com/docs/inference/ai-assistants/dynamic-variables)). A variable holding the whole prompt is **unverified**.
- SIP-trunked numbers firing this webhook: **unverified**.

**2. Declining.** TeXML `<Reject>` as the first verb "will prevent the call from being answered" and "will incur no cost" ([Reject](https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/reject.md)). The dynamic-variables response has no reject field ([dynamic variables](https://developers.telnyx.com/docs/inference/ai-assistants/dynamic-variables)). Using `<Reject>` with a number assigned to an assistant is **unverified**. Ringing and failed attempts aren't charged ([pricing](https://telnyx.com/pricing/voice-ai-agents)).

**3. Tools.**

- Webhook tools have `url`, `method`, `headers`, `timeout_ms`, `async` ([create assistant](https://developers.telnyx.com/api-reference/assistants/create-an-assistant.md)). The `timeout_ms` default is **unverified**.
- Headers can use integration secrets in the Portal ([quickstart](https://developers.telnyx.com/docs/inference/ai-assistants/no-code-voice-assistant.md), [preset parameters](https://developers.telnyx.com/docs/inference/ai-assistants/preset-webhook-parameters.md)).
- While waiting: `request_start` and `request_response_delayed` fillers (100 to 120,000 ms), on sync tools only ([filler messages](https://developers.telnyx.com/docs/inference/ai-assistants/filler-messages.md)).

**4. Call end.**

- `call.conversation.ended` has `payload.messages`: "The conversation transcript, in order", user and assistant by default, with tools when `telephony_settings.conversation_ended_full_history` is true. "Redacted when data retention is disabled." Ids: `conversation_id`, `call_control_id`, `call_session_id`, and also `reason`, `duration_sec` ([OpenAPI source](https://developers.telnyx.com/openapi/source/external/call-control/call-control.json)).
- The insights webhook carries no transcript ([insight groups](https://developers.telnyx.com/docs/inference/ai-insights/insight-groups.md)).
- **Retries:** "Product-specific policies determine retry timing", and none was found for this event ([receiving webhooks](https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks.md)).
- Where the URL is set for a Portal-assigned number is **unverified**. A search excerpt says the Voice API application's URL.

**5. Per-account secret.** Ed25519 in `telnyx-signature-ed25519` and `telnyx-timestamp`, using the account's key pair ([receiving webhooks](https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks.md)); the dynamic-variables webhook is signed too ([dynamic variables](https://developers.telnyx.com/docs/inference/ai-assistants/dynamic-variables)). The user pastes a **public key**, so no vendor secret is held at all. That is the cleanest fit, but it needs per-account key storage. Custom headers on the start webhook are **unverified**.

**6. Keypad and length.**

- Inbound DTMF is on by default, and `disable_dtmf` turns it off ([quickstart](https://developers.telnyx.com/docs/inference/ai-assistants/no-code-voice-assistant.md)).
- `telnyx.call.dtmf.received` arrives on the conversation event WebSocket ([event stream](https://developers.telnyx.com/docs/inference/ai-assistants/conversation-event-stream.md)), which is outside our three HTTP hooks.
- `telephony_settings.time_limit_secs` is the maximum ([create assistant](https://developers.telnyx.com/api-reference/assistants/create-an-assistant.md)).

**7. Cost, with a conflict between Telnyx's own pages.**

- Pretrial needs no payment method: $25 AI credit and one US local number ([pretrial](https://developers.telnyx.com/docs/account-setup/levels-and-capabilities/pretrial.md), [support](https://support.telnyx.com/en/articles/14327893-telnyx-pretrial-accounts)).
- **Conflict:** the developer page says "AI Assistant creation and Inference require a Trial account or higher" ([pretrial](https://developers.telnyx.com/docs/account-setup/levels-and-capabilities/pretrial.md)). The support article says full access including AI Assistants, but also that Voice isn't available ([support](https://support.telnyx.com/en/articles/14327893-telnyx-pretrial-accounts)). **Unverified** which is current.
- Limits: inbound only from the verified number, 10 minutes per call, number reclaimed within 30 days without an upgrade ([pretrial](https://developers.telnyx.com/docs/account-setup/levels-and-capabilities/pretrial.md)).
- $0.05/min voice engine, about $0.06 all-in, billed in 60-second increments; US number $1/month ([voice AI pricing](https://telnyx.com/pricing/voice-ai-agents), [pricing](https://telnyx.com/pricing/conversational-ai)).

---

## LiveKit (code the user runs)

**What differs.** LiveKit has no console where a model runs from a pasted URL. The user writes or deploys an agent, and our three hooks become HTTP calls in that code. The secret is an environment variable there. The model and speech run on the user's providers or on LiveKit Inference credit ([pricing](https://livekit.com/pricing)).

**1. Call start.**

- A dispatch rule puts the caller in a room and dispatches the agent, with optional `metadata` ([dispatch rule](https://docs.livekit.io/telephony/accepting-calls/dispatch-rule.md)).
- The agent reads `sip.phoneNumber` for the caller, unless `hide_phone_number` is set ([SIP participant](https://docs.livekit.io/reference/telephony/sip-participant.md)).
- The deadline is ours. The caller hears ringing until a participant publishes tracks ([workflow](https://docs.livekit.io/telephony/accepting-calls/workflow-setup.md)), bounded by the trunk's `ringing_timeout` ([inbound trunk](https://docs.livekit.io/telephony/accepting-calls/inbound-trunk.md)).
- Works on LiveKit numbers and on third-party SIP trunks ([phone numbers](https://docs.livekit.io/telephony/start/phone-numbers.md), [trunk setup](https://docs.livekit.io/telephony/start/sip-trunk-setup.md)).

**2. Declining.** Static only: trunk `allowed_numbers`, or dispatch rule `inbound_numbers`, where "the call is rejected" ([SIP API](https://docs.livekit.io/reference/telephony/sip-api.md)). A dynamic decline from the agent would use `delete_room` ([workflow](https://docs.livekit.io/telephony/accepting-calls/workflow-setup.md)); whether that happens before answer is **unverified**. Billing is **unverified**.

**3. Tools.** Function tools in code make any HTTP call, with any auth. There is no built-in timeout: "Set explicit timeouts on your HTTP requests". Hold messages through `session.say`, or a pre-synthesized message ([tool definition](https://docs.livekit.io/agents/logic/tools/definition.md)), or thinking sounds ([external data](https://docs.livekit.io/agents/logic/external-data.md)).

**4. Call end.** The agent builds a session report in `on_session_end` or a shutdown callback, with history included ([data hooks](https://docs.livekit.io/testing/observability/data/)), and posts it to us. Retry is our own code's job. LiveKit's own `room_finished` webhook has no transcript as far as was read, and delivery is best-effort (search excerpt, [webhooks](https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/)).

**5. Per-account secret.** Whatever our template sends, from an environment variable on the user's deployment. No console step applies.

**6. Keypad and length.** `sip_dtmf_received` room event ([DTMF](https://docs.livekit.io/telephony/features/dtmf.md)). `max_call_duration` on the inbound trunk ([SIP API](https://docs.livekit.io/reference/telephony/sip-api.md)).

**7. Cost.** Build plan: "No credit card required", 1,000 agent session minutes, one free US local number, 50 US inbound minutes, $2.50 inference credit, 5 concurrent sessions. The calculator example totals $0.0479/min ([pricing](https://livekit.com/pricing)). Numbers are US-only and inbound-only ([phone numbers](https://docs.livekit.io/telephony/start/phone-numbers.md)).

---

## Most important unverified items

1. **Vapi's caller-number field on a real call:** `customer.number` (spec) or `call.from.phoneNumber` (guide). The first test call settles it.
2. **Whether a declined call is billed** on Vapi, Retell, ElevenLabs, Bland and LiveKit. Only Telnyx's first-verb `<Reject>` is documented as free, and its use with an assistant is unverified.
3. **Whether `server.headers` in a transient assistant returned from Vapi's `assistant-request` is delivered**, given the withheld-credentials rule.
4. **Vapi's call start on SIP-trunked numbers**, and the caller's number there.
5. **ElevenLabs' start-webhook deadline**, and `caller_id` on SIP without `X-CALLER-ID`.
6. **Telnyx pretrial:** whether AI Assistants and inbound calls work at all.
7. **Bland Start:** whether the free number takes inbound calls, and whether `dynamic_data` lands before the greeting.
8. **Retell:** a Retell API key is the only documented way to verify webhook signatures.

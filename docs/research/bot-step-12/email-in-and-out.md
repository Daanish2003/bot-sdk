# Email in and out for a local-only Host

Research for issue #749 (step 12, Channels). Facts only, no pick. Researched 2026-10-22 from vendor documentation and package registry metadata. Items marked **not found** were not on the pages read; they are gaps, not statements that the feature is absent.

Context in this repo: outbound email is `packages/email` (`resend` ^6.32.1, console and capture transports, chosen in `apps/web/src/email.ts`). There is no inbound email. The Host is never deployed (localhost only, fake adapter in CI).

## Summary table

| Option                    | Inbound reaches localhost by                                            | SPF/DKIM/DMARC verdict                                                                                                    | Message-ID, In-Reply-To, References                                           | Plus-address / catch-all                                                     | Quote stripping                                        | Webhook signing                                        | Size limit                                                | Cost                                                              | Licence                      |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------- |
| Resend Receiving          | Webhook (needs public URL or `resend webhooks listen`), or poll via CLI | Yes: `authentication.{spf,dkim,dmarc}` on the retrieve API, computed by the receiving server                              | `message_id` in webhook; `headers` on retrieve API                            | Any local part at the receiving domain or `<id>.resend.app`                  | None documented                                        | Svix (`svix-id`, `svix-timestamp`, `svix-signature`)   | Not found (HTML over 100 MB is returned with `cid:` refs) | Counts against the sent+received quota; Free 100/day, 3,000/month | Proprietary service; SDK MIT |
| Postmark Inbound          | Webhook to a public URL                                                 | `Received-SPF` header (pass/fail/softfail/neutral); DKIM only via SpamAssassin `X-Spam-Tests`                             | `Headers` array has `Message-ID`; reply fields need In-Reply-To or References | `MailboxHash` for `user+hash@`; one domain per inbound stream                | `StrippedTextReply` (English, plain text only)         | No signature; HTTP basic auth in the URL               | 35 MB attachments                                         | Inbound listed on Pro and Platform plans                          | Proprietary                  |
| Mailgun Routes            | Route `forward()` to a public URL                                       | Not found on pages read                                                                                                   | Not found on pages read (`message-headers` carries all headers)               | `catchall()`, `match_recipient()` filters                                    | `stripped-text`, `stripped-signature`, `stripped-html` | HMAC-SHA256 (`timestamp`+`token`, signing key)         | Not found                                                 | Free plan has 1 inbound route                                     | Proprietary                  |
| SendGrid Inbound Parse    | POST to a public URL                                                    | `dkim` and `SPF` form fields                                                                                              | `headers` field (default format), or raw MIME in `email`                      | Any local part at the receiving domain; wildcard not documented              | None                                                   | No signing documented for Inbound Parse                | 30 MB                                                     | Not found on pages read                                           | Proprietary                  |
| Cloudflare Email Workers  | Runs in a Worker; the Worker must call out to reach localhost           | Email Routing rejects mail that fails SPF and DKIM or the sender's DMARC policy; no per-message verdict object documented | `message.headers`, `message.raw`                                              | Catch-all and subaddressing (opt-in setting)                                 | None (`postal-mime` parses MIME)                       | Not applicable (no webhook) unless the Worker adds one | 25 MiB                                                    | Routing free; Workers Free plan may hit CPU limits                | Proprietary                  |
| Mailpit (local SMTP sink) | Local SMTP on 1025, REST API and optional webhook                       | Not found (SpamAssassin spam score only)                                                                                  | Raw message viewable; API not read in detail                                  | Plus addressing used for tagging; accepts any recipient in "accept any" mode | None                                                   | None (local)                                           | Not found                                                 | Free                                                              | MIT                          |
| `smtp-server` (npm)       | You run an SMTP listener on a port                                      | None built in; pair with `mailauth`                                                                                       | You parse the raw stream                                                      | You decide in the recipient handler                                          | None                                                   | Not applicable                                         | `size` option, `rejectOversized`                          | Free                                                              | MIT-0                        |

## Resend (already in the repo)

Resend receives inbound mail. Source: https://resend.com/docs/dashboard/receiving/introduction.md

- Receiving addresses: any username at an account `<id>.resend.app` subdomain (for example `test@<id>.resend.app`), or any address at a verified custom domain once an extra MX record is added. Source: introduction and https://resend.com/docs/dashboard/receiving/custom-domains.md
- If the domain already has MX records, Resend recommends a subdomain, because mail goes to the lowest-priority MX. Mail to a domain whose receiving MX is not verified is dropped. Source: custom-domains.
- Delivery: Resend parses the message and POSTs an `email.received` webhook. The payload carries metadata only: `email_id`, `created_at`, `from` (bare address), `to`, `cc`, `bcc`, `received_for`, `message_id`, `subject`, `attachments` (id, filename, content_type, content_disposition, content_id). Body, headers and attachment bytes are not in the webhook; call the Received emails API with `email_id`. Source: https://resend.com/docs/webhooks/emails/received.md and https://resend.com/docs/dashboard/receiving/get-email-content.md
- Retrieve API (`resend.emails.receiving.get(id)`): returns `html`, `text`, `headers`, `received_for`, `authentication`, and `raw`. Source: https://resend.com/docs/api-reference/emails/retrieve-received-email.md
  - `authentication.spf`, `.dkim`, `.dmarc` each `'pass' | 'fail' | 'gray' | 'processing_failed' | 'unknown'`. The page says they "come from the receiving mail server, not from the message headers, so the sender cannot forge them". `null` for emails received before the field existed. `gray` for DKIM means unsigned or signing domain does not match From; `gray` for DMARC means no policy or `p=none`.
  - `raw.download_url`: signed CloudFront URL for the original message including attachments, with `expires_at`.
  - `html_format=cid` keeps `cid:` references; HTML that would inline to over 100 MB is always returned with `cid:`.
- Attachments: separate list and retrieve endpoints, with expiring `download_url`s. Source: https://resend.com/docs/dashboard/receiving/attachments.md
- Threading on reply: send with header `In-Reply-To` set to the received `message_id` and subject starting `Re:`. The page sets only In-Reply-To (it does not show `References`). Source: https://resend.com/docs/dashboard/receiving/reply-to-emails.md
- Message-ID, In-Reply-To and References as keys inside the retrieved `headers` object: the reference page read does not enumerate header keys. **Not verified.**
- Plus-addressing and catch-all: introduction says "any username" / "any address at the domain" is received. Specific plus-address handling is **not found**.
- Quote stripping: **not found** (no Resend feature or recommended library).
- Webhook signing: Svix. Headers `svix-id`, `svix-timestamp`, `svix-signature`; verify with `resend.webhooks.verify({ payload, headers, webhookSecret })` using the raw body, or the `svix` package. Source: https://resend.com/docs/webhooks/verify-webhooks-requests.md
- Retries: immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h; endpoint auto-disabled if it keeps failing; manual replay in dashboard. Source: https://resend.com/docs/webhooks/retries-and-replays.md
- Reaching localhost: the webhook needs a public HTTPS URL. The Resend CLI documents `resend webhooks listen --events email.received [--forward-to <url>] [--port 4318]`, which "starts a server, registers a temporary webhook, streams events, and cleans up on exit", forwarding with the original Svix headers. It also documents `resend emails receiving listen` ("Poll for new inbound emails as they arrive"), which needs no inbound connection. Source: https://resend.com/docs/cli.md. Whether `webhooks listen` itself opens a public tunnel or relays through Resend was not stated on the page.
- The CLI also lists an `inboxes` feature (inboxes, threads, reply, forward) and `--forwarding` ("Receive mail without an MX record. Resend returns a receiving address to forward mail to"). Source: cli.md.
- Cost: sent and received emails both count toward the quota, one per received email. Free plan: 100/day and 3,000/month; Pro $20/mo for 50,000. Source: https://resend.com/docs/knowledge-base/account-quotas-and-limits.md and https://resend.com/docs/knowledge-base/what-is-resend-pricing.md. Whether the Free plan includes receiving at all: not stated on those pages.
- Size limit for an inbound message: **not found.**
- Version: `resend` npm 6.34.1, MIT (npm registry, 2026-10-22). The repo pins ^6.32.1.

## Postmark Inbound

Sources: https://postmarkapp.com/developer/webhooks/inbound-webhook, https://postmarkapp.com/developer/user-guide/inbound/parse-an-email, https://postmarkapp.com/developer/user-guide/inbound/configure-an-inbound-server, https://postmarkapp.com/pricing

- Delivery: HTTP POST of JSON to the server's `InboundHookUrl`; HTTP basic auth credentials can be put in the URL (`https://user:pass@host/path`). No webhook signature is documented on these pages.
- Address: `<InboundHash>@inbound.postmarkapp.com`, or inbound domain forwarding. One inbound stream per server, one domain per stream.
- Fields: `Headers` (array of Name/Value, includes `Message-ID`, `Received-SPF`, `DKIM-Signature`, SpamAssassin `X-Spam-*`), top-level `MessageID` (Postmark-generated, differs from the `Message-ID` header), `MailboxHash` (the part after `+`), `OriginalRecipient`, `StrippedTextReply`, attachments (`Name`, base64 `Content`, `ContentType`, `ContentLength`).
- SPF: `Received-SPF` header, one of neutral, pass, softfail, fail. DKIM: no dedicated verdict field; visible indirectly via `DKIM-Signature` and SpamAssassin tests such as `DKIM_VALID`. DMARC: **not found**.
- `StrippedTextReply` is only populated when the message has In-Reply-To or References, English plain-text only; HTML-only replies are not parsed.
- Retries: non-200 is retried up to 10 times, 1 minute to 6 hours; a 403 stops retries.
- Size: attachments total at most 35 MB.
- Cost: Free is 100 emails/month; Pro and Platform list inbound processing; Free and Basic do not list it. Proprietary service.

## Mailgun Routes

Sources: https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/routes, .../receive-http, .../webhooks/securing-webhooks, https://www.mailgun.com/pricing/

- Routes pair a filter (`match_recipient()`, `match_header()`, `catchall()`) with actions (`forward()`, `store()`, `stop()`); priority ordered; filter and action fields capped at 4k.
- Forward to a URL posts form data (multipart when there are attachments), JSON if the URL ends in `json`, or raw MIME (`body-mime`) if it ends in `mime` or `raw-mime`.
- Fields: `sender` (envelope), `from` (header), `recipient`, `subject`, `message-headers`, `body-plain`, `body-html`, and `stripped-text`, `stripped-signature`, `stripped-html` when parsing succeeds. JSON posts carry `attachments` with base64 content.
- Signing: HMAC-SHA256 over `timestamp` + `token` with the account HTTP webhook signing key, hex compared to `signature`; cache tokens against replay. For JSON posts the signature is in `X-Mailgun-Signature` / `X-Mailgun-Timestamp` headers.
- Retries: HTTP 200 success; 406 means rejected and not retried; other codes retried at 10, 15, 30 min, 1, 2, 4 h (8 h total).
- SPF/DKIM verdict fields, In-Reply-To field, size limit: **not found** on the pages read.
- Free plan: $0, 100 emails/day, 1 inbound route; Basic 5 routes. Proprietary service.

## SendGrid Inbound Parse

Source: https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook and .../inbound-email

- Setup: MX record `mx.sendgrid.net` priority 10 on a dedicated hostname; any local part except `abuse`, `postmaster`, `unsubscribe`; the webhook does not follow redirects; only authenticated domains.
- POST fields (default multipart/form-data): `headers`, `dkim`, `SPF`, `envelope`, `to`, `from`, `subject`, `text`, `html`, `sender_ip`, `spam_report`, `spam_score`, `charsets`, `content-ids`, `attachments`, `attachment-info`. Raw option sends the full MIME in `email` and omits `headers`, `text`, `html`.
- `dkim` and `SPF` report the sender's authentication results. The exact value format was not on the pages read. No DMARC field documented.
- No signing documented for Inbound Parse; the page says the target URL must be reachable from the internet.
- Size: 30 MB total recommended; spam check only up to 2.5 MB. Retries on 5xx; undelivered after 3 days dropped.
- Quote stripping: none. Cost and free-plan availability: **not found.**

## Cloudflare Email Routing and Email Workers

Sources: https://developers.cloudflare.com/email-routing/email-workers/, .../email-workers/runtime-api/, .../email-routing/limits/, .../email-routing/postmaster/, .../email-routing/setup/email-routing-addresses/

- A Worker exports `email(message, env, ctx)`; `message` has `from`/`to` (envelope), `headers`, `raw` (ReadableStream), `rawSize`, `canBeForwarded`, with `forward()`, `reply()`, `setReject()`. `postal-mime` is the recommended parser.
- Inbound auth: "Emails that fail both [SPF and DKIM] are rejected"; mail failing the sender's DMARC policy is rejected. No `Authentication-Results` property on the message is documented, so a Worker cannot read a per-message verdict from the documented API.
- `reply()` requires a valid DMARC result on the incoming mail, replies only to the original sender, the sending domain must match the receiving domain, `References` must have 100 entries or fewer, one reply per event.
- Addresses: custom rules, catch-all, and subaddressing (RFC 5233, opt-in setting; `user+detail@` matches the `user@` rule and `+detail` is kept in `message.to`). The postmaster page itself does not mention subaddressing.
- Limits: 25 MiB inbound, 200 rules per domain, 200 destination addresses per account. Free Workers can hit CPU/memory limits (`EXCEEDED_CPU`).
- Reaching localhost: the Worker runs on Cloudflare, so it must make an outbound HTTP call to a public URL. Cloudflare Quick Tunnels (`cloudflared tunnel --url http://localhost:8080`) give a temporary `trycloudflare.com` URL without an account; no uptime guarantee, 200 in-flight requests, hostname changes per run. Source: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
- Requires a domain on Cloudflare DNS (implied by Email Routing; not stated as a separate sentence on the pages read).

## Local SMTP

- Mailpit (https://github.com/axllent/mailpit): MIT, Go single binary, SMTP 1025, web UI and REST API 8025, optional webhook for received messages, optional POP3, STARTTLS/TLS/auth with an "accept any" mode, SMTP relay and forwarding, SpamAssassin spam score, plus-address tagging, keeps the latest 500 messages by default. No SPF/DKIM verification is documented. Because it is a sink on localhost, no real internet mail reaches it; it only receives mail you send to it.
- `smtp-server` (nodemailer, https://github.com/nodemailer/smtp-server; npm 3.21.0, MIT-0): you write the SMTP listener. `onData(stream, session, cb)` must consume the stream; `size` plus `rejectOversized: true` gives a 552; `maxRecipients`; `disabledCommands`. No SPF/DKIM built in.
- `mailauth` (https://github.com/nodemailer/mailauth; npm 8.0.1, MIT): `authenticate(rawMessage, { ip, helo, sender, mta })` returns `dkim`, `spf`, `arc`, `dmarc`, `bimi`, `receivedChain` and Authentication-Results headers. It needs the SMTP client IP and HELO, which only a listener that sees the real SMTP connection has.
- Public mail cannot reach a laptop without a public MX host and an open port 25 or a relay; the pages above do not cover that setup. This is why the hosted options use webhooks.

## Reaching localhost (tunnels)

- Cloudflare Quick Tunnels: see above.
- ngrok free plan: one assigned dev domain, up to 3 online endpoints, 1 GB/month transfer out, 20,000 HTTP requests/month; an interstitial page applies to HTML browser traffic only, not API clients. Source: https://ngrok.com/docs/pricing-limits/free-plan-limits/
- Resend CLI `webhooks listen --forward-to` and `emails receiving listen` (polling): see Resend.
- Polling needs no tunnel: Resend's receiving API and CLI can be polled; the IMAP approach below is also pull-based.

## Quoted-reply stripping libraries

- `email-reply-parser` (Crisp, https://github.com/crisp-oss/email-reply-parser): Node, MIT, plain-text only, about 10 locales, strips "On DATE, NAME wrote:", quoted text and signatures like "Sent from my iPhone"; used by Crisp on about 1 million inbound emails a day per its README. `new EmailReplyParser().read(text).getVisibleText()`.
- `talon` (Mailgun, https://github.com/mailgun/talon): Python, Apache-2.0, `quotations.extract_from()` for plain text and HTML, signature extraction (brute force, optional ML); maintenance status not stated on the page.
- Provider-side: Postmark `StrippedTextReply` (English plain text), Mailgun `stripped-text` / `stripped-html`. Resend, SendGrid and Cloudflare: none documented.

## How shipped OSS agents wire email

OpenClaw (docs at version 2026.9.2, https://unpkg.com/openclaw@2026.9.2/docs/automation/imap.md; the docs.openclaw.ai host did not resolve from this machine):

- The bundled IMAP plugin is a one-way trigger: it watches an existing mailbox (poll or IDLE, `pollSeconds` minimum 15) and starts an isolated agent session per allowed message. It does not send mail, change flags, expose a webhook or backfill; existing mail is baselined on first start; dedupe survives restarts; three failed attempts then skip.
- Admission: parsed `From` must match `allowedSenders` (full addresses or `@domain`); display name and `Reply-To` grant nothing; multiple `From` addresses rejected; empty list disables the account.
- Authentication ranking verified > asserted > unverified > mutable. Default minimum is `verified`, meaning local verification with an aligned DMARC pass. A trusted Authentication-Results server can give `asserted` (opt-in). SPF alone is `unverified`. Optional sender-bound `addressTokens` skip the 48-hour freshness check and authentication for senders that cannot produce useful DKIM/DMARC.
- The message is read by a restricted "reader" agent (sandboxed, no workspace access, minimal tools). The docs state admission is not completion and exactly-once is not guaranteed.
- Threading and quoted text: not covered on that page.
- Community channel `@clawemail/email` 0.9.13 (https://unpkg.com/@clawemail/email@0.9.13/README.md): IMAP IDLE in, SMTP out, `channels.email` config, `allowFrom` patterns, threading by `References` and `In-Reply-To`, HTML to Markdown. No SPF/DKIM verification and no quote stripping mentioned.
- AgentMail's OpenClaw integration (https://agentmail.to/docs/integrations/openclaw.md) is webhook based with an allowlist where an empty `allowFrom` denies every sender; not read in detail.

## Gaps to close before deciding

- Resend: inbound size limit, whether the Free plan includes receiving, whether `headers` on the retrieve response include `In-Reply-To` and `References`, and what `webhooks listen` does to receive events on localhost.
- Mailgun: SPF/DKIM fields posted to routes, `In-Reply-To` as a field, size limit.
- SendGrid: `dkim`/`SPF` value format, signing, plan availability.
- Postmark: DMARC; MX setup page.

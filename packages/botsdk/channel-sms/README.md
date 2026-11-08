# @botsdk/channel-sms

A Telnyx SMS messaging adapter for the `channels` slot (spec #1174). Plain `fetch` and `node:crypto`; no dependency. Its Channel id is `sms`, which the Outbound gate's opt-out words (`channelWords.sms`) are keyed by.

```ts
import { sms } from "@botsdk/channel-sms";

sms(); // or sms({ apiBase: "http://localhost:4010" }) to point at the lab phone
```

- **Credentials** (`apiKey`, `publicKey`, `number`): the API key, the account's webhook public key (base64, 32 raw bytes) and the sending number in E.164. `check` looks the number up with `GET /v2/phone_numbers`.
- **Inbound:** a `webhook` adapter. Point the Telnyx messaging profile's webhook at `POST <basePath>/channels/sms/<accountId>`. `telnyx-signature-ed25519` is verified over `{telnyx-timestamp}|{raw body}`; a timestamp more than five minutes old is refused. Only `message.received` makes an update; its `sourceId` is `payload.id`. Media is ignored, so a media-only message gives no update.
- **Outbound:** `POST /v2/messages` with `from`, `to` and `text`. A 401 is a `CredentialsRejectedError`; any other failure is a `TelnyxApiError`, which the core retries (one request, so nothing is half-sent and `MessagingSendError` never applies).
- **Multipart:** one request sends the whole reply. Telnyx splits a long text into segments and joins them into one message itself (its response carries `parts`), so the adapter does not send parts one by one. Taken from Telnyx's documented behaviour; not yet run against the real API.
- **Reach:** `canStartConversation: false`, no reply window, `maxLength` 459 (3 x 153 GSM-7). At most three segments per reply: 3 x 153 GSM-7 septets (extension characters count 2), or 3 x 67 UTF-16 units when any character needs UCS-2. A longer reply is cut on a word boundary and ends `... (cut)`.
- `verifiesSender` is left out: numbers can be spoofed.

## Try it without Telnyx: the lab phone

`lab-phone/` is a small dev-only server (plain Node, no dependency) that stands in for Telnyx, the way Mailpit stands in for email. It answers `GET /v2/phone_numbers` (any number exists) and `POST /v2/messages` (any API key; one long `text` is one text), and its page shows the texts the app sent, per phone number, and sends a text "from" any number to the app.

1. `docker compose up -d lab-phone` (from the repo root), then open http://localhost:4010. Its signing key is made from `LAB_PHONE_SEED` (default `lab-phone`), so the public key on the page is the same after a restart.
2. Set `SMS_API_BASE=http://localhost:4010` in `apps/web/.env` and start the app. The app then talks to the lab phone instead of `https://api.telnyx.com`; the adapter's code, signature check included, is the same.
3. Connect an SMS Channel account to a Bot with any `apiKey`, the lab phone's public key as `publicKey`, and a number in E.164 (the page's "To" field defaults to `+15550001111`).
4. On the lab phone, set the webhook URL to `http://host.docker.internal:3001/api/chat/channels/sms/<accountId>` (the app's base path is `/api/chat`; `host.docker.internal` is how the container reaches the app), then type a text. The page signs a `message.received` event and posts it; the Bot's reply appears under the sender's number.

The lab phone keeps its texts in memory and accepts any key, so run it only on a machine of your own. `GET /texts` returns them as JSON. `test/lab-phone.test.ts` runs the round trip through the adapter.

## The real Telnyx trial

1. Sign up at telnyx.com. The trial gives about $5 of credit, one number, and texts only to and from one verified number (your own phone). A trial number is reclaimed after 30 days.
2. Buy the number, create a messaging profile, and give it the number. Copy the API key (Auth, API Keys) and the webhook public key (Keys and Credentials, Public Key: base64, 32 bytes).
3. The webhook must be reachable from the internet, so run a tunnel to the app (for example `cloudflared tunnel --url http://localhost:3001`) and set the messaging profile's webhook URL to `https://<tunnel host>/api/chat/channels/sms/<accountId>`. Leave `SMS_API_BASE` unset.
4. Connect the Channel account with the API key, public key and number. Text the number from the verified phone.

Limits of the trial:

- Only the one verified number can text the Bot and receive its replies, so the trial can't show a stranger reaching the Bot. Other numbers' texts to it are not delivered, and the Bot can't text them.
- US numbers sending texts to US users need 10DLC registration (brand and campaign) on a real deployment. The trial skips it; this adapter and the design don't block it, and it is left for when the Bot is deployed.
- The number goes back after 30 days, and a new one means a new Channel account.

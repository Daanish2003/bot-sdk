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

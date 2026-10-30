# Messaging display capabilities

Research for [#1038](https://github.com/Daanish2003/bot-sdk/issues/1038) (child of map [#976](https://github.com/Daanish2003/bot-sdk/issues/976)). Researched 2026-10-30 against each platform's own docs. Builds on [messaging-channel-apis.md](./messaging-channel-apis.md), which decided which platforms qualify; this note does not redo that.

## Question

For Telegram, Discord, Slack, Matrix, WhatsApp Cloud API and SMS (Telnyx): what interactive controls exist, how a press comes back, which markup dialect text uses, message length limits, and file and voice limits in and out. This is the fact base for how a **Rich control** falls back.

## What has to be shown

From `CONTEXT.md`: a Bot talks through **SendToUser**. A Message is text plus at most one **Rich control** (a choice, files, a password entry or an Approval). The text is what every Channel can always show. Each Channel shows a Rich control in the simplest form it can, and the user's answer to a choice wakes the Bot like any Trigger.

So the fact base needed is: (1) can the platform draw a choice natively, and what are its limits; (2) how does the answer arrive; (3) what is the safe text size and dialect; (4) can files and voice come in and go out.

## Verdict

|                                  | Telegram                                                                                                 | Discord                                                                                                                                                     | Slack                                                                                                                                                                    | Matrix                                                                                    | WhatsApp Cloud                                                                                                        | SMS (Telnyx)                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Native choice control**        | Inline keyboard of buttons [T1]                                                                          | Buttons (5 per action row) and string selects [D3]                                                                                                          | Block Kit buttons, up to 25 per actions block [S1][S2]                                                                                                                   | None in the released spec read; polls MSC3381 is accepted but its spec PR is missing [M3] | Reply buttons (max 3) or a list (max 10 rows) [W1][W2]                                                                | None                                                                                                |
| **Choice size limits**           | `callback_data` 1-64 bytes [T1]; button count not stated in the text read                                | label 80 chars, `custom_id` 100 chars, 40 components per message, select 25 options [D3]                                                                    | button text 75 chars, `value` 2000, `action_id` 255 [S2]                                                                                                                 | n/a                                                                                       | buttons: 3, title 20, id 256, body 1024. List: 10 rows, row title 24, row id 200, button label 20, body 4096 [W1][W2] | n/a                                                                                                 |
| **How a press returns**          | `callback_query` update; the bot must call `answerCallbackQuery` or the client shows a progress bar [T1] | `INTERACTION_CREATE` over the Gateway (or an HTTP endpoint, not both); initial response within **3 s**, token valid 15 min [D4]                             | `block_actions` payload with `actions[].action_id`/`value`: HTTP POST (ack within **3 s**) or, in Socket Mode, an `interactive` envelope acked by `envelope_id` [S3][S4] | A reply message the user types (no button event)                                          | `messages` webhook, `interactive.button_reply{id,title}` or `list_reply{id,title,description}` [W1][W2]               | A reply SMS the user types                                                                          |
| **Text markup**                  | `MarkdownV2`, `HTML`, legacy `Markdown`, or entities (UTF-16 offsets) [T1]                               | A subset of Markdown [D2]                                                                                                                                   | `mrkdwn` (own syntax: `*bold*`, `_italic_`, `<url\|label>`) [S5]                                                                                                         | Plain `body` plus optional `org.matrix.custom.html` `formatted_body` [M1]                 | WhatsApp formatting; syntax not verified in the docs read                                                             | Plain text only                                                                                     |
| **Text length**                  | 4096 chars after entity parsing; caption 1024 [T1]                                                       | 2000 chars; 10 embeds [D1]                                                                                                                                  | `text` best at ~4000, truncated past 40,000; `markdown_text` 12,000 [S6]                                                                                                 | Whole event under 65,536 bytes [M1]                                                       | 4096 chars [W3]                                                                                                       | 1600 chars (concatenated); 160 GSM-7 / 70 UTF-16 per segment, 153 / 67 when split [TN1][TN2]        |
| **Files out**                    | Photo 10 MB, other files, audio, voice 50 MB (cloud Bot API) [T1]                                        | 20 MiB per file by default, 25 MiB per request [D1][D5]                                                                                                     | Three-step upload; no size limit in the docs read [Ex1]                                                                                                                  | Homeserver's `m.upload.size` (example 50,000,000 bytes) [M2]                              | Image 5 MB, video 16 MB, audio 16 MB, document 100 MB [W4]                                                            | MMS: up to 10 media URLs, each under 1 MB, total under 2 MB [TN3]                                   |
| **Files in**                     | `getFile`, up to **20 MB** [T1]                                                                          | Attachment CDN URL on the message                                                                                                                           | `file_shared` gives an id; `files.info` then `url_private` with a token [Ex1][S7]                                                                                        | `mxc://` media download                                                                   | Media id from the webhook, then GET with token; the URL lives **5 min**; webhook media id lives 7 days [W4]           | `payload.media[]` with `url`, `content_type`, `size`; URL needs the API key and lives 30 days [TN4] |
| **Voice out**                    | `sendVoice`: OGG/Opus, MP3 or M4A, up to 50 MB [T1]                                                      | `IS_VOICE_MESSAGE` flag: one audio attachment, **no content**, needs `duration_secs` and `waveform`, can't be edited; OGG/Opus 48 kHz mono recommended [D1] | A plain audio file (no voice-clip API found)                                                                                                                             | `m.audio`; voice-message MSC3245 is still open [M4]                                       | `.ogg` Opus mono with `"voice": true`; 16 MB; play icon only if 512 KB or smaller [W5]                                | MMS audio (MPEG, OGG, AMR)                                                                          |
| **Voice in**                     | `Voice` object (`file_id`, `duration`, `mime_type`, `file_size`) [T1]                                    | An audio attachment with the voice flag                                                                                                                     | Not covered in the docs read                                                                                                                                             | `m.audio` event                                                                           | Audio media message; fetch like any media                                                                             | MMS audio                                                                                           |
| **Fallback needed for a choice** | None                                                                                                     | None                                                                                                                                                        | None                                                                                                                                                                     | Numbered text list                                                                        | None up to 3 options (buttons), up to 10 (list); more falls back to text                                              | Numbered text list                                                                                  |

## Per platform

### Telegram

- **Controls:** `InlineKeyboardMarkup` (buttons under the message) and `ReplyKeyboardMarkup` (replaces the user's keyboard). A callback button carries `callback_data` of **1-64 bytes** [T1]. That is enough for a short opaque token (a Rich control id plus option index), not for the option text.
- **Press back:** a `CallbackQuery` update. "After the user presses a callback button, Telegram clients will display a progress bar until you call answerCallbackQuery", so a handler must always call it, even with no notification text (0-200 chars if given) [T1].
- **Text:** `parse_mode` of `MarkdownV2` (needs escaping of many characters), `HTML`, or explicit `MessageEntity` lists; entity offsets are UTF-16 code units [T1]. The page also documents a newer "rich message" format (headings, tables, lists; up to 32,768 chars and 500 blocks) [T1]; not assessed further, because the safe baseline is a normal message.
- **Limits:** `text` 1-4096 chars after entity parsing; captions 0-1024 [T1].
- **Files:** `getFile` downloads up to **20 MB**; bots upload documents, audio and voice up to **50 MB**, photos 10 MB (a URL-fetched file: 5 MB photos, 20 MB others) [T1]. A self-hosted Bot API server lifts these to 2000 MB up and unlimited down [T1].
- **Voice:** `sendVoice` plays as a voice message if the file is OGG/Opus, MP3 or M4A; other formats become audio or a document [T1].

### Discord

- **Controls:** message components. Legacy messages allow up to 5 action rows; the newer `IS_COMPONENTS_V2` flag (`1<<15`) allows up to **40 total components** but then disables `content` and `embeds`, and the flag can't be removed [D3][D1]. An action row holds up to 5 buttons; buttons have `label` max 80 chars; `custom_id` is 1-100 chars; a string select has up to 25 options, each with label/value/description up to 100 chars [D3].
- **Press back:** an Interaction. It arrives as `INTERACTION_CREATE` on the Gateway or at an HTTP endpoint (mutually exclusive). The app **must send an initial response within 3 seconds** or the token is invalidated; the token then lasts 15 minutes for follow-ups [D4]. Because the Gateway is the local-test path, the response goes out over REST.
- **Text:** a subset of Markdown, plus mention syntax [D2]. Content max **2000 chars**; embeds: 10 per message, description 4096, 6000 chars total [D1].
- **Files:** default **20 MiB per file** (higher for boosted servers); the whole request is capped at 25 MiB [D5][D1].
- **Voice:** `IS_VOICE_MESSAGE` (`1<<13`): a single audio attachment, no content or stickers, `duration_secs` and a base64 `waveform` (at most 256 points), cannot be edited. Clients upload mono 48 kHz 32 kbps Opus in OGG, which the page calls an implementation detail [D1].

### Slack

- **Controls:** Block Kit. An `actions` block holds up to **25** elements, `block_id` up to 255 chars [S1]. A button has text up to 75 chars (may truncate near 30), `value` up to 2000, `action_id` up to 255, and styles `primary` or `danger` [S2].
- **Press back:** a `block_actions` payload. Over HTTP it is a form-encoded POST whose `payload` parameter is JSON; the app must reply 200 **within 3 seconds** [S3]. Over Socket Mode the same payload arrives in an `interactive` envelope and is acked by sending back its `envelope_id`; the inner payload carries `actions` with `action_id`, `block_id`, `value` [S4]. The payload's `response_url` takes up to 5 replies in 30 minutes and can replace or delete the original message [S3].
- **Text:** `mrkdwn`, "inspired by markdown, but uses different rules" [S5]. Bold `*x*`, italic `_x_`, strike `~x~`, link `<url|label>`, mention `<@U012AB3CD>`. Recommended: use IDs, not names.
- **Limits:** `text` is best under ~4000 chars; Slack truncates past 40,000. `markdown_text` is capped at 12,000 [S6]. Up to 100 attachments per message [S6].
- **Files:** upload via `files.getUploadURLExternal` and `files.completeUploadExternal`; download `url_private` with a Bearer token [S7]. No size limit in those docs. `file_shared` carries only the file id; fetch details with `files.info` [Ex1].
- **Voice:** not covered in the docs read; treat clips as audio files.

### Matrix

- **Controls:** none in the released Client-Server spec I read. Polls (MSC3381) were merged as a proposal on 2023-12-05 but labelled "accepted, missing spec PR" and blocked on Extensible Events [M3]; voice messages (MSC3245) are still an open proposal [M4]. A choice therefore falls back to text. Reactions (`m.annotation` relations) exist in the spec [M1], but using them as an answer channel is an inference from that, not a documented pattern.
- **Press back:** a normal `m.room.message` from the user.
- **Text:** `body` is the plain fallback; for `m.text`, `m.emote`, `m.notice` and (since v1.10) media captions, `format: "org.matrix.custom.html"` plus `formatted_body`. The spec's suggested HTML allowlist: `del, h1-h6, blockquote, p, a, ul, ol, sup, sub, li, b, i, u, strong, em, s, code, hr, br, div, table, thead, tbody, tr, th, td, caption, pre, span, img, details, summary` [M1].
- **Limits:** the whole event must be under **65,536 bytes** [M1]. No separate character limit.
- **Files:** `POST /_matrix/media/v3/upload`; the server advertises `m.upload.size` (the spec's example is 50,000,000 bytes); if unlisted, treat as unknown [M2]. Messages are `m.image`, `m.file`, `m.audio`, `m.video`.
- **Voice:** a plain `m.audio` message; the voice-clip flavour is an open MSC [M4].

### WhatsApp Cloud API

- **Controls:** two interactive types. **Reply buttons:** max **3**, title 20 chars (unique), id 256, body 1024, footer 60, optional header of text/image/video/document [W1]. **List:** one button (label 20), up to 10 sections and **10 rows total**; row title 24, row id 200, row description 72, body 4096, header 60, footer 60 [W2].
- **Press back:** a `messages` webhook with `type: "interactive"`; `interactive.button_reply` has `id` and `title`; `interactive.list_reply` has `id`, `title`, `description` [W1][W2]. Use the `id` to identify the choice.
- **Window:** interactive and free-form messages can only start inside the 24-hour customer service window (from the survey [W-survey]); outside it a template is needed. A Bot that speaks first cannot send a choice.
- **Text:** `text.body` up to **4096 chars**, URLs auto-link, link preview only for the first URL when asked [W3]. The formatting syntax (`*bold*` and friends) is not in the pages read.
- **Files:** audio 16 MB (AAC, AMR, MP3, M4A, OGG with Opus mono only), document 100 MB (PDF, Office, TXT), image 5 MB (JPEG, PNG), video 16 MB (3GP, MP4 H.264/AAC). Inbound: media id from the webhook, then GET the URL with the token; **URLs expire after 5 minutes** (re-request on 404), webhook media ids after 7 days; inbound over 100 MB gives error 131052 [W4].
- **Voice:** send `.ogg` Opus mono with `"voice": true`; the play icon shows only if the file is 512 KB or smaller (larger shows a download icon). Whether a transcript shows depends on the user's setting [W5].

### SMS (Telnyx)

- **Controls:** none; SMS is text. A choice is a numbered list the user answers by typing a number or word.
- **Press back:** the reply is a `message.received` webhook. `payload.from.phone_number` (E.164), `payload.text` (null for media-only MMS), `payload.media[]` [TN4]. Webhooks are signed: `telnyx-signature-ed25519` (Base64) and `telnyx-timestamp`, checked against the account public key [TN4]. The send-message page lists only an IP allowlist and "return 200 within 5 seconds" [TN3].
- **Text:** plain. Send limit **1600 chars** (concatenated) [TN3]. One segment is 160 chars in GSM-7 or 70 in UTF-16; split messages hold 153 / 67 per segment. A single emoji or curly quote switches the **whole** message to UTF-16; `^ { } \ [ ~ ] | €` count as two [TN2]. A Bot reply with an emoji costs more than twice as many segments.
- **Files:** MMS only. Out: up to 10 HTTPS media URLs, each under 1 MB, total under 2 MB [TN3]. In: JPEG, PNG, GIF, BMP, WebP, MP4, 3GPP, MPEG/OGG/AMR audio, PDF, vCard, calendar; no size cap documented, use the `size` field; URLs need the API key and last 30 days [TN4].
- **Voice:** only as MMS audio.

## What this means for a Rich control's fallback

These follow from the table; the decision itself belongs to the next ticket ([#1039](https://github.com/Daanish2003/bot-sdk/issues/1039), which this blocks).

1. **Two tiers cover the six platforms.** Native buttons/select (Telegram, Discord, Slack, WhatsApp up to 3-10 options); text list with typed reply (Matrix, SMS, and any native Channel when options exceed its limit).
2. **The smallest native choice size is WhatsApp's: 3 buttons, 20-char titles** (10 rows, 24-char titles via a list). A choice with more than 10 options or labels over ~20 chars cannot be native there. Telegram `callback_data` (64 bytes), Discord `custom_id` (100) and Slack `value` (2000) all fit a short id, so the option text should live in the Host and the control carry only an id.
3. **The press can be a text reply anywhere.** A Channel that can't draw buttons still gets the answer as an inbound message, so the matching step (number or label to option) is the fallback's real work.
4. **Deadlines differ.** Discord and Slack HTTP need an ack within 3 s; Telegram wants `answerCallbackQuery` promptly; WhatsApp needs a 200 webhook response. The Host should ack first and let the runner do the Bot's work, as the repo already does for email.
5. **Safe text size.** The smallest text limit is Discord's 2000 chars (SMS's 1600 is smaller but costs per segment). A Channel adapter must split or trim; markup must be converted per dialect (Telegram MarkdownV2 escaping, Slack `mrkdwn`, Matrix HTML, WhatsApp, SMS none) from one neutral form.
6. **Files and voice differ most.** Inbound download caps (Telegram 20 MB, Discord 20 MiB, WhatsApp 100 MB, SMS unspecified) and expiring URLs (WhatsApp 5 min) mean a file must be fetched when the message arrives, not later. This matches the lazy `MailFile` shape in the survey, but with a deadline on WhatsApp.
7. **Voice out needs transcoding to OGG/Opus mono** to display as a voice note on Telegram, Discord and WhatsApp.
8. **WhatsApp cannot show a choice outside the 24-hour window**, so a Bot that speaks first (Check-in, Routine) over WhatsApp is text or template only.

## Not verified

- Telegram: the maximum number of buttons per inline keyboard, `callback_data` for non-callback buttons, and the rich message format's effect on a choice.
- Discord: inbound attachment shape and a max attachments per message; the Gateway voice-flag on inbound.
- Slack: the 50-block per message limit and the 3000-char section text limit (not on the pages read); file size limits; voice clip (`slack_audio`) handling; the `block_actions` payload reference page.
- Matrix: whether any shipping client renders buttons; the `m.reaction` answer pattern; end-to-end encrypted media.
- WhatsApp: text formatting syntax; inbound audio fields (a `voice` flag); group messaging.
- SMS: provider-agnostic limits; Telnyx inbound MMS size cap; the carriers' real MMS limits.

## Sources

- [T1] Telegram Bot API (single page, sections for sendMessage, InlineKeyboardButton, CallbackQuery, answerCallbackQuery, File, Voice, sendDocument, sendAudio, sendVoice, formatting options, rich messages): https://core.telegram.org/bots/api
- [D1] Discord message resource (content, embeds, flags, voice messages, request size): https://docs.discord.com/developers/resources/message
- [D2] Discord reference (message formatting): https://docs.discord.com/developers/reference.md
- [D3] Discord component reference: https://docs.discord.com/developers/components/reference.md ; overview https://docs.discord.com/developers/components/overview
- [D4] Discord receiving and responding to interactions: https://docs.discord.com/developers/interactions/receiving-and-responding.md
- [D5] Discord reference, uploading files (20 MiB default): https://docs.discord.com/developers/reference.md
- [S1] Slack actions block: https://docs.slack.dev/reference/block-kit/blocks/actions-block
- [S2] Slack button element: https://docs.slack.dev/reference/block-kit/block-elements/button-element
- [S3] Slack handling user interaction: https://docs.slack.dev/interactivity/handling-user-interaction
- [S4] Slack Socket Mode: https://docs.slack.dev/apis/events-api/using-socket-mode
- [S5] Slack formatting message text: https://docs.slack.dev/messaging/formatting-message-text
- [S6] Slack chat.postMessage: https://docs.slack.dev/reference/methods/chat.postMessage
- [S7] Slack working with files: https://docs.slack.dev/messaging/working-with-files
- [Ex1] Slack `file_shared` event: https://docs.slack.dev/reference/events/file_shared
- [M1] Matrix Client-Server API (message types, HTML, size limits): https://spec.matrix.org/latest/client-server-api/
- [M2] Matrix `m.upload.size` (capabilities / media config), same spec page.
- [M3] MSC3381 Polls: https://github.com/matrix-org/matrix-spec-proposals/pull/3381
- [M4] MSC3245 Voice messages: https://github.com/matrix-org/matrix-spec-proposals/pull/3245
- [W1] WhatsApp reply buttons: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages
- [W2] WhatsApp list messages: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages
- [W3] WhatsApp text messages: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages
- [W4] WhatsApp media: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
- [W5] WhatsApp audio messages: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/audio-messages
- [W-survey] 24-hour window: [messaging-channel-apis.md](./messaging-channel-apis.md) [W1 there]
- [TN1][TN3] Telnyx send message: https://developers.telnyx.com/docs/messaging/messages/send-message
- [TN2] Telnyx message encoding: https://developers.telnyx.com/docs/messaging/messages/message-encoding
- [TN4] Telnyx receive message: https://developers.telnyx.com/docs/messaging/messages/receive-message

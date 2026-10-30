# Voice note transcription for Channels

Research for issue #1041 (child of the map #976, "Wayfinder: Messaging Channels"). Researched on 2026-10-30. Question: does the repo already have a speech-to-text path, and if not, which Provider and Model transcribes an inbound voice note, in which formats do the platforms send them, and is conversion needed?

How to read the sources: `node_modules` is not installed in this worktree, so TanStack AI claims come from its published docs and from the repo's own earlier research (`docs/research/tanstack-ai-voice.md`, done against the installed packages). Vendor pages were fetched 2026-10-30 through a fetch tool that summarises pages, so exact wording is not quoted. Nothing here was run against a live Provider. Unverified claims are marked.

---

## Short answer

1. **No transcription path exists in the product code.** A search of `packages/` and `apps/` for `generateTranscription` and `Transcription` finds nothing. The only prior work is research: `docs/research/tanstack-ai-voice.md` (#234), which found transcription adapters on 6 of the installed adapters.
2. **The building block is already a dependency.** `@tanstack/ai` and `@tanstack/ai-openai` are both `1.0.0` in `packages/botsdk/bot/package.json`. `generateTranscription({ adapter: openaiTranscription(model), audio })` takes a `File`, `Blob`, `ArrayBuffer`, base64 string or data URL and returns `{ text, language, duration, ... }` ([TanStack transcription doc](https://tanstack.com/ai/latest/docs/media/transcription)). No new dependency for OpenAI.
3. **Recommended Model: OpenAI `gpt-4o-mini-transcribe` today, with a named exit.** OpenAI now recommends a new `gpt-transcribe` and marks `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and the diarize model **deprecated, shutting down 2027-02-26** ([OpenAI speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text)). TanStack's published doc lists only the old four OpenAI ids, so whether `openaiTranscription` accepts `gpt-transcribe` is **unverified**; check the installed adapter's model union before building. The build ticket should take the model id from one constant so the swap is one line.
4. **Conversion is needed for some platforms, not all.** OpenAI accepts mp3, mp4, mpeg, mpga, m4a, wav, webm, at most 25 MB, and the current guide says **Ogg/Opus is not supported**. Telegram, Discord and WhatsApp voice notes are Ogg/Opus. So either convert to a supported container, or use a Provider that takes Ogg (Groq). Details below.

---

## What the repo has

| Finding                                                                                                                                                                                                                          | Source                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| No `generateTranscription` / transcription call anywhere in `packages/` or `apps/`                                                                                                                                               | repo grep, 2026-10-30                                            |
| `@tanstack/ai` 1.0.0, `@tanstack/ai-openai` 1.0.0, `@tanstack/ai-anthropic` 1.0.0 are Bot package dependencies                                                                                                                   | `packages/botsdk/bot/package.json` lines 64, 82, 83              |
| Message `content` can carry `audio` parts, but the earlier research found `audio` and `video` throw in the adapter conversion it read (pre-1.0 packages)                                                                         | `docs/research/attachments.md` lines 70-79 (**re-check on 1.0**) |
| Provider transcription exists on OpenAI, Groq, Grok, Cloudflare, BytePlus, Lovable. Anthropic, Mistral, OpenRouter, Bedrock, Ollama and the gateways have none                                                                   | `docs/research/tanstack-ai-voice.md` lines 18, 47-58             |
| Gemini has no transcription adapter; its models accept audio in `chat()` if asked to transcribe                                                                                                                                  | same file, line 58                                               |
| `CONTEXT.md` has Provider, Model, Provider credentials and Image Model (a Model a user picks for Generated images, independent of their Bots' Models, falling back to a Host default). **There is no transcription Model term.** | `CONTEXT.md` lines 27-40, 103-105                                |

ADR 0028 only records computer use and which TanStack AI 1.0 packages are not adopted; it says nothing about transcription. ADR 0023 (Sign in with ChatGPT) matters because a linked ChatGPT plan reaches only the Models the plan offers and is used only when the user has no OpenAI API key (`CONTEXT.md` line 36). **Whether a ChatGPT plan can call the transcription endpoint is unverified**; assume it cannot, so transcription needs an OpenAI API key or a Host key.

## Provider and Model options

| Option                                                                | Input formats                                          | Notes                                                                                                            | Source                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| OpenAI `gpt-transcribe`                                               | mp3, mp4, mpeg, mpga, m4a, wav, webm; 25 MB            | The recommended current model, with `prompt`, `keywords`, `languages` options. TanStack support **unverified**   | [OpenAI guide](https://developers.openai.com/api/docs/guides/speech-to-text)          |
| OpenAI `gpt-4o-mini-transcribe` / `gpt-4o-transcribe`                 | same                                                   | Supported by `openaiTranscription` now; deprecated, ends 2027-02-26. Earlier research: $0.003/min and $0.006/min | OpenAI guide; `docs/research/tanstack-ai-voice.md` line 78                            |
| OpenAI `whisper-1`                                                    | same                                                   | Deprecated, same date. $0.006/min                                                                                | same                                                                                  |
| Groq `whisper-large-v3-turbo`                                         | flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm; 25 MB | **Takes Ogg directly.** Needs a Groq key, a second Provider credential                                           | `docs/research/tanstack-ai-voice.md` line 86 (not re-fetched)                         |
| Cloudflare, Grok `grok-stt`, BytePlus, ElevenLabs `scribe_v2`, fal.ai | varies                                                 | Listed in TanStack's doc; input formats not checked                                                              | [TanStack transcription doc](https://tanstack.com/ai/latest/docs/media/transcription) |
| Gemini via `chat()` with an audio part                                | audio                                                  | A chat Run, not `generateTranscription`; 32 tokens/s. Ogg support unverified here                                | `docs/research/tanstack-ai-voice.md` line 58                                          |

Common rule: transcription works only when the user (or Host) has credentials for one of those Providers. A user whose only Provider is Anthropic or OpenRouter gets no transcription.

## Voice note formats per platform

| Platform           | Voice note shape                                                                                                                                                                                                                                                                                                                                     | Size limit                                                         | Source                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Telegram           | `Voice` object with `file_id`, `duration`, optional `mime_type` ("as defined by the sender", may be absent) and `file_size`. The container is **not stated** for inbound voice on the page read; `sendVoice` takes Ogg/Opus, MP3 or M4A and Telegram voice notes are Ogg/Opus in practice (**unverified for inbound**)                               | `getFile` downloads up to 20 MB                                    | [Bot API](https://core.telegram.org/bots/api#voice); `docs/research/messaging-channel-apis.md` lines 33-34 |
| Discord            | Message flag `IS_VOICE_MESSAGE` (1 << 13), exactly one audio attachment with `duration_secs` and `waveform`. Clients upload **mono, 48 kHz, 32 kbps Opus in an Ogg container**; Discord calls the encoding an implementation detail that may change                                                                                                  | not found                                                          | [Discord message resource](https://docs.discord.com/developers/resources/message)                          |
| WhatsApp Cloud API | Inbound media arrives as a media id; `GET /MEDIA_ID` returns a URL that **expires after 5 minutes**; download with the Bearer token. Supported audio: aac, amr, mp3, m4a, and `audio/ogg` with **Opus codecs only, mono**                                                                                                                            | 16 MB per audio type; inbound files over 100 MB raise error 131052 | [WhatsApp media reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media)        |
| Slack              | File object with `url_private_download` (Bearer token, `files:read`; `docs/research/messaging-channel-apis.md` line 53). The file object doc does not mention voice clips, `slack_audio` or audio mimetypes; its filetype table lists `m4a`, `ogg`, `wav`, `webm`, and an `aac` URL field. Clip container **unverified**; read `mimetype` at runtime | not stated                                                         | [Slack file object](https://docs.slack.dev/reference/objects/file-object)                                  |
| Matrix             | `m.audio` message with an `mxc://` URL and `info.mimetype`; voice messages are flagged by an extension (MSC3245). **Not confirmed**: the spec page was too long to reach the section. Element sends Ogg/Opus (unverified)                                                                                                                            | server-defined                                                     | [Matrix client-server API](https://spec.matrix.org/latest/client-server-api/)                              |
| Telnyx MMS         | Inbound `media[]` entries with `url`, `content_type`, `sha256`, `size`; the URL expires after **30 days**. Supported audio types are **not listed** on the page read. Voice notes are not a native SMS/MMS concept; an audio attachment is whatever the sender attached (AMR, M4A or MP3 are typical, unverified)                                    | not stated                                                         | [Telnyx receiving webhooks](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks)      |

Email has no voice-note concept, and Web uses browser dictation (see `docs/research/tanstack-ai-voice.md`).

## Is conversion needed?

- **OpenAI path:** yes for Telegram, Discord and WhatsApp (all Ogg/Opus), per the OpenAI guide's format list. Caveat: OpenAI's older docs listed `ogg` and the API may still accept it, but the current guide does not, so do not rely on it without a test (**unverified; one real Telegram voice file settles it**). Slack, Matrix and Telnyx are unknown until the real `mimetype` is seen; M4A, MP3 or AAC-in-MP4 would pass as is.
- **Groq path:** no conversion for Ogg, at the cost of a second Provider key.
- **Conversion options (owner decisions; nothing is added here):**
  1. **ffmpeg binary in the Host image** (for example `ffmpeg -i in.ogg out.mp3`). A system binary, not an npm dependency. Remuxing Opus into WebM without re-encoding may also work (unverified for OpenAI).
  2. **An npm ffmpeg wrapper** (`@ffmpeg/ffmpeg` WASM, `fluent-ffmpeg`): a new dependency, which `AGENTS.md` section 6 reserves for the owner.
  3. **Run ffmpeg on the user's Computer.** Ties transcription to a running Computer; a Channel message should not wait on one.
  4. **Avoid conversion** by using Groq, or by handing the audio to a chat Model that accepts it (Gemini).
- Size: Telegram's 20 MB download cap and WhatsApp's 16 MB audio cap are both under OpenAI's 25 MB cap.

## Where it plugs in (for the spec to decide)

- Inbound Channel adapters must already download media (Slack Bearer, WhatsApp 5-minute URL, Telnyx 30-day URL), so the voice note is a file before any transcription step. WhatsApp's 5-minute URL means download immediately.
- Transcription could mirror Image Model: a user-picked Model with a Host default, independent of the Bot's chat Model. That would be a new `CONTEXT.md` term (a name like "Transcription Model" is the owner's call).
- Cost: duration is known up front (Telegram `duration`, Discord `duration_secs`), so a Quota check before the call is possible, as in `docs/research/tanstack-ai-voice.md` line 99.

## Decisions for the owner

1. Provider and Model: OpenAI `gpt-4o-mini-transcribe` now (works in the installed adapter, deprecated 2027-02-26), `gpt-transcribe` (current, adapter support unverified), or Groq to avoid conversion.
2. Conversion: ffmpeg binary in the Host image, an npm wrapper (new dependency), or avoid it with Groq.
3. Whether to add a Transcription Model setting like Image Model, or use the user's OpenAI credentials with a Host constant.

## Open items

- Does `openaiTranscription` in installed 1.0.0 accept `gpt-transcribe`? Read the adapter's model union after `pnpm install`.
- Does the OpenAI endpoint still accept Ogg/Opus? Test with one real Telegram voice file.
- Slack voice clip mimetype, Matrix voice message shape and Telnyx MMS audio types: read at runtime or fetch the full spec sections.
- Whether a linked ChatGPT plan (ADR 0023) can call transcription.

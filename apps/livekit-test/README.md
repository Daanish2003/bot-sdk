# LiveKit Voice agent

The reference Voice agent: a program outside the product that holds a phone call on LiveKit and runs the conversation with its own model. It is separate from the pnpm workspace, and nothing in `apps/web` or the packages depends on it.

It works against the product's voice routes: connect phone calls on a Representative's Channels, then set `VOICE_HOOK_URL` to the Hook URL shown there and `VOICE_HOOK_SECRET` to its secret. To try it with no product running, `src/stand-in-hooks.ts` answers the same routes locally with a fixed Representative.

## Setup

1. Create a LiveKit Cloud project, get a phone number, and add a [dispatch rule](https://docs.livekit.io/telephony/accepting-calls/dispatch-rule.md) of type `individual` for it.
2. From this folder, install with `pnpm install`.
3. Create `.env` here:

| Variable                   | Value                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| `LIVEKIT_URL`              | From the LiveKit project                                                   |
| `LIVEKIT_API_KEY`          | From the LiveKit project                                                   |
| `LIVEKIT_API_SECRET`       | From the LiveKit project                                                   |
| `VOICE_HOOK_SECRET`        | The voice account's secret, or for the stand-in any long string            |
| `VOICE_HOOK_URL`           | The voice account's Hook URL, default the `http://localhost:4100` stand-in |
| `VOICE_HOOK_PORT`          | Optional, the stand-in's port, default `4100`                              |
| `STAND_IN_DECLINE_CALLERS` | Optional, comma-separated `+E.164` numbers the stand-in declines           |
| `LLM_MODEL`                | Optional LiveKit Inference model, default `openai/gpt-5.4-mini`            |
| `STT_MODEL`                | Optional LiveKit Inference model, default `deepgram/nova-3`                |
| `TTS_MODEL`                | Optional LiveKit Inference model, default `cartesia/sonic-3`               |

## Run

Against the product, from this folder:

```
pnpm agent
```

Against the stand-in, in two terminals:

```
pnpm hooks
pnpm agent
```

Then call the number. Both terminals log what the real-call test records.

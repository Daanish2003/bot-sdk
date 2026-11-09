# LiveKit Voice agent

The reference Voice agent: a program outside the product that holds a phone call on LiveKit and runs the conversation with its own model. It is separate from the pnpm workspace, and nothing in `apps/web` or the packages depends on it.

Until the product serves the voice routes, `src/stand-in-hooks.ts` answers them locally with a fixed Representative.

## Setup

1. Create a LiveKit Cloud project, get a phone number, and add a [dispatch rule](https://docs.livekit.io/telephony/accepting-calls/dispatch-rule.md) of type `individual` for it.
2. From this folder, install with `pnpm install`.
3. Create `.env` here:

| Variable                   | Value                                                            |
| -------------------------- | ---------------------------------------------------------------- |
| `LIVEKIT_URL`              | From the LiveKit project                                         |
| `LIVEKIT_API_KEY`          | From the LiveKit project                                         |
| `LIVEKIT_API_SECRET`       | From the LiveKit project                                         |
| `VOICE_HOOK_SECRET`        | Any long random string, the same for the agent and the stand-in  |
| `VOICE_HOOK_URL`           | Optional, default `http://localhost:4100`                        |
| `VOICE_HOOK_PORT`          | Optional, the stand-in's port, default `4100`                    |
| `STAND_IN_DECLINE_CALLERS` | Optional, comma-separated `+E.164` numbers the stand-in declines |
| `LLM_MODEL`                | Optional LiveKit Inference model, default `openai/gpt-5.4-mini`  |
| `STT_MODEL`                | Optional LiveKit Inference model, default `deepgram/nova-3`      |
| `TTS_MODEL`                | Optional LiveKit Inference model, default `cartesia/sonic-3`     |

## Run

In two terminals, from this folder:

```
pnpm hooks
pnpm agent
```

Then call the number. Both terminals log what the real-call test records.

# Surface options for the Host (mobile, desktop, voice)

Research for issue #959 (child of the map #953). Researched on 2026-10-29 against `main` at `eb6bfc6d` and the packages installed in `node_modules/.pnpm` (`@tanstack/ai` 1.0.0, `ai-openai` / `ai-gemini` / `ai-grok` 1.0.0).

How to read the sources:

- **Repo sources.** Paths are relative to the repo root.
- **Package sources.** `ai/…`, `ai-openai/…` etc. are relative to `node_modules/@tanstack/<package>/src/` of the 1.0.0 install.
- **External sources.** Vendor docs and pricing pages, fetched 2026-10-29. Each claim links its page.
- **Unverified.** Nothing here was built or run. Claims resting on memory or a secondary source are marked **unverified**.
- The repo is a lab and is never deployed (map #953 "Out of scope"). Every option below that adds a dependency is an owner decision (AGENTS.md section 6). This file only lists the options.

---

## Summary

| Surface                   | Options                                                                                                                | Cheapest way to a working lab demo                                                      | What `@botsdk/react` / `@botsdk/ui` reuse looks like                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile                    | **PWA** (already half there) · **Expo / React Native** (native UI or Expo DOM components) · Tauri 2 mobile             | PWA: no new dependency, testable on `localhost` and on a phone over the LAN or a tunnel | PWA: 100%. Expo DOM components: the React UI in a WebView, close to 100%. Native React Native UI: `@botsdk/client` and most hooks, no `@botsdk/ui` |
| Desktop                   | **PWA install** · **Electron** · **Tauri 2**                                                                           | PWA install (Chrome/Edge "Install app"): no new dependency                              | PWA and Electron (loading the Host's URL): 100%. Tauri: 100% only if it loads the Host's URL; its bundled frontend can't be SSR                    |
| Voice in the Conversation | Browser Web Speech API · Provider STT/TTS through TanStack AI (`generateTranscription` / `generateSpeech`)             | Web Speech dictation in Chrome/Edge: free, no dependency                                | Fits the Bot model as is: speech turns into the user's Message text; the Bot's reply text can be spoken                                            |
| Realtime voice            | TanStack AI realtime (`realtimeToken` + `RealtimeClient` / `useRealtimeChat`; OpenAI, Gemini, Grok, ElevenLabs on npm) | Gemini Live free tier, browser-only, no phone number                                    | Does **not** go through the Bot's Turn; it is a second agent loop (see section 4.2)                                                                |
| Phone calls               | Twilio number + Media Streams to our own WebSocket · Twilio SIP trunk to OpenAI Realtime SIP                           | Twilio trial ($15 credit, no card) + a tunnel to the dev server                         | A Channel (CONTEXT.md lists "phone calls"); same Turn question as realtime voice                                                                   |

Main points:

1. **Mobile and desktop are mostly packaging, not new UI.** `apps/web` already ships a web app manifest and a service worker, and `@botsdk/react` talks to the Bot SDK over plain `fetch` (oRPC) plus `EventSource`. Any shell that runs the web Host (PWA, Electron, Tauri loading a URL, an Expo DOM component) reuses the whole Conversation UI.
2. **The one real fork is native React Native UI.** `@botsdk/ui` renders DOM elements, so a native RN app would rewrite the UI and reuse only `@botsdk/client` and the headless parts of `@botsdk/react`.
3. **Voice splits in two.** Dictation and read-out keep the Bot's Turn untouched (text in, text out). Realtime speech-to-speech and phone calls put a second model loop in front of the Bot. Reading the Bot's tools, Safety reviewer and Memory through that loop is the open design question; the research can't decide it.
4. **TanStack AI 1.0's realtime token adapters read the API key from the server's env only**, not from a per-user Credential, so per-user keys would need our own token endpoint (section 4.2).

---

## 1. What the Host already has

| Fact                                                                                                                                                                                                                                                                                  | Source                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web` is a TanStack Start app (SSR, `vite dev`/`vite build`)                                                                                                                                                                                                                     | `apps/web/package.json`                                                                                                            |
| It ships a web app manifest (`display: standalone`, icons incl. maskable) and registers `/sw.js` in production builds                                                                                                                                                                 | `apps/web/public/manifest.webmanifest`, `apps/web/src/lib/service-worker.ts`, `apps/web/src/routes/__root.tsx` (`rel: "manifest"`) |
| The SDK's HTTP layer is one fetch handler under `/api/chat`; it reads the user from the Better Auth session cookie                                                                                                                                                                    | `apps/web/src/services.ts` (`createHttpHandler(sdk, { basePath, getUser })`), `packages/botsdk/bot/src/http/handler.ts`            |
| `@botsdk/client` is headless: an oRPC client over `fetch` with `@orpc/tanstack-query` utils; no DOM                                                                                                                                                                                   | `packages/botsdk/client/src/chat-client.ts`, `packages/botsdk/client/package.json`                                                 |
| `@botsdk/react` is hooks plus a provider over `@tanstack/react-query`; its only browser globals are in `bot/bot-sync.ts` (`window` focus, `document.visibilityState`, `EventSource`, guarded by `typeof EventSource !== "undefined"`) and `bot/helpers.ts` (`window.location.origin`) | grep over `packages/botsdk/react/src`                                                                                              |
| `@botsdk/ui` is React DOM components (lucide-react, sonner, `react-dom`, a `theme.css`)                                                                                                                                                                                               | `packages/botsdk/ui/package.json`, `packages/botsdk/ui/src`                                                                        |
| The live view's Screen uses a WebSocket under the same base path                                                                                                                                                                                                                      | `packages/botsdk/bot/src/http/screen-socket.ts`, `apps/web/src/services.ts`                                                        |
| No voice code exists today (no `SpeechRecognition`, `speechSynthesis`, `getUserMedia`, `generateSpeech`, `generateTranscription`)                                                                                                                                                     | grep over `packages/botsdk` and `apps/web/src`                                                                                     |
| ADR 0027 removed the assistant's "read aloud"                                                                                                                                                                                                                                         | `docs/adr/0027-bot-only-platform.md` line 18                                                                                       |
| CONTEXT.md: a **Channel** is "the user's apps (web, desktop, mobile), Slack, email, webhooks, schedules or phone calls. Every app the user opens shows the same Conversation."                                                                                                        | `CONTEXT.md` (Channel)                                                                                                             |

So in the domain, mobile, desktop and phone are all Channels. The apps show the same Conversation; a phone call is a Channel that talks.

---

## 2. Mobile

### 2.1 PWA (no new dependency)

- The manifest and service worker are already there (section 1), so Android Chrome can install it today. **Unverified**: not tried on a device.
- iOS / iPadOS 16.4 added Web Push and the Badging API for Home Screen web apps. Push needs the app added to the Home Screen and a permission request "in response to direct user interaction" ([WebKit blog](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)).
- Microphone in the PWA: `getUserMedia` works in a secure context. Web Speech dictation is weak on mobile: no Firefox, and Safari needs Siri on (see `docs/research/tanstack-ai-voice.md` section 4).
- **Cost:** none. **Local testing:** `localhost` counts as a secure context on the dev machine. A phone needs HTTPS, so it needs a tunnel or a LAN certificate (**unverified** detail: the service worker only registers in production builds, so `vite build && vite preview` behind the tunnel).
- **Reuse:** all of `@botsdk/ui` and `@botsdk/react`.

### 2.2 Expo / React Native

Two ways to use it:

1. **Expo DOM components (`'use dom'`).** A file marked `'use dom'` "is replaced with a proxy reference imported at runtime" and runs in a WebView inside the native app. Limits: data crosses "only through an asynchronous JSON transport system", SPA only ("no SSR or SSG"), no `children` passed in, function props must be async, and the WebView's JS is "slower to parse and start up than optimized Hermes bytecode". From SDK 56 it uses `@expo/dom-webview` with no extra install ([Expo DOM components](https://docs.expo.dev/guides/dom-components/)). **Reuse:** the Conversation UI (`@botsdk/ui` + `@botsdk/react`) inside a DOM component, with native screens around it for sign-in, push and the mic.
2. **Native React Native UI.** `@botsdk/client` (oRPC over `fetch`) should run unchanged. `@botsdk/react`'s query hooks too, except `bot-sync.ts`, which would need a React Native path for `window`/`document` and for `EventSource` (React Native has no built-in `EventSource`, **unverified**; today's guard just skips the live hints). `@botsdk/ui` can't be reused, so every view is rewritten.

**Auth.** Better Auth has an Expo integration: `@better-auth/expo` (server plugin `expo()`, client `expoClient`). The session is cached "in SecureStore"; for your own endpoints you "have to retrieve the session cookie from `SecureStore` and manually add it to your request headers", with `credentials: "omit"`. The app's scheme (for example `myapp://`) goes in `trustedOrigins`, and `exp://` wildcards "should only be used in development" ([Better Auth Expo](https://www.better-auth.com/docs/integrations/expo)). So `createChatClient` would need a `fetch` that adds the cookie, which the `BotSdkFetch` type already allows (`packages/botsdk/client/src/chat-client.ts`).

**Cost and local testing.** Expo and Expo Go are free (**unverified** for current terms). On iOS a free Apple account can install on your own device from Xcode (3 devices, 3 apps per device, profiles expire after 7 days); TestFlight, App Store and certificates need the paid Developer Program ([Apple memberships](https://developer.apple.com/support/compare-memberships/)), $99 a year (**unverified**, the page doesn't list the price). Native push on iOS needs the paid program (the page says advanced capabilities need it). Android needs no paid account for local installs (**unverified**).

### 2.3 Tauri 2 mobile

Tauri 2 targets "all major desktop and mobile platforms" ([Tauri start](https://v2.tauri.app/start/)) and uses Android System WebView on Android and WKWebView on iOS ([webview versions](https://v2.tauri.app/reference/webview-versions/)). It brings Rust, Xcode and Android Studio toolchains and the same SSR limit as on desktop (section 3.3 below). It gives little over a PWA or Expo DOM components for this Host. **Unverified:** not tried.

### Mobile comparison

|                  | PWA                                    | Expo DOM components                                     | Expo native UI                              | Tauri 2 mobile                  |
| ---------------- | -------------------------------------- | ------------------------------------------------------- | ------------------------------------------- | ------------------------------- |
| New dependencies | none                                   | Expo, React Native, `@better-auth/expo`                 | same                                        | Tauri CLI + Rust                |
| UI reuse         | all                                    | Conversation UI in a WebView                            | `@botsdk/client` + most hooks; UI rewritten | all, if it loads the Host's URL |
| Push             | Web Push (iOS 16.4+, Home Screen only) | native (paid Apple program on iOS)                      | native                                      | plugin (**unverified**)         |
| Local testing    | browser; phone over HTTPS tunnel       | Expo Go / dev build on device                           | same                                        | emulator / device               |
| Cost             | free                                   | free on Android; iOS dev free with limits, store $99/yr | same                                        | same as native                  |

---

## 3. Desktop

### 3.1 PWA install

The same manifest and service worker make it installable in Chrome and Edge (**unverified**: not tried). No dependency, full reuse, no tray, global shortcut or OS-level mic permission prompt beyond the browser's.

### 3.2 Electron

- Ships Chromium and Node. It can load the running Host's URL in a window, so SSR, cookies and the whole UI keep working.
- Security, from Electron's checklist: "Under no circumstances should you load and execute remote code with Node.js integration enabled"; "Enable context isolation in all renderers"; "You should enable the sandbox in all renderers". `nodeIntegration` is off by default since 5.0.0, `contextIsolation` on since 12.0.0, sandbox on since 20.0.0 ([Electron security](https://www.electronjs.org/docs/latest/tutorial/security)). Native parts (tray, notifications, a global push-to-talk key) go through a preload script and `contextBridge`.
- **Cost:** free. **Local testing:** runs on the dev machine against `localhost`. The app is large because it bundles Chromium (**unverified**, no size measured).

### 3.3 Tauri 2

- Uses the OS webview: WebView2 (Chromium) on Windows, WKWebView on macOS, WebKitGTK on Linux ([webview versions](https://v2.tauri.app/reference/webview-versions/)). "A minimal Tauri app can be less than 600KB" ([Tauri start](https://v2.tauri.app/start/)).
- "Tauri does not natively support server based alternatives (such as SSR)"; it wants SSG, SPA or MPA ([Tauri frontend](https://v2.tauri.app/start/frontend/)). Our Host is TanStack Start with SSR and server functions, so a bundled Tauri frontend would need an SPA build of the client part pointed at a remote `/api/chat`. Loading the Host's URL in the Tauri window avoids that (**unverified**: the frontend page doesn't cover remote URLs).
- macOS and Linux render with WebKit, so the UI must be tested there too (Safari-class quirks in `@botsdk/ui`).
- **Cost:** free. **Local testing:** needs the Rust toolchain and, on Windows, WebView2 (preinstalled on Windows 11).

### Desktop comparison

|                                       | PWA install    | Electron                  | Tauri 2                                                 |
| ------------------------------------- | -------------- | ------------------------- | ------------------------------------------------------- |
| New dependencies                      | none           | `electron` (+ a packager) | Tauri CLI, Rust toolchain                               |
| Engine                                | user's browser | bundled Chromium          | OS webview (Chromium on Windows, WebKit on macOS/Linux) |
| SSR Host as is                        | yes            | yes (loads the URL)       | only by loading the URL; bundled frontend can't be SSR  |
| UI reuse                              | all            | all                       | all                                                     |
| Native extras (tray, global shortcut) | no             | yes, via preload          | yes, via Rust/plugins                                   |
| Size                                  | none           | large (bundles Chromium)  | small (< 600 KB minimal)                                |

---

## 4. Voice

### 4.1 Speech in the Conversation (dictation and read-out)

Already researched in `docs/research/tanstack-ai-voice.md` (#234, on `@tanstack/ai` 0.66). The short version, still relevant:

- **Browser Web Speech API.** `speechSynthesis` works in every major browser and is free. `SpeechRecognition` is free, but Chrome and Edge send audio to the vendor's server unless `processLocally` is used; Firefox has none in release; Safari needs Siri.
- **Provider STT/TTS through TanStack AI.** `generateTranscription` and `generateSpeech` are one-shot (no audio streaming). Transcription on OpenAI, Groq, Grok, Cloudflare, BytePlus, Lovable; speech also on Gemini. Current prices for two cheap models: `gpt-4o-mini-transcribe` about $0.003 per minute, `gpt-4o-mini-tts` $0.60 per 1M text tokens + $12 per 1M audio tokens ([OpenAI pricing](https://developers.openai.com/api/docs/pricing)).
- **Fit with the Bot.** A dictated Message is just the user's Message text; a spoken reply is the SendToUser text read out. The Turn, Safety reviewer and tools don't change. ADR 0027 removed the assistant's read aloud, so a spoken reply for the Bot would be a new decision, not a restore.
- **Not re-verified:** that file's adapter tables are for 0.66; the 1.0 adapters were not re-checked here.

### 4.2 Realtime voice (speech to speech)

TanStack AI 1.0 has a realtime layer:

- **Server:** `realtimeToken({ adapter })` returns a `RealtimeToken` (`provider`, ephemeral `token`, `expiresAt`, `config`) (`ai/realtime/types.ts`).
- **Client:** a `RealtimeAdapter.connect(token, clientTools)` returns a `RealtimeConnection` with `startAudioCapture`, `sendText`, `sendImage`, `sendToolResult`, `updateSession`, `interrupt` and events `transcript`, `tool_call`, `message_complete`, `interrupted`, `usage`, `go_away` (`ai/realtime/types.ts`). `@tanstack/ai-client` exports `RealtimeClient` and `@tanstack/ai-react` exports `useRealtimeChat` (seen in the installed `ai-client` 0.39 / `ai-react` 0.30 sources; both are at 1.0.0 on npm per `pnpm view`). Neither is a dependency of the repo today.
- **Adapters in the installed 1.0 packages:** OpenAI (WebRTC, `ai-openai/realtime/adapter.ts` uses `RTCPeerConnection`; models `gpt-realtime` … `gpt-realtime-2.1-mini`, `ai-openai/realtime/types.ts`), Gemini (WebSocket, `ai-gemini/realtime/client.ts`), Grok (WebRTC, `ai-grok/realtime/adapter.ts`). `@tanstack/ai-elevenlabs` 1.0.0 exists on npm (**unverified** that it has realtime; the core comment names "OpenAI, ElevenLabs, etc.").
- **Keys:** `openaiRealtimeToken` reads the key with `getOpenAIApiKeyFromEnv()` and takes only `model` as an option; Gemini and Grok do the same with their env helpers (`ai-openai/realtime/token.ts`, `ai-gemini/realtime/token.ts`, `ai-grok/realtime/token.ts`). A user's own Provider Credential would need our own token endpoint that calls the vendor (for OpenAI, a `POST https://api.openai.com/v1/realtime/client_secrets` with `{ session: { type: "realtime", model } }`, as `token.ts` does).
- **Prices:** OpenAI `gpt-realtime` / `-2` / `-2.1` audio $32 in / $0.40 cached / $64 out per 1M tokens; the `-mini` models $10 / $0.30 / $20 ([OpenAI pricing](https://developers.openai.com/api/docs/pricing)). Gemini 2.5 Flash Native Audio (Live) $3 in / $12 out per 1M audio tokens on paid tier, **with a free tier**; Gemini 3.1 Flash Live Preview about $0.005/min in and $0.018/min out, also with a free tier ([Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)).
- **Local testing:** browser-only on `localhost` (mic needs a secure context). Gemini's free tier makes it free.
- **Mobile:** works in a PWA or an Expo DOM component's WebView if that WebView has WebRTC/mic (**unverified**). Native React Native has no `RTCPeerConnection` without a WebRTC module (**unverified**), so the OpenAI and Grok adapters wouldn't run there as is.

**The design question for #962 (not decided here).** A realtime session is its own model loop: the realtime model hears the user, calls tools and speaks. Our Bot works by Turns on the durable runner, talks only through SendToUser, and its risky calls go through the Safety reviewer (CONTEXT.md). Ways to join them, as options only:

- **A. Realtime model as a voice front end that hands work to the Bot.** It gets one client tool such as "send to Bot", which sends the user's words as a Message and speaks back what SendToUser sends. The Bot's tools and Safety stay where they are; the realtime model only talks. Latency is that of a Turn.
- **B. Cascade: STT → Bot Turn → TTS.** No realtime model. Simplest and cheapest, slowest feel, works with any Provider that has STT/TTS (section 4.1).
- **C. Realtime model as the Bot.** Give the realtime session the Bot's instructions and tools. Fastest feel, but it bypasses the runner, Turns, checkpoints and the Safety reviewer, so most of the Bot SDK would have to be rebuilt around it.

### 4.3 Phone calls

Two routes, both on a Twilio number:

1. **Twilio Media Streams to our own server.** TwiML `<Connect><Stream>` opens a bidirectional WebSocket from Twilio to us; "A Call can have only one bidirectional Stream active at a time", and our firewall must allow WebSockets on 443 from Twilio; requests carry an `X-Twilio-Signature` to validate ([Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams)). Audio is "`audio/x-mulaw` with a sample rate of `8000`", base64 ([WebSocket messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages)). We then bridge to STT/TTS (option B) or to a realtime model (option A). The Host already runs a WebSocket (the Screen socket, crossws), so the mechanics are familiar.
2. **Twilio SIP trunk to OpenAI Realtime SIP.** Point the trunk at `sip:$PROJECT_ID@sip.api.openai.com;transport=tls`; OpenAI sends a `realtime.call.incoming` webhook with a `call_id`; we `POST /v1/realtime/calls/{call_id}/accept` with the session (model, voice, tools, instructions), then control it over `wss://api.openai.com/v1/realtime?call_id=…`; there are reject and hangup endpoints ([OpenAI Realtime SIP](https://developers.openai.com/api/docs/guides/realtime-sip), found by search; the page itself returned 404 to the fetcher, so **unverified** beyond the search excerpts). No audio passes through our server, but it is OpenAI-only and uses the project's key, not a user's Credential.

**Cost (Twilio US):** inbound local $0.0085/min, local number $1.15/month, Media Streams $0.0044/min; trial gives $15 with no card ([Twilio US voice pricing](https://www.twilio.com/en-us/voice/pricing/us)). SIP trunking prices weren't checked. Model minutes come on top (section 4.2).

**Local testing:** Twilio must reach a public HTTPS/WSS URL, so the dev server needs a tunnel (**unverified** choice of tunnel; any would add a tool, which is an owner decision). The OpenAI SIP route needs a public webhook too. This fits the map's Channel rule ("official, free-tier API that can be tested locally") only with a tunnel and the trial credit.

### Voice comparison

|                      | Web Speech | Provider STT/TTS                                   | Realtime (TanStack AI)                                          | Phone: Media Streams                 | Phone: OpenAI SIP              |
| -------------------- | ---------- | -------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------ | ------------------------------ |
| New dependencies     | none       | none (`@tanstack/ai` + adapters already installed) | `@tanstack/ai-client` or `ai-react`                             | Twilio account (+ tunnel)            | Twilio account + OpenAI SIP    |
| Bot's Turn unchanged | yes        | yes                                                | only with option A or B                                         | with B, or A via a bridge            | only with option A             |
| Cost                 | free       | about $0.003/min STT (OpenAI mini) + TTS by text   | OpenAI $10–$64 per 1M audio tokens; Gemini Live has a free tier | Twilio ≈ $0.013/min + number + model | Twilio trunk + OpenAI realtime |
| Local testing        | browser    | browser + key                                      | browser + key                                                   | needs public URL                     | needs public URL               |
| Per-user Credential  | n/a        | yes (adapter takes a key)                          | needs our own token endpoint                                    | depends on the bridge                | no (project key)               |

---

## 5. Open questions for #962

1. Mobile: is a PWA enough for the lab, or is a native shell wanted for native push and a background mic? If native, Expo DOM components (reuse) or native UI (rewrite)?
2. Desktop: PWA install, or a shell for tray and push-to-talk? If a shell, Electron (simplest with an SSR Host) or Tauri (small, but WebKit on macOS/Linux and no bundled SSR)?
3. Voice: which of options A, B, C (section 4.2) for live voice and phone? This decides whether the Safety reviewer and Turns stay the only path to the Bot's tools.
4. Spoken replies: ADR 0027 removed read aloud for the assistant. Does a Bot speaking its SendToUser text count as a new feature?
5. Phone: is a tunnel plus Twilio trial acceptable under the map's "testable locally" rule?

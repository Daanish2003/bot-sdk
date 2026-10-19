# Driving a Screen's Chrome from the server

Research for [#563](https://github.com/Daanish2003/ai-chat/issues/563), a child of map [#417](https://github.com/Daanish2003/ai-chat/issues/417) (Bot step 6, Helpers). Facts only, no pick.

Read and measured on 2026-10-19. Sources:

- Playwright `playwright-core@1.63.0`, the version `pnpm-lock.yaml` resolves for `@playwright/test ^1.63.0` (`apps/web`, `examples/next-prisma`). Source at tag [`v1.63.0`](https://github.com/microsoft/playwright/tree/v1.63.0), the published types at [`unpkg.com/playwright-core@1.63.0/types/types.d.ts`](https://unpkg.com/playwright-core@1.63.0/types/types.d.ts) (`PW/types.d.ts` below), and `v1.64.0` where noted. npm's `latest` is `1.64.1` (published 2026-10-14); `1.64.0` came out 2026-10-07.
- E2B runtime, `e2b-dev/runtime` at commit [`bfaaf659`](https://github.com/e2b-dev/runtime/tree/bfaaf65933f7572f384e7e2411b616bb2bc3d793) (2026-10-19). Links below use `RT/` for that tree. Embed's local install is from `4f35ab01` (see [Self-host E2B locally](https://github.com/Daanish2003/ai-chat/issues/504)); the files cited here were not compared between the two commits.
- `e2b` JS SDK `2.55.0`, the version `packages/bot-sdk` pins on `feature/bot-step-5`: [`unpkg.com/e2b@2.55.0/dist/index.d.ts`](https://unpkg.com/e2b@2.55.0/dist/index.d.ts) and `dist/index.mjs`.
- E2B docs at `docs.e2b.dev` (the `.md` form of each page), and `@e2b/claude-toolsets@0.0.2` (npm, 2026-10-07), E2B's own package that drives Chrome in a sandbox over CDP from outside it.
- Chromium `content/browser/devtools/devtools_http_handler.cc` at tag [`153.0.8010.12`](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/content/browser/devtools/devtools_http_handler.cc), the Chrome for Testing build that Playwright 1.63.0 downloads.

Earlier findings not repeated here: [Computer-use control stack](https://github.com/Daanish2003/ai-chat/issues/390) (ARIA snapshots, token costs), [E2B SDK and envd](https://github.com/Daanish2003/ai-chat/issues/503) (commands, pause), [Self-host E2B locally](https://github.com/Daanish2003/ai-chat/issues/504) (Embed install, ports).

**What was measured and what was only read.** Local E2B Embed was not reachable from this session: `localhost:3000` and `:3002` refused connections, and starting it needs `wsl`, which this agent's sandbox refused. So nothing here ran through E2B. The Playwright half was measured on the owner's Windows machine, with Playwright 1.63.0 attached over CDP to a Chrome for Testing 153 that it did not launch, through a WebSocket relay that adds a fixed delay (section 4). Every E2B statement is from source and docs.

## 1. Summary

- **CDP from the server works in principle on Embed, from source.** envd forwards any TCP port that a guest process binds on `127.0.0.1` (Chrome's DevTools port included) to the sandbox's address. client-proxy on `:3002` routes by `E2b-Sandbox-Id` / `E2b-Sandbox-Port` headers when the Host is `localhost` or an IP. The proxy relays WebSockets. Playwright's `connectOverCDP` sends its `headers` option on both the `/json/version` fetch and the WebSocket handshake. Not run end to end.
- **What protects the port:** only `network.allowPublicTraffic: false`, set when the sandbox is created. Then the orchestrator proxy wants the `e2b-traffic-access-token` header on every non-envd port. Without it, anyone who can reach `:3002` and knows the sandbox id drives the browser. Step 5's `e2bProvider` creates Computers without a `network` option, and the SDK default is public.
- **ARIA refs at 1.63.0:** `page.ariaSnapshot({ mode: "ai" })` exists and works over `connectOverCDP` (measured). `page.getByRef()` does not exist in 1.63.0; it was added in 1.64.0 as `this.locator(\`aria-ref=${ref}\`)`. The `aria-ref=`selector engine is built into 1.63.0, and`page.locator("aria-ref=e5")` worked over CDP (measured).
- **Refs live in one connection.** A ref from one `connectOverCDP` connection did not resolve on a second connection to the same page, or after a reload, until a new snapshot was taken (measured).
- **Latency is round trips times RTT.** Over CDP, each Playwright call costs one to eight sequential round trips, for example a repeated `ariaSnapshot` about 1, `fill` about 6, `click` about 8, `screenshot` about 7 at a 50 ms RTT (measured, table in section 4). The RTT of the Embed path (Windows, then WSL port forward, client-proxy, orchestrator proxy, guest `socat`, Chrome) was not measured.
- **In-sandbox driver through envd:** a fresh `node` process per action paid about 0.4 to 0.55 s here, most of it loading `playwright-core` (about 0.3 s). Playwright 1.63.0's bundled `playwright-cli` keeps a daemon, so refs survive between commands; each command took about 0.4 to 0.5 s and a `click` 1.2 s (measured on Windows, not in a 2 vCPU sandbox).
- **The template:** server-side CDP needs Chrome (with its system libraries) in the template, and `playwright-core` on the server. An in-sandbox driver needs Node 20+, `playwright-core` and the Chrome build that matches it (Chrome for Testing 153.0.8010.12 for 1.63.0, a 196 MB zip, or the 120 MB headless shell). Today's `ai-chat-computer-v2` has none of these: it is Debian bookworm with no Node, and 2.3 GB free.

## 2. Server-side Playwright over CDP, through E2B

### The path a CDP message takes on Embed

1. **Chrome in the guest** listens on `127.0.0.1:<port>` when started with `--remote-debugging-port`. `@e2b/claude-toolsets` starts it this way through `commands.run(..., { background: true, timeoutMs: 0 })` and notes "Chrome binds 127.0.0.1:9222 only, and envd forwards localhost ports, so the E2B proxy reaches it." ([`dist/sandbox.js` L1-L18, L76-L95, L123-L185](https://unpkg.com/@e2b/claude-toolsets@0.0.2/dist/sandbox.js))
2. **envd's port forwarder** scans open TCP ports on `127.0.0.1` every 1000 ms and starts one `socat` per port, `TCP4-LISTEN:<port>,bind=<sandbox IP>,fork TCP4:localhost:<port>`. ([RT/packages/envd/internal/port/forward.go L1-L3, L184](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/packages/envd/internal/port/forward.go#L1-L3); [RT/packages/envd/main.go L44](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/packages/envd/main.go#L44)) `socat` is in the packages that every template build installs for Debian and Ubuntu. ([RT/packages/orchestrator/pkg/template/build/phases/base/distro/distro.go L54-L58](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/packages/orchestrator/pkg/template/build/phases/base/distro/distro.go#L54-L58))
3. **The orchestrator proxy** (`PROXY_PORT: "5007"` on Embed) checks the traffic token, applies `maskRequestHost`, and forwards to `<slot IP>:<port>`. ([RT/packages/orchestrator/pkg/proxy/proxy.go L99-L150](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/packages/orchestrator/pkg/proxy/proxy.go#L99-L150); [RT/embed/compose/compose.yaml L290](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/embed/compose/compose.yaml#L290))
4. **client-proxy** (`PROXY_PORT: "3002"`) finds the sandbox's node and forwards to the orchestrator proxy. ([RT/packages/client-proxy/internal/proxy/proxy.go L169-L275](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/packages/client-proxy/internal/proxy/proxy.go#L169-L275); [compose.yaml L548](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/embed/compose/compose.yaml#L548))
5. **Routing.** When the Host is `localhost`, an IP or `sandbox.<domain>` and an `E2b-Sandbox-Id` or `E2b-Sandbox-Port` header is present, the proxy routes by the headers. Otherwise it parses `<port>-<sandboxId>.<domain>` from the Host. ([RT/packages/shared/pkg/proxy/host.go L17-L72, L111-L112](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/packages/shared/pkg/proxy/host.go#L17-L72)) `getHost()` returns `*.e2b.app`, which does not resolve on Embed, so headers on `:3002` are the way in ([E2B SDK and envd](https://github.com/Daanish2003/ai-chat/issues/503)).
6. **WebSockets.** Both proxies are `httputil.ReverseProxy` ([RT/packages/shared/pkg/proxy/pool/client.go L110-L128](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/packages/shared/pkg/proxy/pool/client.go#L110-L128)). The runtime's own test `TestProxyRelaysWebSocketAcrossIdleTimeouts` drives text, binary and ping frames through the proxy, across an idle gap. ([RT/packages/shared/pkg/proxy/long_lived_test.go L221-L240](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/packages/shared/pkg/proxy/long_lived_test.go#L221-L240)) client-proxy's upstream idle timeout is 610 s. ([client-proxy proxy.go L32](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/packages/client-proxy/internal/proxy/proxy.go#L32))
7. **Pause** disconnects clients outside the sandbox ([E2B SDK and envd](https://github.com/Daanish2003/ai-chat/issues/503)), so a CDP WebSocket drops on pause. A full-memory pause keeps the Chrome process; the server reconnects after resume.

### What Chrome checks on the DevTools port

- The HTTP endpoints and the WebSocket upgrade both refuse a request whose `Host` is set but is neither an IP nor `localhost`: "Host header is specified and is not an IP address or localhost." ([devtools_http_handler.cc L119-L127, L461-L466, L516-L521](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/content/browser/devtools/devtools_http_handler.cc))
- `/json/version` builds `webSocketDebuggerUrl` as `ws://` + the request's `Host` header + `/devtools/browser/<id>`. ([L617-L627](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/content/browser/devtools/devtools_http_handler.cc))
- A WebSocket upgrade that carries an `Origin` header is refused unless `--remote-allow-origins` lists it. With no `Origin`, there is no check. ([L819-L828](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/content/browser/devtools/devtools_http_handler.cc)) Playwright 1.63.0 connected to Chrome 153 here without `--remote-allow-origins` (measured).
- From Chrome 136, `--remote-debugging-port` needs a non-default `--user-data-dir`. ([Chrome blog, "Changes to remote debugging switches"](https://developer.chrome.com/blog/remote-debugging-port))
- How these checks meet the E2B proxy: client-proxy and the orchestrator proxy pass the incoming `Host` through unchanged, unless `maskRequestHost` is set. ([pool/client.go L120-L127](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/packages/shared/pkg/proxy/pool/client.go#L120-L127)) On Embed that Host is `localhost:3002`, which Chrome accepts. On Cloud it is `9222-<id>.e2b.app`, which Chrome refuses; this is why `@e2b/claude-toolsets` requires `maskRequestHost: 'localhost:${PORT}'`. ([sandbox.js L8, L142](https://unpkg.com/@e2b/claude-toolsets@0.0.2/dist/sandbox.js))

### Playwright's `connectOverCDP` at 1.63.0

- Three overloads: `connectOverCDP(endpointURL, options)`, `connectOverCDP(transport, options)` (a `ConnectOverCDPTransport` with `send`, `close`, `onmessage`, `onclose`), and the deprecated options-object form. ([PW/types.d.ts L17346, L17376, L17410, L18219-L18225](https://unpkg.com/playwright-core@1.63.0/types/types.d.ts)) The API docs page lists only the URL form ([class-browsertype.md at v1.63.0](https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-browsertype.md#async-method-browsertypeconnectovercdp)).
- Options: `headers` ("Additional HTTP headers to be sent with connect request"), `timeout` (default 30 s), `slowMo`, `isLocal`, `noDefaults`, `artifactsDir`. ([PW/types.d.ts L25512-L25560](https://unpkg.com/playwright-core@1.63.0/types/types.d.ts))
- With an `http(s)` URL, Playwright fetches `<url>/json/version/` with those headers, takes `webSocketDebuggerUrl`, and opens it with the same headers. A `ws(s)` URL is used directly. ([chromium.ts L90-L108, L459-L475 at v1.63.0](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/chromium/chromium.ts#L90-L108)) The relay in section 4 saw the `headers` value and `User-Agent: Playwright/1.63.0` on the handshake (measured).
- From the Chrome facts above (inferred, not run): on Embed, with no `maskRequestHost`, `connectOverCDP("http://localhost:3002", { headers })` would get back `ws://localhost:3002/devtools/browser/<id>` and reconnect there with the same headers. With `maskRequestHost: 'localhost:${PORT}'`, the URL comes back as `ws://localhost:9222/...` and points at the server's own machine; `@e2b/claude-toolsets` avoids this by reading the browser path through envd (`curl http://127.0.0.1:9222/json/version` inside the sandbox) and building the `wss://` URL itself. ([sandbox.js L106-L119, L180-L184](https://unpkg.com/@e2b/claude-toolsets@0.0.2/dist/sandbox.js))
- The docs warn that CDP is "significantly lower fidelity than the Playwright protocol connection", and that "Playwright maintains a curated list of arguments for launching the browser. If you launch the browser without Playwright and do not pass the exact same arguments, some of Playwright functionality may be broken upon connecting to the browser." ([PW/types.d.ts L17317-L17333](https://unpkg.com/playwright-core@1.63.0/types/types.d.ts))
- The Playwright-protocol alternative, `browserType.connect()` to a `launchServer` or `playwright run-server`, needs the client's major and minor version to match the server's ("1.2.3 → is compatible with 1.2.x"). ([class-browsertype.md L88-L96 at v1.63.0](https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-browsertype.md#async-method-browsertypeconnect); [docker.md, Remote Connection](https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/docker.md#remote-connection))

### What protects the port

- **Public by default.** "By default, a sandbox's public URLs are reachable by anyone who knows them... any service listening on a sandbox port answers requests from anyone who has the URL." ([Sandbox public URL](https://docs.e2b.dev/network/public-url)) In SDK 2.55.0, `allowPublicTraffic` is documented `@default true`. ([e2b@2.55.0 dist/index.d.ts L8998-L9008](https://unpkg.com/e2b@2.55.0/dist/index.d.ts))
- **Traffic token.** With `network: { allowPublicTraffic: false }` at create, the sandbox has `trafficAccessToken`, and every request to a non-envd port must send `e2b-traffic-access-token`. Missing gives 403. ([Restricting public access](https://docs.e2b.dev/network/restrict-public-access)) The orchestrator proxy compares it in constant time and skips the check only on envd's port 49983, which has its own token. CORS preflights fail it too. ([RT/packages/orchestrator/pkg/proxy/proxy.go L99-L114](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/packages/orchestrator/pkg/proxy/proxy.go#L99-L114))
- **The token survives reconnects.** `Sandbox.connect()` copies `trafficAccessToken` from the API response, so a resumed Computer still has it. ([e2b@2.55.0 dist/index.mjs L4995-L5002, L5757-L5772](https://unpkg.com/e2b@2.55.0/dist/index.mjs))
- **Fixed at create.** Network options "cannot be changed after the sandbox is created" ([Sandbox public URL, HTTPS ports](https://docs.e2b.dev/network/public-url)). `@e2b/claude-toolsets` refuses a sandbox without a traffic token. Its reason: "loopback is not a boundary on E2B (FEAT-66), so an open CDP port would be remote control of the browser for anyone with the host name." ([sandbox.js L9-L11, L150-L155](https://unpkg.com/@e2b/claude-toolsets@0.0.2/dist/sandbox.js))
- **Step 5's Computers.** `e2bProvider.create` calls `Sandbox.create(template, { ...connection, timeoutMs, lifecycle: { onTimeout: "pause" } })`, with no `network` option (`packages/bot-sdk/plugins/computer/e2b/index.ts` L86-L92 on `feature/bot-step-5`). So today's Computers have public traffic on.
- **Embed's own network.** "Nothing on this stack authenticates a network peer except api's own API key and admin token check." Compose binds its ports on every host interface; the README says to expose only 3000, 3001 and 3002, to trusted clients. ([RT/embed/compose/README.md L255-L259, L385-L391](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/embed/compose/README.md#L255-L259)) Rotating Embed's hash seed invalidates the traffic and envd tokens of sandboxes that survive an api restart. ([README.md L330-L334](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/embed/compose/README.md#L330-L334))
- **Inside the browser.** `@e2b/claude-toolsets` starts Chrome with `--enable-features=LocalNetworkAccessChecks` ("refuses a public page's requests to loopback and private addresses inside the browser"), scrubs the environment with `env -i`, and keeps Chrome's sandbox on (no `--no-sandbox`) as the default `user`. ([sandbox.js L13-L17, L76-L95](https://unpkg.com/@e2b/claude-toolsets@0.0.2/dist/sandbox.js))

## 3. `ariaSnapshot({ mode: "ai" })` and `getByRef()` at the pinned version

- `page.ariaSnapshot({ mode, depth, boxes, signal, timeout })` is in 1.63.0. `mode: "ai"` returns "element references like `[ref=e2]` and snapshots of `<iframe>`s". ([PW/types.d.ts L2097-L2139](https://unpkg.com/playwright-core@1.63.0/types/types.d.ts))
- `page.getByRef()` is not in 1.63.0's types. The 1.64 release notes add it: "New `Page.getByRef` locates an element by its aria ref, such as `e2`". ([release-notes-js.md L146 at v1.64.0](https://github.com/microsoft/playwright/blob/v1.64.0/docs/src/release-notes-js.md#version-164)) At v1.64.0 it is `return this.locator(\`aria-ref=${ref}\`)`. ([client/page.ts L776-L778](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright-core/src/client/page.ts#L776-L778))
- The `aria-ref` engine is in 1.63.0's built-in selector engines, so `page.locator("aria-ref=e5")` is public there. ([server/selectors.ts L47 at v1.63.0](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/selectors.ts#L47)) It looks the ref up in `_lastAriaSnapshotForQuery`, the last snapshot that injected script instance took, and matches only if the element is still connected. ([injected/src/injectedScript.ts L245, L330, L737-L744 at v1.63.0](https://github.com/microsoft/playwright/blob/v1.63.0/packages/injected/src/injectedScript.ts#L737-L744))
- `^1.63.0` allows 1.64.x, but the lockfile resolves 1.63.0 (`pnpm-lock.yaml`: `playwright-core@1.63.0`, `playwright@1.63.0`). Only `apps/web` and `examples/next-prisma` list it, as a devDependency for tests; `packages/bot-sdk` has no Playwright dependency.

Measured over `connectOverCDP` (Playwright 1.63.0, Chrome for Testing 153.0.8010.12, headless, Windows), with `scratchpad/ref-reconnect.mjs` and `cdp-probe.mjs` ([appendix](#appendix-probes)):

| Step                                                                         | Result                                                                                 |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `page.ariaSnapshot({ mode: "ai" })`                                          | YAML with refs, e.g. `- textbox "Email" [ref=e5]`                                      |
| `page.locator("aria-ref=e5").fill()`, `.click()` on the same connection      | worked                                                                                 |
| Second `connectOverCDP` to the same page, `aria-ref=e2` with no new snapshot | timed out (2 s)                                                                        |
| Same, after that connection's own snapshot                                   | worked                                                                                 |
| After `page.reload()`, no new snapshot                                       | timed out                                                                              |
| A button whose text changed from "Go" to "done"                              | its ref changed from `e2` to `e4` in the next snapshot (seen through `playwright-cli`) |

## 4. Latency

### Per call, over CDP (measured)

`cdp-probe.mjs` puts a WebSocket relay between Playwright and Chrome. The relay delivers each frame a fixed time after it arrives, in order. The table shows medians of three runs at 0 ms and at 25 ms one way (50 ms RTT). "RTT-equivalents" is (time at 50 ms RTT − time at 0) ÷ 50 ms: the number of sequential round trips the call makes.

| Call                                     | ms, no delay | ms, 50 ms RTT | RTT-equivalents | CDP frames sent / received |
| ---------------------------------------- | ------------ | ------------- | --------------- | -------------------------- |
| `connectOverCDP(ws url)`                 | 137          | 220           | ~2              | 31 / 44                    |
| `context.newPage()`                      | 195          | 142           | — (noisy)       | 14 / 28                    |
| `page.setContent()`                      | 45           | 200           | ~3              | 2 / 11–14                  |
| `ariaSnapshot({ mode: "ai" })`, first    | 66           | 170           | ~2              | 2 / 2–5                    |
| `ariaSnapshot({ mode: "ai" })`, again    | 16           | 78            | ~1              | 1 / 1                      |
| `locator("aria-ref=…").fill()`           | 21           | 326           | ~6              | 8 / 7–10                   |
| `locator("aria-ref=…").click()`          | 259          | 648           | ~8              | 17 / 17–20                 |
| `textContent()`                          | 6            | 62            | ~1              | 1 / 2                      |
| `page.screenshot()` 1280×720 PNG (15 KB) | 131          | 491           | ~7              | 8 / 8                      |
| `page.goto(data:)`                       | 93           | 167           | ~1.5            | 1 / 19–22                  |

So a server-side step's link cost is about (round trips) × (RTT of the path). The 5.3 KB snapshot of a 50-link form fit in one frame each way.

### Per hop on Embed (read, not measured)

| Hop                                                                        | Source                                    |
| -------------------------------------------------------------------------- | ----------------------------------------- |
| Windows → `localhost:3002` → WSL2 (forwarded on `[::1]`)                   | memory note on the local Embed; not timed |
| client-proxy (Go reverse proxy, host network) → orchestrator proxy `:5007` | `RT/embed/compose/compose.yaml`           |
| orchestrator proxy → guest tap network → `socat` → Chrome on `127.0.0.1`   | `forward.go`, `proxy.go`                  |

- The orchestrator proxy retries a dial up to 5 times ("to handle port forwarding delays in sandbox envd"), client-proxy once. ([RT/packages/shared/pkg/proxy/proxy.go L44-L46](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/packages/shared/pkg/proxy/proxy.go#L44-L46); [client-proxy proxy.go L187-L188](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/packages/client-proxy/internal/proxy/proxy.go#L187-L188))
- A newly bound port is forwarded after the next 1 s scan, so the first connection can come up to about 1 s after Chrome listens.
- Once the WebSocket is up, each CDP frame crosses the same chain with no new HTTP request.
- `@e2b/claude-toolsets` says Chrome starts in "usually 3 to 5 s" on the Cloud `desktop` template, and a cold sandbox can take much longer (it waits 60 s). ([sandbox.js L21](https://unpkg.com/@e2b/claude-toolsets@0.0.2/dist/sandbox.js))
- The only Embed timings on record are API calls from Windows (create 106–334 ms, kill about 25 ms), from [Embed local setup](https://github.com/Daanish2003/ai-chat/issues/505). They do not include the sandbox traffic path.

### Per action, in-sandbox driver (measured on Windows only)

- **One `node` process per action** (`one-shot.mjs`: start Node, `require("playwright-core")`, `connectOverCDP` to a local Chrome, one snapshot): 1.58 s the first time, then 414–546 ms. Of that, `require` took 284–401 ms, `connectOverCDP` 43–50 ms and the snapshot 24–30 ms. Each process is a new connection, so refs from the previous process do not resolve (section 3).
- **`playwright-cli`, bundled in 1.63.0** (`playwright cli`, a client plus a session daemon; `cli-probe.mjs`):
  - `attach --cdp=http://127.0.0.1:<port>`: 1343 ms.
  - `snapshot`: 401–454 ms.
  - `fill e3 hello`: 476 ms.
  - `click e2`: 1239 ms.
  - `detach`: 417 ms.
  - Refs from one command resolved in the next, because the daemon keeps the connection.
- Through envd, each action also pays a `commands.run` round trip: Connect RPC through `:3002` to envd, then `/bin/bash -l -c` ([E2B SDK and envd](https://github.com/Daanish2003/ai-chat/issues/503)). Not measured on Embed. The same Node and Playwright start-up inside a 2 vCPU Firecracker VM was not measured.

## 5. The in-sandbox alternative

### Ways to run it

- **A driver script per action** through `commands.run("node driver.mjs …")`. It pays process start-up every time, and it loses refs between actions (section 3).
- **A long-lived driver in the sandbox**, started with `background: true, timeoutMs: 0`, and called per action through envd (`commands.run("curl …")`, or `sendStdin` to the process). Or it is reached on its own port through the proxy, which brings back the port questions of section 2. One connection keeps refs.
- **The bundled `playwright-cli`** is such a driver. Its commands are `open`, `attach [--cdp|--endpoint]`, `goto`, `snapshot`, `find`, `click <ref>`, `fill <ref> <text>`, `type`, `press`, `select`, `upload`, `screenshot`, `tab-*`, `state-load`, `list`, `close-all`, `kill-all` and more (`playwright cli --help`, 1.63.0). It also ships an agent skill file, `lib/tools/skills/playwright-cli/SKILL.md`.
- **`playwright mcp`** (bundled since 1.62) is an MCP server with `--cdp-endpoint`, `--cdp-header` and `--host` (default `localhost`). ([release-notes-js.md L416 at v1.64.0](https://github.com/microsoft/playwright/blob/v1.64.0/docs/src/release-notes-js.md#version-162); `playwright mcp --help`, 1.63.0)
- When the driver launches Chrome itself with `chromium.launch()`, Playwright 1.63.0 passes `--remote-debugging-pipe`, so Chrome opens no TCP port and envd has nothing to forward. ([chromium.ts L355-L360 at v1.63.0](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/chromium/chromium.ts#L355-L360)) A Chrome that must also be visible on a Screen's display, and reachable by other tools, is started separately with a port, as in section 2.

### What the control path is protected by

- envd's access token on port 49983. Secure access is always on from SDK 2.51.0, and the repo pins 2.55.0 ([Secured access](https://docs.e2b.dev/sandbox/secured-access)). The traffic-token check skips the envd port because envd has its own ([proxy.go L101-L107](https://github.com/e2b-dev/runtime/blob/bfaaf65933f7572f384e7e2411b616bb2bc3d793/packages/orchestrator/pkg/proxy/proxy.go#L101-L107)).
- Any other port a process in the sandbox binds on `127.0.0.1` is still forwarded (section 2), so a driver or Chrome with a TCP port stays reachable through `:3002` unless the sandbox has `allowPublicTraffic: false`.

## 6. Side by side

|                      | Server-side Playwright over CDP                                                                                                                                       | In-sandbox driver through envd                                                                                                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Template holds**   | Chrome and its system libraries and fonts. No Node needed.                                                                                                            | Node ≥ 20 (`playwright-core` `engines`), `playwright-core@1.63.0` (or a driver built on it), and the Chrome it was built for: Chrome for Testing 153.0.8010.12 (`chrome-linux64.zip` 195,836,009 B; `chrome-headless-shell-linux64.zip` 119,809,080 B, from `cdn.playwright.dev/builds/cft/…`), plus `playwright install-deps chromium` libraries |
| **Server holds**     | `playwright-core` as a runtime dependency (a new dependency of `packages/bot-sdk`: an owner decision)                                                                 | Only the `e2b` SDK it already has                                                                                                                                                                                                                                                                                                                 |
| **Sandbox create**   | `network.allowPublicTraffic: false`, fixed at create, so existing Computers would be recreated. On Cloud also `maskRequestHost: 'localhost:${PORT}'`.                 | No network option needed if the driver uses a pipe. A TCP port needs the same as the left column.                                                                                                                                                                                                                                                 |
| **Start-up**         | Start Chrome through `commands.run` (background, `timeoutMs: 0`). Wait up to 1 s for the port forward. Then `connectOverCDP` (31 frames sent, about 2 RTTs).          | Start Chrome and the driver daemon through `commands.run`. `playwright-cli attach` took 1.3 s here.                                                                                                                                                                                                                                               |
| **Per action**       | (round trips) × (RTT of the `:3002` chain): 1 to 8 round trips per call (section 4)                                                                                   | one envd `commands.run` round trip, plus the driver client's start-up (about 0.4 s per `playwright-cli` command here, about 0.3 s of it loading Node modules), plus near-zero RTT CDP inside the VM                                                                                                                                               |
| **Refs**             | Kept while the server holds one connection. Lost when a job ends and a new one reconnects, or on pause.                                                               | Kept while the daemon runs; it survives a full-memory pause with the sandbox. Lost with a one-shot process per action.                                                                                                                                                                                                                            |
| **Version coupling** | The server's Playwright drives whatever Chrome the template has, over CDP. The docs note lower fidelity, and that missing Playwright launch flags may break features. | The template's `playwright-core` and Chrome are matched by `playwright install`. The server's Playwright version doesn't matter.                                                                                                                                                                                                                  |
| **Tool results**     | Screenshots and snapshots arrive in the server process as Buffers and strings                                                                                         | Screenshots come back as files (`files.read`) or stdout; snapshots as stdout                                                                                                                                                                                                                                                                      |

## 7. Disk and memory notes for the template

- `ai-chat-computer-v2` is `debian:bookworm-slim` with bash, curl, git, jq, python3 and a few archive tools. "Node is still not in the template." After the tier change its root disk shows 2.8 G size and 2.3 G available. (`packages/bot-sdk/README.md` and `plugins/computer/template/Dockerfile` on `feature/bot-step-5`)
- Playwright 1.63.0 maps `debian12-x64` to the same Chrome for Testing `linux64` zip as Ubuntu 22.04 and 24.04. ([registry in the published `lib/coreBundle.js`](https://unpkg.com/playwright-core@1.63.0/lib/coreBundle.js), lines around 32876–32886)
- Playwright's Docker image `mcr.microsoft.com/playwright:v1.63.0-noble` (Ubuntu 24.04) contains the browsers and their system dependencies, but not the Playwright package. It runs browsers as `root` by default, "which will disable the Chromium sandbox". `--ipc=host` is recommended with Chromium, "Without it, Chromium can run out of memory and crash." ([docker.md L8, L38-L42, L101-L104 at v1.63.0](https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/docker.md)) E2B templates can start `fromImage()` or a single-stage Dockerfile ([E2B SDK and envd](https://github.com/Daanish2003/ai-chat/issues/503)). Whether `--ipc=host`-style shared memory matters inside a Firecracker VM was not checked; `@e2b/claude-toolsets` passes `--disable-dev-shm-usage`.
- On this machine Embed has 2 GiB of hugepages, and a second sandbox can fail to place while one runs (`packages/bot-sdk/README.md`). How much memory Chrome needs in the Computer was not measured.

## Not verified

- Any of section 2 end to end on Embed: `connectOverCDP` through `:3002` with `E2b-Sandbox-Id`/`E2b-Sandbox-Port` headers, the traffic-token 403, and the `webSocketDebuggerUrl` Host behaviour.
- The RTT of the Embed sandbox-traffic path, and envd `commands.run` latency on Embed.
- Node, `playwright-core` and Chrome start-up and per-action times inside a 2 vCPU Embed sandbox.
- Whether the Embed release installed locally (`4f35ab01`) has the same proxy, forwarder and traffic-token code as `bfaaf659`.
- Chrome's memory use in the Computer, and whether it fits the template's memory and Embed's hugepages next to Xvfb or noVNC.
- Whether Chrome's own sandbox works as the `user` in an Embed Firecracker guest (claude-toolsets reports it does on the Cloud `desktop` template, kernel 6.1).
- Playwright CDP compatibility with a Chrome other than the build it ships for (e.g. Debian's `chromium` package).
- Whether `*.localhost` Host names (`9222-<id>.localhost:3002`) resolve from Node on Windows. The proxy would route them by Host.

## Appendix: probes

Run with the repo's installed `playwright-core@1.63.0` and the Playwright-installed Chrome for Testing 153.0.8010.12 (`ms-playwright/chromium-1243`), Node 24.10.0, on Windows. The scripts live outside the repo (session scratchpad) and were not committed:

- `cdp-probe.mjs`: launches Chrome with `--remote-debugging-port`, puts an ordered fixed-delay WebSocket relay in front, connects with `connectOverCDP(wsUrl, { headers })`, and times each call at 0 and 25 ms one-way, counting frames.
- `ref-reconnect.mjs`: a snapshot on one connection, then ref lookups on a second connection, before and after its own snapshot, and after a reload.
- `one-shot.mjs`: a fresh `node` process per action, timing `require`, `connectOverCDP` and one snapshot.
- `cli-probe.mjs`: `playwright cli attach --cdp=…`, then `snapshot`, `click <ref>`, `fill <ref>` and `detach`, each as its own process.

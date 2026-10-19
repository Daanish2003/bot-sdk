# Screens and live view in the E2B template

Research for [#564](https://github.com/Daanish2003/ai-chat/issues/564), a child of map [#417](https://github.com/Daanish2003/ai-chat/issues/417) (Bot step 6, Helpers). Facts only, no pick.

Read on 2026-10-19. **Nothing here was measured.** Local E2B Embed was not reachable from this session: ports 3000 and 3002 on `localhost` and `[::1]` refused connections, and the session could not run `wsl` to start or inspect it. Every number below is read from a source or is plain arithmetic, and says so. Section 7 lists what a live probe still has to measure.

Sources:

- E2B desktop template, `e2b-dev/desktop` at commit [`f53061e9`](https://github.com/e2b-dev/desktop/tree/f53061e9c0ce1cd343116dc89d89cb3168f9398e). Its README says the `@e2b/desktop` SDK now lives in the E2B monorepo.
- `@e2b/desktop` 2.5.0 and `e2b` 2.56.0 source, `e2b-dev/E2B` at commit [`62a17dfc`](https://github.com/e2b-dev/E2B/tree/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3) (`packages/desktop-js`, `packages/js-sdk`, `packages/cli`). Links use `DESKTOP/` for `packages/desktop-js/src/` and `SDK/` for `packages/js-sdk/src/`.
- E2B runtime (Embed), `e2b-dev/runtime` at commit [`4f35ab01`](https://github.com/e2b-dev/runtime/tree/4f35ab01d346408b29b843eac98fdea61a21f8d1), the same commit [#503](https://github.com/Daanish2003/ai-chat/issues/503) and [#504](https://github.com/Daanish2003/ai-chat/issues/504) read.
- x11vnc 0.9.17 man page, `LibVNC/x11vnc` at [`e2b726a8`](https://github.com/LibVNC/x11vnc/blob/e2b726a8c0464051afda01648072af6835aaa5f7/x11vnc.1). websockify [v0.12.0](https://github.com/novnc/websockify/tree/v0.12.0) and [v0.10.0](https://github.com/novnc/websockify/tree/v0.10.0). noVNC [v1.6.0](https://github.com/novnc/noVNC/tree/v1.6.0) docs. xdotool [v3.20160805.1](https://github.com/jordansissel/xdotool/tree/v3.20160805.1). scrot [1.8.1](https://github.com/resurrecting-open-source-projects/scrot/tree/1.8.1).
- Debian bookworm package pages at `packages.debian.org/bookworm/<name>`.
- Chromium `chrome/browser/process_singleton_posix.cc` at [`a8b48717`](https://github.com/chromium/chromium/blob/a8b48717d3e16f9bab13f8a4c1891a87440d3497/chrome/browser/process_singleton_posix.cc).
- This repo's step 5 template and README on `origin/feature/bot-step-5`.

Earlier findings not repeated: [E2B SDK and envd](https://github.com/Daanish2003/ai-chat/issues/503), [Self-host E2B locally](https://github.com/Daanish2003/ai-chat/issues/504), [Computer-use control stack](https://github.com/Daanish2003/ai-chat/issues/390). The decisions this builds on are on [The Computer](https://github.com/Daanish2003/ai-chat/issues/396): one 1280×800 Xvfb display per active Bot, created on demand, its own Chrome and per-Bot profile, an x11vnc and noVNC pair per display, at most 4 screens, and an authenticated, short-lived noVNC link that is view-only until the user takes control.

## 1. Starting point: step 5's template

- `packages/bot-sdk/plugins/computer/template/Dockerfile` is `debian:bookworm-slim` plus `bash ca-certificates curl git jq tar gzip unzip zip python3`. Its comment: "plain Debian, no X server". (`origin/feature/bot-step-5`)
- The template name is its version. Every change to the Dockerfile needs a new name, and every Computer is rebuilt on its next wake. `apps/web` holds the name in `computerTemplate` (`src/services.ts`, currently `ai-chat-computer-v2`). (`packages/bot-sdk/README.md`, "The template")
- It is built with `pnpm dlx @e2b/cli@2.22.0 template create ai-chat-computer-v2 -p plugins/computer/template -d Dockerfile`, with no `--cpu-count` or `--memory-mb`. (same README)
- The CLI's defaults are 2 vCPU and 1024 MiB: "The default value is 2" and "The default value is 1024" (memory must be even). ([cli/src/commands/template/create.ts L46-L55](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/cli/src/commands/template/create.ts#L46-L55), read at the monorepo commit, not at CLI 2.22.0.) So `ai-chat-computer-v2` most likely runs with 1024 MiB of guest RAM. Not checked against Embed's `env_builds` row.
- Root disk: Embed sizes it from the tier's `disk_mb`. With `disk_mb = 2560`, `ai-chat-computer-v2` showed `df -h /` = 2.8G size, 269M used, 2.3G available. `--min-free-disk-mb` is a no-op on Embed. The tier value is shared by every later build on that Embed. (`packages/bot-sdk/README.md`, "Root disk size")
- The step 5 README also says: run one sandbox at a time while testing; "with the 2 GiB of hugepages Embed has here, a second sandbox placed while one is paused or running can fail with 'Failed to place sandbox'". (same README, "The template")
- The E2B provider creates the sandbox with `lifecycle: { onTimeout: "pause" }` and no `network` options and no `autoResume`. (`packages/bot-sdk/plugins/computer/e2b/index.ts`, `create`)

## 2. Prior art: E2B's desktop template and `@e2b/desktop`

### The template

- Base `ubuntu:22.04`. Packages include `xvfb`, `x11-utils`, `xauth`, `xfce4`, `xdotool`, `scrot`, `ffmpeg`, `x11vnc`, `net-tools`, plus office apps. ([template/template.py L5-L53](https://github.com/e2b-dev/desktop/blob/f53061e9c0ce1cd343116dc89d89cb3168f9398e/template/template.py#L5-L53))
- noVNC is a git clone of E2B's fork (`e2b-dev/noVNC`, branch `e2b-desktop`) into `/opt/noVNC`, with `vnc.html` symlinked to `index.html`. websockify is cloned at `v0.12.0` into `/opt/noVNC/utils/websockify`. ([template.py L56-L65](https://github.com/e2b-dev/desktop/blob/f53061e9c0ce1cd343116dc89d89cb3168f9398e/template/template.py#L56-L65))
- Browsers: `firefox-esr`, `google-chrome-stable`, VS Code from vendor apt repos. ([template.py L66-L78](https://github.com/e2b-dev/desktop/blob/f53061e9c0ce1cd343116dc89d89cb3168f9398e/template/template.py#L66-L78))
- The production build uses `cpu_count=8, memory_mb=8192`. ([template/build_prod.py L10-L11](https://github.com/e2b-dev/desktop/blob/f53061e9c0ce1cd343116dc89d89cb3168f9398e/template/build_prod.py#L10-L11))
- The template starts no X server. The SDK starts it after create (below).

### The SDK (one display per sandbox)

- `Sandbox.create()` sets `DISPLAY` (default `:0`) as a sandbox-wide env var, then runs `_start`. ([DESKTOP/sandbox.ts L187-L208](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/desktop-js/src/sandbox.ts#L187-L208))
- `_start` runs, in the background with `timeoutMs: 0`: `Xvfb ${display} -ac -screen 0 ${width}x${height}x24 -retro -dpi 96 -nolisten tcp -nolisten unix`. Default size is 1024×768; `resolution` overrides it. It then polls `xdpyinfo -display ${display}` until exit 0 (10 s), and starts `startxfce4`. ([DESKTOP/sandbox.ts L529-L583](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/desktop-js/src/sandbox.ts#L529-L583))
  - `-nolisten unix` as well as `-nolisten tcp`: the SDK's X clients reach the display through the abstract socket. That is a reading of the flags, not a documented SDK statement.
- Screenshot: `scrot --pointer /tmp/screenshot-<random>.png`, then `files.read` and a best-effort `files.remove`. ([DESKTOP/sandbox.ts L267-L278](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/desktop-js/src/sandbox.ts#L267-L278))
- Mouse and keys are one `commands.run` per `xdotool` call: `mousemove --sync x y`, `click 1|2|3`, `click --repeat 2 1`, `click --repeat N 4|5` (scroll), `mousedown`/`mouseup`, `getmouselocation`, `type --delay 75 -- <chunk>` in 25-character chunks, `key <keysym+keysym>` with a name map (`enter` → `Return`, `ctrl` → `Control_L`). Drag is move, press, move, release. Screen size comes from parsing `xrandr`. ([DESKTOP/sandbox.ts L22-L91, L283-L459](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/desktop-js/src/sandbox.ts#L283-L459))
- None of these pass a display: they rely on the sandbox-wide `DISPLAY`. The SDK has no multi-display API.

### The stream (`desktop.stream`)

- One `VNCServer` per sandbox: x11vnc on 5900, noVNC on 6080. "There can be only one stream at a time." ([DESKTOP/sandbox.ts L620-L636](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/desktop-js/src/sandbox.ts#L620-L636); [desktop README](https://github.com/e2b-dev/desktop/blob/f53061e9c0ce1cd343116dc89d89cb3168f9398e/README.md))
- `start()` throws if `pgrep -x x11vnc` finds one. It runs `x11vnc -bg -display <d> -forever -wait 50 -shared -rfbport 5900 -nopw|-usepw [-id <window>]`, then `cd /opt/noVNC/utils && ./novnc_proxy --vnc localhost:5900 --listen 6080 --web /opt/noVNC` in the background, and polls `netstat -tuln` for `:6080`. ([DESKTOP/sandbox.ts L685-L749](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/desktop-js/src/sandbox.ts#L685-L749))
- `requireAuth: true` makes a random password, stores it with `x11vnc -storepasswd <pw> ~/.vnc/passwd` and starts x11vnc with `-usepw`. `getAuthKey()` returns that password. ([DESKTOP/sandbox.ts L638-L646, L726-L742](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/desktop-js/src/sandbox.ts#L726-L742))
- `getUrl({ autoConnect, viewOnly, resize, authKey })` returns `https://${getHost(6080)}/vnc.html` with query `autoconnect=true`, `view_only=true`, `resize=scale`, `password=<authKey>`. ([DESKTOP/sandbox.ts L656-L680, L695](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/desktop-js/src/sandbox.ts#L656-L680))
  - So in `@e2b/desktop`, view-only is a URL flag read by the noVNC page, and the password travels in the URL query.
- `stop()` runs `pkill x11vnc` (every x11vnc in the sandbox) and kills the noVNC handle. ([DESKTOP/sandbox.ts L712-L721](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/desktop-js/src/sandbox.ts#L712-L721))

## 3. What the template needs (packages)

Debian bookworm package versions and their own installed sizes, amd64. These are each package alone, **not** the dependency closure, so the real disk cost is larger and has to be measured (section 7).

| Need                         | Package (bookworm) | Version                 | Installed size |
| ---------------------------- | ------------------ | ----------------------- | -------------- |
| Virtual display              | `xvfb`             | 2:21.1.7-3+deb12u13     | 4,428 kB       |
| VNC server                   | `x11vnc`           | 0.9.16-9                | 2,107 kB       |
| noVNC web client             | `novnc`            | 1:1.3.0-1               | 998 kB         |
| WebSocket bridge             | `websockify`       | 0.10.0+dfsg1-4          | 71 kB          |
| JWT token plugin dependency  | `python3-jwcrypto` | 1.1.0-1+deb12u1         | 164 kB         |
| Mouse and keys               | `xdotool`          | 1:3.20160805.1-5        | 126 kB         |
| Screenshot                   | `scrot`            | 1.8.1-1                 | 129 kB         |
| `xdpyinfo` (readiness check) | `x11-utils`        | 7.7+5                   | 712 kB         |
| Browser                      | `chromium`         | 155.0.8059.79-1~deb12u1 | 288,988 kB     |
| Browser data                 | `chromium-common`  | (same)                  | 66,017 kB      |
| Fonts                        | `fonts-liberation` | 1:1.07.4-11             | 2,093 kB       |

- Source: `packages.debian.org/bookworm/<package>` download tables, read 2026-10-19.
- Bookworm's `x11vnc` is 0.9.16; the man page read is 0.9.17. The options used below (`-viewonly`, `-viewpasswd`, `-passwdfile`, `-remote`, `-localhost`, `-rfbport`) are long-standing; not checked option by option against 0.9.16.
- The E2B desktop template uses `google-chrome-stable` from Google's apt repo and clones noVNC and websockify from GitHub instead of Debian packages (section 2).
- Chromium and its libraries dominate. With 2.3G free on `ai-chat-computer-v2`'s disk, chromium plus chromium-common alone are about 355 MB before dependencies.
- No window manager is needed for Xvfb itself. E2B's template adds xfce4; [#396](https://github.com/Daanish2003/ai-chat/issues/396) names none.

## 4. Displays, Chrome and profiles, several per Computer

### Xvfb per display

- One Xvfb process per display number, e.g. `Xvfb :1 -screen 0 1280x800x24 -nolisten tcp`, started on demand. Each display is a separate X server with its own framebuffer and input. (E2B's command in section 2 is the pattern.)
- Framebuffer size, arithmetic: 1280 × 800 × 4 bytes (24-bit depth is stored at 32 bpp) = 4,096,000 bytes, about 3.9 MiB per display. Xvfb's process RSS on top of that was not measured.
- Readiness: poll `xdpyinfo -display :N` until exit 0, as `@e2b/desktop` does.
- Background processes started through envd need `timeoutMs: 0`, or envd kills them after the 60 s default even in the background. ([#503 findings](https://github.com/Daanish2003/ai-chat/blob/research/503-e2b-sdk-envd/docs/research/always-on-agent/e2b-sdk-envd.md), "Background commands")

### Chrome per display

- Chrome locks a profile, so one profile cannot be shared by two running Chromes (#396). The lock is a `SingletonLock` symlink in the user data dir, pointing at `<hostname>-<pid>`. ([process_singleton_posix.cc L21-L31](https://github.com/chromium/chromium/blob/a8b48717d3e16f9bab13f8a4c1891a87440d3497/chrome/browser/process_singleton_posix.cc#L21-L31))
- On launch, a lock whose hostname matches and whose pid is not a running Chrome is treated as orphaned and removed. A lock whose **hostname differs** shows the "profile in use" error and, on Linux, a dialog; the new Chrome exits unless the user unlocks. ([process_singleton_posix.cc L818-L845](https://github.com/chromium/chromium/blob/a8b48717d3e16f9bab13f8a4c1891a87440d3497/chrome/browser/process_singleton_posix.cc#L818-L845), [L357-L376](https://github.com/chromium/chromium/blob/a8b48717d3e16f9bab13f8a4c1891a87440d3497/chrome/browser/process_singleton_posix.cc#L357-L376))
  - This matters when a profile directory is restored onto a rebuilt Computer whose hostname is different. Whether an E2B sandbox's hostname changes between sandboxes was not checked.
- One Chrome per display is `DISPLAY=:N chromium --user-data-dir=<per-Bot dir> ...`. Since Chrome 136, `--remote-debugging-port` and `--remote-debugging-pipe` are honoured only with a non-default `--user-data-dir`, which a per-Bot profile already is. ([Chrome blog, remote debugging changes](https://developer.chrome.com/blog/remote-debugging-port)) CDP itself is [#563](https://github.com/Daanish2003/ai-chat/issues/563)'s question.
- RAM per Chrome was not measured and no primary source gives a figure for this setup. The one sizing data point from E2B is its own desktop template at 8 vCPU / 8192 MiB for one display with xfce4 (section 2).

### xdotool and screenshots on a given display

- xdotool opens the display with `xdo_new(NULL)` → `XOpenDisplay(NULL)`, which uses the `DISPLAY` environment variable. It has no `--display` flag. So each call is `DISPLAY=:N xdotool ...`, or `commands.run(cmd, { envs: { DISPLAY: ":N" } })`. ([xdotool.c L346](https://github.com/jordansissel/xdotool/blob/v3.20160805.1/xdotool.c#L346); [xdo.c L83-L90](https://github.com/jordansissel/xdotool/blob/v3.20160805.1/xdo.c#L83-L90))
- `mousemove` and `windowactivate` have `--sync`, which waits until the move or activation has happened. `type` has `--delay` between keystrokes. ([xdotool.pod L87-L111, L140-L200](https://github.com/jordansissel/xdotool/blob/v3.20160805.1/xdotool.pod))
- scrot takes `-D, --display DISPLAY` and `-p, --pointer`. ([scrot man L5, L31, L49](https://github.com/resurrecting-open-source-projects/scrot/blob/1.8.1/man/scrot.txt))
- `@e2b/desktop` sets `DISPLAY` once per sandbox (section 2), so its helpers drive only one display. Multi-display needs the display passed per call.
- Screenshot token cost at 1280×800 is in the [#390 findings](https://github.com/Daanish2003/ai-chat/issues/390) (about 1,334 tokens on current Claude models).

## 5. Live view: x11vnc, websockify, noVNC, and reaching it from a browser

### x11vnc per display

- `-display :N` picks the X display; `-rfbport` the TCP port (default 5900, `-display :N` alone does not move it). ([x11vnc.1 L94-L110](https://github.com/LibVNC/x11vnc/blob/e2b726a8c0464051afda01648072af6835aaa5f7/x11vnc.1#L94-L110))
- `-localhost` is "basically the same as `-allow 127.0.0.1`" and implies `-listen localhost`. ([x11vnc.1 L858-L867](https://github.com/LibVNC/x11vnc/blob/e2b726a8c0464051afda01648072af6835aaa5f7/x11vnc.1#L858-L867))
- `-shared` lets more than one viewer connect; `-forever` keeps serving after the first client leaves. ([x11vnc.1 L472-L493](https://github.com/LibVNC/x11vnc/blob/e2b726a8c0464051afda01648072af6835aaa5f7/x11vnc.1#L472-L493))
- **View-only, server side**, three mechanisms:
  - `-viewonly`: "All VNC clients can only watch". ([x11vnc.1 L472-L474](https://github.com/LibVNC/x11vnc/blob/e2b726a8c0464051afda01648072af6835aaa5f7/x11vnc.1#L472-L474))
  - Two passwords: `-viewpasswd <pw>` is "a 2nd password for view-only logins", with `-passwd` as the full-access one. In a `-passwdfile`, lines after `__BEGIN_VIEWONLY__` are view-only passwords. A `read:` prefix rereads the file "just when a new client connects". ([x11vnc.1 L978-L1060](https://github.com/LibVNC/x11vnc/blob/e2b726a8c0464051afda01648072af6835aaa5f7/x11vnc.1#L978-L1060))
  - Toggle on a running server: `x11vnc -R viewonly` / `x11vnc -R noviewonly`, sent through an X property on the same display. ([x11vnc.1 L5694-L5720, L5812-L5814](https://github.com/LibVNC/x11vnc/blob/e2b726a8c0464051afda01648072af6835aaa5f7/x11vnc.1#L5694-L5720))
  - `-input` tunes allowed input (keys, mouse, buttons, clipboard) separately for normal and view-only clients. ([x11vnc.1 L917-L929](https://github.com/LibVNC/x11vnc/blob/e2b726a8c0464051afda01648072af6835aaa5f7/x11vnc.1#L917-L929))
- VNC passwords: "only the first 8 characters of a password are used (DES key)". The `-rfbauth` file "is NOT encrypted, only obscured with a fixed key". A `custom:` password checker runs an external command per client. ([x11vnc.1 L996-L1040](https://github.com/LibVNC/x11vnc/blob/e2b726a8c0464051afda01648072af6835aaa5f7/x11vnc.1#L996-L1040))

### websockify and noVNC

- noVNC is a browser VNC client; it needs a WebSocket, which websockify bridges to x11vnc's TCP port. `@e2b/desktop` runs one `novnc_proxy` per stream (section 2).
- **One websockify can serve all displays.** Token plugins let "a single instance of websockify ... connect clients to multiple different pre-configured targets, depending on the token sent by the client using the `token` URL parameter, or the hostname" (`--host-token`). Options `--token-plugin CLASS --token-source ARG`. ([websockify README L105-L110](https://github.com/novnc/websockify/blob/v0.12.0/README.md#L105-L110))
- Token plugins in v0.12.0: `ReadOnlyTokenFile`, `TokenFile` (lines `token: host:port`), `TokenFileName`, `BaseTokenAPI`/`JSONTokenApi` (an HTTP lookup URL), `JWTTokenApi`, `TokenRedis`, `UnixDomainSocketDirectory`. ([token_plugins.py](https://github.com/novnc/websockify/blob/v0.12.0/websockify/token_plugins.py))
- `JWTTokenApi`: the token is a JWS or JWE signed with a key file; it rejects a token before `nbf` or after `exp` and returns `host` and `port` from the claims. It needs `jwcrypto`. ([token_plugins.py L118-L175](https://github.com/novnc/websockify/blob/v0.12.0/websockify/token_plugins.py#L118-L175)) Bookworm's websockify 0.10.0 has the same class with the same `nbf`/`exp` checks. ([v0.10.0 token_plugins.py L96-L145](https://github.com/novnc/websockify/blob/v0.10.0/websockify/token_plugins.py#L96-L145))
  - The token is checked when the WebSocket connects; nothing in the plugin ends an already-open connection at `exp`. (Reading of the plugin code: `lookup` runs per new connection.)
- websockify can also demand auth with `--auth-plugin` (and `--web-auth` for its static files), and serve TLS with `--cert`/`--key`. ([websockify README L43-L103](https://github.com/novnc/websockify/blob/v0.12.0/README.md#L43-L103))
- noVNC page parameters include `autoconnect`, `reconnect`, `reconnect_delay`, `host`, `port`, `encrypt`, `path`, `password`, `shared`, `view_only`, `resize` (`off`, `scale`, `remote`). ([noVNC EMBEDDING.md L25-L65](https://github.com/novnc/noVNC/blob/v1.6.0/docs/EMBEDDING.md))
- In noVNC's JS API, `rfb.viewOnly` "indicat[es] if any events (e.g. key presses or mouse movement) should be prevented from being sent to the server". It is a client-side switch. ([noVNC API.md L85-L88](https://github.com/novnc/noVNC/blob/v1.6.0/docs/API.md))
  - So `view_only=true` in the URL (as `@e2b/desktop` does) only stops the page from sending input; anyone holding the URL can drop the flag. Server-side view-only is x11vnc's `-viewonly`, `-viewpasswd` or `-R viewonly` above.

### Reaching a sandbox port from a browser

- E2B's proxy picks the sandbox and port either from the `E2b-Sandbox-Id` / `E2b-Sandbox-Port` headers or from the Host, as `{port}-{sandboxId}.{anything}`. Headers are honoured only when the Host is `localhost`, an IP, or `sandbox.<domain>`; otherwise the Host is parsed. ([shared/pkg/proxy/host.go L16-L99](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/packages/shared/pkg/proxy/host.go#L16-L99))
  - Sandbox ids match `^[a-z0-9]+$`, so the `-` split is unambiguous. ([shared/pkg/id/id.go L16-L39](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/packages/shared/pkg/id/id.go#L16-L39))
- A browser page load or WebSocket cannot add custom headers (the `WebSocket(url, protocols)` constructor takes none). So a browser reaches noVNC either by a Host of the form `6080-<id>.<domain>` that resolves to client-proxy, or through a server-side reverse proxy (for example in `apps/web`) that adds the headers.
  - On Embed, `getHost()` returns `{port}-{id}.e2b.app`, which does not resolve ([#504](https://github.com/Daanish2003/ai-chat/issues/504)). A name under `.localhost` (`6080-<id>.localhost:3002`) is parsed by `parseHost` the same way; RFC 6761 §6.3 reserves `.localhost` names for loopback. Whether Chrome on the owner's Windows host reaches WSL's `[::1]`-only forward that way was **not tested**.
- **Public by default.** `allowPublicTraffic` defaults to `true`: "Specify if the sandbox URLs should be accessible only with authentication." ([SDK/sandbox/sandboxApi.ts L305-L316](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/sandbox/sandboxApi.ts#L305-L316)) Step 5's provider sets no `network` options (section 1), so any port it opens is reachable by anyone who can reach client-proxy and knows the sandbox id.
- With `allowPublicTraffic: false`, the sandbox has a `trafficAccessToken` (`sandbox.trafficAccessToken`), and the proxy requires header `e2b-traffic-access-token` on every non-envd port, compared in constant time; missing or wrong is refused. Preflights fail it too. ([orchestrator/pkg/proxy/proxy.go L39, L99-L113](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/packages/orchestrator/pkg/proxy/proxy.go#L99-L113); [SDK/sandbox/index.ts L109-L111](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/sandbox/index.ts#L109-L111))
  - Being a header, it cannot come from a browser directly either; a server-side proxy would have to add it. It is one token per sandbox, not per port or per link, and has no expiry in the code read.
- `maskRequestHost` (default `${PORT}-sandboxid.e2b.app`) rewrites the Host header the service inside sees. ([SDK/sandbox/sandboxApi.ts L311-L316](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/sandbox/sandboxApi.ts#L311-L316); [proxy.go L116-L121](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/packages/orchestrator/pkg/proxy/proxy.go#L116-L121))
- Embed is plain HTTP with no TLS of its own ([#503 findings](https://github.com/Daanish2003/ai-chat/blob/research/503-e2b-sdk-envd/docs/research/always-on-agent/e2b-sdk-envd.md), section 5), so a token or VNC password in a link travels in clear between browser and client-proxy unless something in front adds TLS.

### Pieces available for "short-lived, authenticated, view-only until take control"

Listed, not ranked:

| Piece                                                      | Short-lived                           | Authenticated                | View-only until control                 | Source               |
| ---------------------------------------------------------- | ------------------------------------- | ---------------------------- | --------------------------------------- | -------------------- |
| websockify `JWTTokenApi` token in the link                 | `exp`/`nbf` at connect time           | signed token                 | no (routing only)                       | websockify v0.12.0   |
| websockify `JSONTokenApi`                                  | as the lookup URL decides             | lookup URL decides           | no                                      | websockify v0.12.0   |
| x11vnc `-viewpasswd` + `-passwd` (or `__BEGIN_VIEWONLY__`) | `read:` file is reread per connection | 8-char DES VNC auth          | yes, by which password the link carries | x11vnc.1             |
| x11vnc `-R viewonly` / `noviewonly`                        | no                                    | no                           | yes, toggles all clients                | x11vnc.1             |
| noVNC `view_only` / `rfb.viewOnly`                         | no                                    | no                           | client-side only                        | noVNC docs           |
| E2B `allowPublicTraffic: false`                            | no expiry seen                        | one header token per sandbox | no                                      | SDK, runtime proxy   |
| App-side reverse proxy (`apps/web`)                        | as the app decides                    | the app's session            | can choose the upstream password        | (none; design space) |

## 6. Disk, RAM, and pause and resume on the owner's machine

### RAM on Embed

- Every sandbox takes guest memory from the hugepage reservation "as it touches pages, up to its full size (256 of the 2 MiB pages for a 512 MiB `base` sandbox, about 90 while idle)". Past the reservation, a create fails with `500: Failed to place sandbox`, with `mmap memfd: cannot allocate memory` in the orchestrator log. ([embed/compose/README.md L54-L73](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/README.md#L54-L73))
- The owner's Embed reserves 2 GiB of hugepages (`HUGEPAGES=1024`; owner memory note and step 5 README). So the sum of touched guest memory across all running sandboxes, template builds included, must stay within 2 GiB unless `HUGEPAGES` is raised (which needs WSL memory headroom on a 15.4 GB machine).
- A template's guest RAM is fixed at build (`memory_mb`). `ai-chat-computer-v2` has the CLI default of 1024 MiB (section 1). Raising it is a new template build and name, so every Computer is rebuilt and browser logins on it are lost (#396 rebuild rule).
- Per-display RAM (Xvfb + Chrome + x11vnc) was **not measured**. Only the framebuffer (about 3.9 MiB) is known by arithmetic.

### Disk

- `ai-chat-computer-v2` has 2.3G available on `/` (section 1). Package sizes are in section 3; the dependency closure was not measured.
- A Chrome profile grows with cache and history. Its size was not measured. If profiles live under `/home/user`, the step 5 sleep sync (`tar` of `/home/user`) carries them.
- Pausing on Embed needs free host disk for the sandbox's whole memory plus 1 GiB headroom (`PAUSE_ADMISSION_DISK_HEADROOM_MIB`); otherwise the pause is refused with 503 and the sandbox keeps running. ([embed/compose/README.md L54-L58](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/README.md#L54-L58); [#503 findings](https://github.com/Daanish2003/ai-chat/blob/research/503-e2b-sdk-envd/docs/research/always-on-agent/e2b-sdk-envd.md))

### Pause and resume

- A full pause (`mode: 'full'`, the default and step 5's) saves memory and disk, so running processes survive a resume. Xvfb, Chrome, x11vnc and websockify are ordinary processes, so by that rule they resume as they were. Not measured on Embed. ([#503 findings](https://github.com/Daanish2003/ai-chat/blob/research/503-e2b-sdk-envd/docs/research/always-on-agent/e2b-sdk-envd.md), "What a pause snapshots")
- "Clients outside the sandbox are disconnected on pause and must reconnect after resume." A noVNC viewer's WebSocket, and any CDP connection from outside, drop on pause. noVNC has `reconnect` and `reconnect_delay` page parameters. (same; [noVNC EMBEDDING.md](https://github.com/novnc/noVNC/blob/v1.6.0/docs/EMBEDDING.md))
- A filesystem-only pause or a rebuild reboots the VM: every display process is gone and must be started again. The profile directories survive a filesystem-only pause (on disk) but not a rebuild unless restored from server storage (#396).
- Traffic to a paused sandbox wakes it only with `autoResume: true`; step 5 does not set it. Without it client-proxy does not resume the sandbox. ([client-proxy/internal/proxy/proxy.go L74-L161](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/packages/client-proxy/internal/proxy/proxy.go#L74-L161); [#503 findings](https://github.com/Daanish2003/ai-chat/blob/research/503-e2b-sdk-envd/docs/research/always-on-agent/e2b-sdk-envd.md), "autoPause and autoResume")
- #396's sleep rule is 5 minutes after the last computer activity. Whether proxied traffic (a user watching noVNC) extends an E2B sandbox's timeout was not found in the code or docs read.

## 7. Not verified (needs a live probe on Embed)

- Anything running: the session could not reach Embed (ports 3000/3002 closed, `wsl` not runnable from this session). No scratch template was built.
- RAM per display: Xvfb RSS, Chrome RSS idle and on a real page, x11vnc and websockify RSS, measured in a sandbox; and how many displays fit in 1024 MiB of guest RAM and in the 2 GiB hugepage reservation.
- Disk: `df` before and after installing the section 3 packages with dependencies; profile size after a few sites.
- Pause and resume with live displays: whether Xvfb, Chrome, x11vnc and websockify all come back, whether Chrome's network recovers, and pause time with a larger touched memory.
- Reaching noVNC from Windows Chrome through `6080-<id>.localhost:3002`, given WSL forwards on `[::1]` only.
- Whether a WebSocket upgrade passes through Embed's client-proxy (E2B Cloud's desktop stream implies it does on Cloud).
- Whether an E2B sandbox's hostname changes across sandboxes or rebuilds (the Chrome `SingletonLock` case in section 4).
- Whether proxied traffic extends the sandbox timeout.
- Whether Chromium's own sandbox (user namespaces) works inside the Firecracker guest kernel, or needs `--no-sandbox`.
- x11vnc 0.9.16 (bookworm) against every 0.9.17 option cited.
- Exact `memory_mb` of the built `ai-chat-computer-v2` (inferred 1024 MiB from the CLI default).

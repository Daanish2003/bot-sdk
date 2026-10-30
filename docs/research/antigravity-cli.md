# Gemini plans through the Antigravity CLI

Research for issue #1084 (child of the map #978). Researched on 2026-10-30 and 2026-10-31.

**Question.** Since 2026-06-18, Gemini CLI no longer serves Google AI Pro, Ultra or free plans. Those plans moved to the closed-source Antigravity CLI (`agy`), as #1080 found. Can `agy`, or Google's Antigravity ACP server, run as an ACP agent on our Linux Computer? The answer covers CPU architectures, sign-in on a remote machine, whether it asks permission before acting, and whether Google's terms let a third-party product drive it with the user's plan.

**Our setting.** A coding-agent Helper drives a coding-agent CLI over ACP on the user's Computer. The Computer is an E2B Linux sandbox with a Screen running Chrome. The CLI runs under the user's own plan login, and every permission request goes through Auto-review.

## Answer

- **Technically, yes, but through a separate Google program, not through `agy`.** Google publishes its own ACP agent, `antigravity-acp` (binary `agy_acp_server`), in the ACP registry at version 1.4.5 for Linux x86_64 and aarch64. It is a standalone program with its own harness and its own credentials. It does not wrap `agy`. The `agy` CLI documents no ACP mode.
- **Sign-in on the Computer works through the Screen.** "Log in with Google" runs a loopback OAuth flow on `127.0.0.1`. It opens the URL with Python's `webbrowser` (so `xdg-open` and Chrome when a display is set) and also prints the URL to stderr. On Linux the token is stored in a file, not a keyring.
- **It asks before acting by default.** The `default` mode sends `session/request_permission` with `allow_once` and `reject_once` options. There are also `auto_edit` and `yolo` modes.
- **The terms say no for consumer plans.** The Antigravity Terms call "using third party software, tools, or services to access the Service" a breach that can suspend the Antigravity and Gemini CLI accounts. They also forbid "using the Service in connection with products not provided by us". The FAQ adds that wrapping `agy` in third-party applications "is not supported under consumer plans", and recommends a Gemini Enterprise or AI Studio API key for third-party coding agents.
- **Result.** We cannot use a Google AI Pro, Ultra or free plan through our Helper. Gemini stays reachable through an API key, in either Gemini CLI (`gemini --acp`) or `antigravity-acp` (`gemini-api-key` or `agent-platform`). It is also reachable through a Code Assist Standard or Enterprise login in Gemini CLI, or a Gemini Enterprise login (`oauth-business`). Each of these is under that customer's business terms, which this note does not cover.

## Sources

Read on 2026-10-30 and 2026-10-31.

- Google Developers Blog, [An important update: Transitioning Gemini CLI to Antigravity CLI](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) (2026-05-19).
- Antigravity docs:
  - [Gemini CLI migration](https://antigravity.google/docs/cli/gcli-migration)
  - [CLI reference](https://antigravity.google/docs/cli/reference/)
  - [Headless mode](https://antigravity.google/docs/cli/headless/)
  - [Execution modes](https://antigravity.google/docs/cli/modes/)
  - [Installation and auth](https://antigravity.google/docs/install/)
  - [CLI troubleshooting](https://antigravity.google/docs/cli/troubleshooting/)
  - [IDE extensions](https://antigravity.google/docs/ide/extensions)
  - [Zed](https://antigravity.google/docs/ide/extensions/zed)
  - [FAQ](https://antigravity.google/docs/faq/)
- [Antigravity Terms](https://antigravity.google/terms). The page shows no "last updated" date.
- `agy` installer: [`https://antigravity.google/cli/install.sh`](https://antigravity.google/cli/install.sh).
- ACP registry: [`registry.json`](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json), entry `antigravity-acp` 1.4.5. Zed's listing: [zed.dev/acp/agent/antigravity-acp](https://zed.dev/acp/agent/antigravity-acp).
- The `antigravity-acp` 1.4.5 Linux x86_64 archive, [`agy-acp-server-1.4.5-linux-x86_64.zip`](https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-x86_64.zip). Its SHA-256 `923923a0…188013b` matches the registry, and the files inside are dated 2026-10-29. I **did not run it**: the sandbox refused to run downloaded code. The archive holds `agy_acp_server.par`, an ELF x86-64 Python "par" bundle of 826 MB, and `localharness_external`. The par embeds its Python source as plain text, and sections 3 to 5 quote that source. Treat those parts as read from the code, not observed at runtime.
- Google AI developer forum: [Antigravity ACP server in Zed fails to start on remote Linux hosts using OS Login](https://discuss.ai.google.dev/t/antigravity-acp-server-in-zed-fails-to-start-on-remote-linux-hosts-using-os-login-nss-exit-255/180646) (2026-09-03).

---

## 1. What exists

| Program                                                                                                     | What it is                                                                                                                                                                | ACP                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agy` (Antigravity CLI)                                                                                     | Google's closed-source terminal agent, written in Go (blog). It replaces Gemini CLI for consumer plans.                                                                   | **No documented ACP mode.** The [CLI reference](https://antigravity.google/docs/cli/reference/) lists no `--acp` flag or `acp` command. It does have headless `-p` with `--output-format stream-json` and `--input-format stream-json`. |
| `antigravity-acp` (`agy_acp_server`)                                                                        | Google's own ACP agent, "Google's AI coding agent". Registry authors: `Google LLC`. License: `proprietary`, with `license_url` set to `https://antigravity.google/terms`. | **Yes, native.** It is installed from the ACP registry, and Zed and JetBrains use it ([Zed page](https://antigravity.google/docs/ide/extensions/zed): "Install from Registry → Antigravity").                                           |
| Gemini CLI                                                                                                  | Open source (Apache-2.0), registry entry `gemini` 0.66.0, `gemini --acp`.                                                                                                 | Yes, but it no longer serves consumer plans (blog, #1080).                                                                                                                                                                              |
| Community adapters (`agy-acp` on PyPI, `agy-acp-bridge` on npm, `shubzkothekar/antigravity-acp` and others) | Third-party ACP wrappers around `agy`. They are not affiliated with Google, and several warn about the Terms themselves.                                                  | Exactly what the FAQ calls unsupported. We should not use them.                                                                                                                                                                         |

`antigravity-acp` does not call `agy`. It ships its own harness binary (`localharness_external`) and keeps its own state under `$GEMINI_HOME/antigravity-acp/` (default `~/.gemini`). The embedded path module puts it this way: "mirrors Antigravity Desktop and the Antigravity CLI, which use `antigravity/` and `antigravity-cli/` in place of our `antigravity-acp/`". It shares only `config/` (hooks and skills) and the CLI's skills directory. **An `agy` login does not sign in the ACP server.**

The ticket mentions that OpenBot uses the Antigravity ACP server. **I did not verify that.**

## 2. CPU architectures

- **`antigravity-acp` 1.4.5** (registry `distribution.binary`): `linux-x86_64`, `linux-aarch64`, `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64` and `windows-aarch64`. The Linux build is a glibc ELF that is "dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2". **No musl build is listed.** E2B's Debian or Ubuntu images use glibc, so this fits.
- **The registry launch command on Linux is `./agy_acp_server.par --uid=`.** What `--uid=` is for is **not documented**. The binary is built from Google-internal code, and the flag looks like a Google-internal process flag passed empty. Our launcher should pass the argument exactly as the registry gives it.
- **Known Linux failure.** A forum report says the server exits with status 255 when the user is not in the local `/etc/passwd` (GCE OS Login, build `agy_acp_server_20260818_01_RC01`). The workaround is to add the user with `getent passwd $(id -u) >> /etc/passwd`. E2B's `user` is a local account, so this should not happen to us, but **it is unverified on E2B**.
- **Size.** The x86_64 archive is 322 MB and unpacks to about 960 MB. That bears on the Computer's disk and template size.
- **`agy` CLI** (`install.sh`): Linux `amd64` and `arm64`, with glibc and musl builds, plus an Android (Termux) build, macOS and Windows.

## 3. Sign-in on a remote machine

### `antigravity-acp` (read from its source)

- `initialize` advertises four `agent`-type auth methods. None is a `terminal`-type method.

  | `id`             | Name                                                                          |
  | ---------------- | ----------------------------------------------------------------------------- |
  | `oauth-personal` | Log in with Google                                                            |
  | `oauth-business` | Log in with Gemini Enterprise                                                 |
  | `gemini-api-key` | Gemini API key                                                                |
  | `agent-platform` | Gemini Enterprise Agent Platform (formerly Vertex AI), with ADC or an API key |

  A fifth method, `gateway`, appears only when the client opts in and an environment flag is set. `agentCapabilities` advertises `loadSession`, `auth.logout`, session `list`, `resume` and `additionalDirectories`, and MCP over HTTP and SSE. `_meta.antigravity` carries `tier` and `systemPrompt.append`.

- **The `oauth-personal` flow** is `OAuthCredentialManager._run_redirect_server`:
  - It binds a one-shot loopback server on `127.0.0.1` at a random port, with a PKCE authorization URL (`access_type=offline`, `prompt=consent`).
  - It calls `webbrowser.open(auth_url)`. On Linux that uses `xdg-open` or `$BROWSER`, so it opens Chrome on the Screen when the server's environment has the display.
  - It also prints `Open the following link to authenticate the ACP server: <url>` to **stderr**. A client could read that line and open the URL itself.
  - It waits up to `_LOGIN_TIMEOUT_SECONDS = 300`.
  - **There is no paste-code flow and no device code**, so the browser must run on the same machine as the server. On our Computer that is the Screen's Chrome. This matches the Gemini CLI and Codex pattern in #1080.
- **When the flow starts.** The source says it runs either from `authenticate` or lazily at `session/new` when `auth.type` is already saved in settings. With no cached token, `get_access_token` "launches the browser sign-in flow" and then runs Code Assist onboarding (`loadCodeAssist`/`onboardUser`).
- **Credential.**
  - On Linux, `create_default_store` uses the file store. The keychain is used only on `darwin`.
  - The file is `<home>/antigravity-acp/acp_token.json` (`acp_business_token.json` for Enterprise), where `<home>` is `$GEMINI_HOME` or `~/.gemini`.
  - It holds `client_id`, `client_secret`, `refresh_token`, `token_uri`, `scopes` and `project_id`. Refresh is silent.
  - So no D-Bus Secret Service is needed, unlike `agy`. Setting `GEMINI_HOME` moves the whole tree, which suits the Computer's persistent disk.
- **Signed-out signal.**
  - `session/new` and other calls fail with JSON-RPC `-32000` `auth_required`, and `data.reason` gives the cause.
  - `logout` clears both stores.
  - After an identity failure the server signs itself out, so the next `session/new` returns `auth_required` instead of reopening the browser.

### `agy` (from the docs)

- A local sign-in opens the browser. Over SSH, "the CLI initiates a manual URL loop": copy a code and paste it back into the terminal ([Install and auth](https://antigravity.google/docs/install/)).
- Tokens go in the OS keyring. On Linux that is "Linux secret-service through D-Bus", and the documented error is `secret keyring is locked` ([Troubleshooting](https://antigravity.google/docs/cli/troubleshooting/)). An E2B Computer would need a D-Bus session and an unlocked keyring daemon.
- Headless `agy -p` "uses your cached credentials. Authenticate once with an interactive `agy` session first" ([Headless](https://antigravity.google/docs/cli/headless/)).
- Plans: a personal Google Account on "Free, Pro, or Ultra"; Business accounts through SSO or ADC; or a Gemini API key.

## 4. Does it ask permission before acting?

### `antigravity-acp` (read from its source, `_permission_handler`)

- **Session modes** (`AVAILABLE_SESSION_MODES`):
  - `default`: "Default permission prompt flow".
  - `auto_edit`: "Auto-approve file edit tools".
  - `yolo`: "Auto-approve all tools".

  Modes are exposed through `session/set_mode` and as a `mode` config option (`session/set_config_option`). New sessions start in `default`, unless a saved sidecar mode is reloaded on `session/load`.

- **In `default` mode, a tool call sends `session/request_permission`.** The harness "uses an always-allow permission manager and surfaces every tool call to the client", and this handler decides. **I could not confirm from the source whether read-only tools are pre-approved before they reach the handler.**
- **Options offered:**
  - File-write tools get only `allow` (`allow_once`) and `deny` (`reject_once`). Their decisions are never cached.
  - Exec tools (`run_command`, `shell`) and web tools also get "Allow Always (risky)" (`allow_always`). For exec tools it is scoped to the exact command string. For web tools it is scoped to the tool for the session.
  - Other tools get a plain "Allow Always".
  - A cached `allow_always` skips later prompts for that signature. As in #1078, Auto-review should answer only `allow_once` or `reject_once`.
- **Auto-proceed paths apply only to Gemini Enterprise admin policies** (`oauth-business` with admin controls): terminal "always proceed" and "proceed in sandbox". They do not apply to `oauth-personal` or API keys. **This is inferred from the wrappers. I did not read `terminal_sandbox` itself.**
- The server has a best-effort "outside workspace" check for exec arguments. It fails open, and its own comment says so.

### `agy` (from the docs)

- Modes ([Execution modes](https://antigravity.google/docs/cli/modes/)):
  - default: asks before file writes and terminal commands.
  - `accept-edits`: asks only before commands.
  - `auto` (preview): edits are auto-approved, commands run in a sandbox, and only high-risk commands ask.
  - `plan`.
  - The `--dangerously-skip-permissions` override.
  - `toolPermission` presets, `request-review` by default.
- Headless `-p` has no prompts: "A tool that requires approval it can't obtain is soft-denied". That is why `agy -p` could never route a permission request to Auto-review.

## 5. Do Google's terms allow a third-party product to drive it with the user's plan?

**No, for consumer plans (Free, Pro, Ultra).** Quoted 2026-10-31:

- **[Antigravity Terms](https://antigravity.google/terms):**

  > You must not abuse, harm, interfere with, or disrupt the Service. This includes, but is not limited to, using the Service in connection with products not provided by us. Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts.

  The Terms also say "If you access the Service through certain enterprise or Workspace offerings ... you are subject to the terms of use accepted or signed by your administrator."

- **[FAQ](https://antigravity.google/docs/faq/), "Why can't I use third-party software (such as Claude Code, OpenClaw, or OpenCode) with my Antigravity login?":**

  > Using third-party software, tools, or services to access Antigravity is a violation of our Terms of Service ... Such actions can result in suspension or termination of your account. To use a third-party coding agent with Gemini, we recommend using a Gemini Enterprise or Google AI Studio API key.

- **FAQ, "Can I use Antigravity CLI headless mode in third-party coding agents or automate account switching?":**

  > Antigravity CLI headless mode (agy -p) is intended for direct scripting and CI workflows. Wrapping agy inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans.

- **The ACP server is Google's software,** and Google supports it in Zed and JetBrains. Our Helper would still be a third-party product driving it with the user's Antigravity OAuth, which is "in connection with products not provided by us". Google names Zed and JetBrains as supported surfaces. It does not offer any ACP client a general permission, and the registry entry's license is the same Terms. A reading that "any ACP client is fine" has no support in Google's text, so **treat it as not allowed**.
- **Enforcement is real.** Secondary reports, not verified here, describe bans (reported as "February", year not stated) of accounts that used Antigravity OAuth in OpenClaw. Google later lifted them automatically and narrowed the wording to "Antigravity and/or Gemini CLI accounts".

## 6. Consequences for the Helper

1. **No consumer Gemini plan behind the coding-agent Helper.** Neither `agy` nor `antigravity-acp` with `oauth-personal` is allowed in our product.
2. **Gemini is still available with an API key.** Options:
   - Gemini CLI `gemini --acp` with `gemini-api-key` or `vertex-ai`. It is open source, light, and covered in #1078 and #1080.
   - `antigravity-acp` with `gemini-api-key` or `agent-platform`. It is proprietary, about 1 GB, and adds no plan benefit.

   Prefer Gemini CLI.

3. **Business logins** (Gemini CLI "Sign in with Google" for Code Assist Standard or Enterprise, or `antigravity-acp` `oauth-business`) fall under the customer's admin-accepted terms. Whether they allow a third-party product is **unverified**. It would need its own read of the Google Cloud and Code Assist terms if we want that path.
4. **If the owner still wants to probe `antigravity-acp`** (for example with an API key), check these on E2B:
   - It starts with `--uid=` as the E2B user.
   - The disk footprint.
   - Whether read-only tools prompt in `default` mode.
   - That `webbrowser.open` reaches Chrome on the Screen.

## 7. Not confirmed

- `antigravity-acp` behaviour comes from reading its embedded source, not from running it. Running the binary was refused in this session.
- Whether read-only tools prompt in `default` mode.
- What `--uid=` does.
- That OpenBot uses `antigravity-acp`.
- Whether Code Assist Standard or Enterprise and Gemini Enterprise terms allow a third-party product to drive the CLI.

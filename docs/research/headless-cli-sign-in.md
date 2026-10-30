# Headless CLI sign-in on a remote machine

Research for issue #1080 (child of the map #978). Researched on 2026-10-30.

**Question.** How does each of Claude Code, Codex and Gemini CLI sign in with a plan when it runs on a remote Linux machine with no local browser? Which login flows does each offer (device code, URL plus pasted code, a browser on that machine, a long-lived token or env var)? Where does each store the credential, and how does it refresh? How can a program tell whether the CLI is signed in? Do the ACP adapters expose authentication (ACP `authenticate` and auth methods)?

**Our setting.** The CLI runs on the user's Computer, an E2B Linux sandbox whose disk persists while it sleeps. The Computer has a Screen: a desktop with Chrome that the user can see (`CONTEXT.md`).

**Sources.** Read on 2026-10-30:

- Claude Code: [Authentication](https://code.claude.com/docs/en/authentication) and the [CLI reference](https://code.claude.com/docs/en/cli-reference). Latest release `v2.1.314` (2026-10-30).
- Claude ACP adapter: [`agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) at `main` `eb78afa8` (2026-10-30), release `v0.99.1`, on `@anthropic-ai/claude-agent-sdk` 0.3.312. Files: `src/acp-agent.ts`, `src/auth-status.ts` and `src/hide-claude-auth.ts`.
- Codex: [Authentication](https://learn.chatgpt.com/docs/auth) (formerly `developers.openai.com/codex/auth`) and [`openai/codex`](https://github.com/openai/codex) `main` (release `rust-v0.166.0`, 2026-10-29). Files: `codex-rs/cli/src/login.rs` and `codex-rs/config/src/types.rs`.
- Codex ACP adapter: [`agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp) at `main` `ef45a6d9` (2026-10-30), release `v2.5.0`. Files: `README.md`, `src/CodexAuthMethod.ts`, `src/CodexAcpClient.ts`, `src/CodexAcpServer.ts` and `src/AuthStatusMeta.ts`. The older [`zed-industries/codex-acp`](https://github.com/zed-industries/codex-acp) is archived and points to it.
- Gemini CLI: [`google-gemini/gemini-cli`](https://github.com/google-gemini/gemini-cli) at tag `v0.66.0` (2026-10-27). Files: `packages/core/src/code_assist/oauth2.ts`, `oauth-credential-storage.ts`, `packages/core/src/utils/browser.ts`, `packages/core/src/config/{config,storage}.ts`, `packages/cli/src/acp/acpRpcDispatcher.ts` and `docs/get-started/authentication.mdx`. Also the [Authentication page](https://geminicli.com/docs/get-started/authentication/) and Google's post [An important update: transitioning Gemini CLI to Antigravity CLI](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) (2026-05-19).
- ACP: [`agentclientprotocol/agent-client-protocol`](https://github.com/agentclientprotocol/agent-client-protocol) `docs/protocol/v1/authentication.mdx` (schema release `schema-v1.28.0`, 2026-10-30), [Initialization](https://agentclientprotocol.com/protocol/initialization), the [get-auth-state RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/get-auth-state.mdx), and `src/core/jsonrpc.ts` in [`agentclientprotocol/typescript-sdk`](https://github.com/agentclientprotocol/typescript-sdk).

Nothing was installed or run. Every claim below is from docs or source. Section 6 lists what still needs a hands-on check.

---

## Summary

|                                  | Claude Code                                                                                                   | Codex                                                                                                                           | Gemini CLI                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan that signs in               | Claude Pro, Max, Ultra, Team, Enterprise                                                                      | ChatGPT plans                                                                                                                   | **Since 2026-06-18, not Google AI Pro, Ultra or free users** (moved to Antigravity CLI). Code Assist Standard and Enterprise still work                           |
| Browser on the same machine      | `claude auth login` or `/login`; localhost callback                                                           | `codex login`; callback on `localhost:1455`                                                                                     | "Sign in with Google"; loopback callback; launched only when `DISPLAY` (or Wayland) is set                                                                        |
| No browser: URL plus pasted code | Yes: the browser shows a code, paste it at `Paste code here if prompted`                                      | No paste flow. Forward port 1455 over SSH instead                                                                               | Yes, with `NO_BROWSER=true`: open the URL, paste the code from `codeassist.google.com/authcode` at `Enter the authorization code:`. Needs an interactive terminal |
| Device code                      | No                                                                                                            | Yes: `codex login --device-auth` (beta, must be enabled in ChatGPT security settings)                                           | No                                                                                                                                                                |
| Long-lived token or env var      | `claude setup-token` prints a one-year OAuth token; set `CLAUDE_CODE_OAUTH_TOKEN`                             | Copy `~/.codex/auth.json` from another machine. `CODEX_ACCESS_TOKEN` is for enterprise workspaces only                          | `GOOGLE_CLOUD_ACCESS_TOKEN` with `GOOGLE_GENAI_USE_GCA` (a raw access token, no refresh)                                                                          |
| Credential on Linux              | `~/.claude/.credentials.json`, mode 0600 (`CLAUDE_CONFIG_DIR` moves it)                                       | `~/.codex/auth.json` by default (`CODEX_HOME` moves it; `cli_auth_credentials_store` can pick a keyring)                        | `~/.gemini/oauth_creds.json` (`GEMINI_CLI_HOME` moves it). `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true` switches to keychain or encrypted storage                   |
| Refresh                          | Automatic while the refresh token works; warns 3 days before expiry; then `Login expired · Please run /login` | Automatic before expiry for ChatGPT sessions                                                                                    | Automatic through Google's OAuth client, rewriting the cache file                                                                                                 |
| Signed-in check                  | `claude auth status` prints JSON; exit 0 if logged in, 1 if not; `authMethod` field                           | `codex login status`; exit 0 and "Logged in using ChatGPT", or exit 1 and "Not logged in". Does not prove the token still works | No status command. Check that the cache file exists, or call ACP `session/new` and catch the error                                                                |
| ACP adapter auth methods         | `terminal` type only (`claude-login`, `claude-ai-login`, `console-login`), plus `gateway` on opt-in           | `agent` type: `api-key`, `chat-gpt` (opens a browser), `chat-gpt-device-code` (needs URL elicitation), `gateway` on opt-in      | `agent` type: `oauth-personal`, `gemini-api-key`, `vertex-ai`, `gateway`                                                                                          |
| Adapter reports who is signed in | Yes: `_auth/status_update` extension (from `claude auth status --json`)                                       | Yes: `_auth/status_update` extension                                                                                            | No                                                                                                                                                                |

**For our Computer:** in every case the simplest path is a **one-time interactive login on the Computer, with the browser on the Screen**. Each CLI then writes a refreshable credential to the persistent disk, and the ACP adapter picks it up on the next start. The device-code and paste-code flows are fallbacks when the Screen is not used. Section 5 has the details.

---

## 1. Claude Code

### Login flows

- **Browser on the same machine.** On first launch, `claude` "opens a browser window for you to log in". `claude auth login` does the same from a shell before any session (Authentication, "Log in to Claude Code"). The flags are `--claudeai` (subscription) and `--console` (API billing). The CLI reference also lists `--email` and `--sso`.
- **URL plus pasted code.** "If the browser doesn't open automatically, press `c` to copy the login URL to your clipboard, then paste it into your browser. If your browser shows a login code instead of redirecting back after you sign in, paste it into the terminal at the `Paste code here if prompted` prompt." (Authentication). The ACP adapter says the CLI switches to this manual flow on a remote machine. Its check is `NO_BROWSER`, `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY` or `CLAUDE_CODE_REMOTE`, which "matches the SDK's internal isRemote check" (`claude-agent-acp` `src/acp-agent.ts`, `initialize`).
- **Device code.** None is documented.
- **Long-lived token.** `claude setup-token` "opens the same browser authorization flow as `/login`, and the token prints to the terminal after you approve access in the browser. It does not save the token anywhere". The token lasts one year. Set it as `CLAUDE_CODE_OAUTH_TOKEN`. It "requires a Pro, Max, Ultra, Team, or Enterprise plan", "can only make model requests", and is ignored in `--bare` mode (Authentication, "Generate a long-lived token").
- **Precedence.** Cloud provider env, then `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, Anthropic profiles, and last the subscription login from `/login` (Authentication, "Authentication precedence"). A stray `ANTHROPIC_API_KEY` on the Computer would silently bill the API instead of the plan.

### Storage and refresh

- "On Linux, credentials are stored in `~/.claude/.credentials.json` with file mode `0600`." `CLAUDE_CONFIG_DIR` moves the file (Authentication, "Credential management").
- The subscription login refreshes itself. Within three days of expiry the CLI warns `Your login expires in 3 days · run /login to renew`. "Once the stored login expires and can't be refreshed, each model request fails with `Login expired · Please run /login`" (Authentication, "Renew an expiring login"). The docs add that an unattended session "that outlives the login stops making progress".

### Signed-in check

- `claude auth status` shows "authentication status as JSON. Use `--text` for human-readable output. Exits with code 0 if logged in, 1 if not." Its `authMethod` field is one of `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper` or `third_party` (CLI reference).
- The adapter parses the same JSON fields: `loggedIn`, `apiProvider`, `subscriptionType`, `apiKeySource`, `email` and `orgName` (`src/auth-status.ts`, `fromCliStatus`). Note that `loggedIn` tracks only the claude.ai login. A logged-out run exits 1 but still prints valid JSON.
- `/status` in a session shows a `Login` row that reads `Expired — log in again` (v2.1.210 or later).

### ACP adapter (`claude-agent-acp`)

- Its `initialize` advertises **only `terminal` methods** for the plan login, and only when the client sets `clientCapabilities.auth.terminal` (or `_meta["terminal-auth"]`):
  - On a remote machine: `claude-login`, args `["--cli"]`, described as "Run `claude /login` in the terminal". The comment explains why: the `auth login` subcommand "would fall back to a device-code-like manual flow, which doesn't work well over ACP, so we offer the TUI login instead."
  - Otherwise: `claude-ai-login` (`--cli auth login --claudeai`) and `console-login` (`--cli auth login --console`).
- It also offers `gateway` and `gateway-bedrock` methods when the client sets `auth._meta.gateway`. These route to a custom endpoint and bypass the CLI login. It advertises `agentCapabilities.auth.logout`.
- There is no `agent`-type plan login, so `authenticate` cannot sign in to a plan. The client has to run the adapter binary itself in an interactive terminal with the extra args, then reconnect.
- It pushes an `_auth/status_update` notification with `{ kind, label, account }`, built from `claude auth status --json`. It runs once after `initialize` and again at the start of each prompt (`src/acp-agent.ts`, `probeCliAuthStatus`).
- A signed-out session fails with the ACP `auth_required` error (JSON-RPC code `-32000`).
- `--hide-claude-auth` is a flag for integrations that "must never bill a claude.ai subscription". It hides the claude.ai method and refuses subscription-billed turns with `reason: "claude_subscription_not_supported"` (`src/hide-claude-auth.ts`). We would **not** pass it, but it shows that the adapter's authors treat subscription use from third-party clients as something a client may need to turn off. That is a question for #1079.

## 2. Codex

### Login flows

- **Browser on the same machine.** `codex login` opens a browser. The default callback is `localhost:1455` (Codex Authentication).
- **Device code.** `codex login --device-auth`, or "Sign in with Device Code" in the TUI. It is beta and must be enabled first "in ChatGPT security settings (personal) or workspace permissions (admin)". The docs call it the preferred headless path. In source, `--device-auth` sets `open_browser = false`. When the server reports that device code is not enabled, it prints "Device code login is not enabled; falling back to browser login." and starts the localhost login server (`codex-rs/cli/src/login.rs`).
- **No paste flow.** The documented fallbacks are to copy `~/.codex/auth.json` from a machine with a browser, or to forward the port: `ssh -L 1455:localhost:1455 user@remote`.
- **Tokens and keys.** `printenv OPENAI_API_KEY | codex login --with-api-key` bills the API, not the plan. `codex login --with-access-token` with `CODEX_ACCESS_TOKEN` is for enterprise workspaces that an admin enabled.

### Storage and refresh

- `cli_auth_credentials_store` is one of `file`, `keyring`, `auto` or `ephemeral`. The source default is `File`: "Persist credentials in CODEX_HOME/auth.json" (`codex-rs/config/src/types.rs`). `CODEX_HOME` defaults to `~/.codex`.
- "For ChatGPT sessions, Codex refreshes tokens automatically before they expire." The CLI and the IDE extension share the cached login. "Treat `auth.json` like a password" (Codex Authentication).

### Signed-in check

- `codex login status` exits 0 with `Logged in using ChatGPT` (or API key, access token, and so on) and exits 1 with `Not logged in`. It prints to stderr (`login.rs`, `run_login_status`). It only loads the stored auth and does not refresh it or call the server, so a revoked token still reports as logged in.

### ACP adapter (`codex-acp`)

- It advertises `agent`-type methods, so the client calls `authenticate` (`src/CodexAuthMethod.ts`, `getCodexAuthMethods`):
  - `api-key`, always.
  - `chat-gpt`, unless `NO_BROWSER` is set. On `authenticate` it first checks for a working ChatGPT login (`accountRead({refreshToken: true})`). If there is none, it starts the App Server's ChatGPT login and calls `open(authUrl)` on the agent's machine, then waits for completion (`src/CodexAcpClient.ts`, `authenticateWithChatGpt`). **On our Computer this opens Chrome on the Screen.**
  - `chat-gpt-device-code`, only when the client supports **URL elicitation**. The adapter sends the client an elicitation with `verificationUrl` and the message "Sign in to ChatGPT and enter this code: …", then waits for login to complete (`authenticateWithChatGptDeviceCode`). Without that capability it refuses with "Device code authentication requires URL elicitation support".
  - `gateway`, when the client sets `auth._meta.gateway`.
- `session/new` and `session/load` throw `auth_required` when no login exists (`src/CodexAcpServer.ts`, `checkAuthorization`).
- It pushes `_auth/status_update` with `kind` set to `account`, `api_key`, `gateway`, `external` or `none`, plus `account.email` and `plan`. This is "an interim `_meta`-based ACP extension". It is sent once after `initialize` and on every change, including a login or logout made in another terminal (`src/AuthStatusMeta.ts`).
- The archived `zed-industries/codex-acp` README noted that ChatGPT login "doesn't work in remote projects". The new adapter's answers are the device-code method and `NO_BROWSER`.

## 3. Gemini CLI

### The plan route is gone for consumer plans

Google's post of 2026-05-19 says: on **June 18, 2026**, Gemini CLI and the Gemini Code Assist IDE extensions "stop serving requests" for Google AI Pro, Google AI Ultra and free individual users. Code Assist Standard and Enterprise are unchanged, and Gemini CLI "will remain accessible via paid Gemini and Gemini Enterprise Agent Platform API keys". The replacement is **Antigravity CLI** (`agy`), written in Go. The geminicli.com Authentication page now opens with: "Gemini CLI was replaced by Antigravity CLI on June 18th, 2026" for unpaid tier and Google One users.

So "Sign in with Google" in Gemini CLI is now a plan route only for Code Assist Standard or Enterprise licences. This section still records how it works, because those licences and a future `agy` share the shape. Antigravity CLI's own login and ACP support were **not** verified (section 6).

### Login flows (v0.66.0)

- **Browser on the same machine.** Select "Sign in with Google". The docs say it "requires a web browser on a machine that can communicate with the terminal running Gemini CLI". The callback is a loopback server on `127.0.0.1` (`OAUTH_CALLBACK_HOST` and `OAUTH_CALLBACK_PORT` override it) (`oauth2.ts`).
- **When it launches a browser.** `isBrowserLaunchSuppressed()` is `NO_BROWSER || !shouldAttemptBrowserLaunch()` (`config.ts`). On Linux, `shouldAttemptBrowserLaunch` returns false without `DISPLAY`, `WAYLAND_DISPLAY` or `MIR_SOCKET`, under `CI`, or with `BROWSER=www-browser`. **With `DISPLAY` set to the Screen's display, it launches the browser on the Screen** (`utils/browser.ts`).
- **URL plus pasted code.** When the browser is suppressed, `authWithUserCode` prints an auth URL whose redirect is `https://codeassist.google.com/authcode` and reads `Enter the authorization code:` from the terminal. It retries twice. In a **non-interactive** session it throws "Manual authorization is required but the current session is non-interactive…" (`oauth2.ts`). An ACP process is non-interactive, so this flow cannot run under ACP.
- **Device code.** None.
- **Token or env var.** With `GOOGLE_GENAI_USE_GCA` and `GOOGLE_CLOUD_ACCESS_TOKEN` set, it uses that raw access token without refreshing it. `GEMINI_API_KEY` and Vertex AI use API billing. In Google Cloud environments it can use Compute ADC.

### Storage and refresh

- By default the OAuth tokens go to `oauth_creds.json` in the Gemini directory, which is `~/.gemini` (`GEMINI_CLI_HOME` overrides the home). `Storage.getOAuthCredsPath()` gives the path, and `cacheCredentials` writes it (`storage.ts`, `oauth2.ts`).
- With `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true`, `OAuthCredentialStorage` uses a keychain or encrypted-file store instead. It migrates the old file (`oauth-credential-storage.ts`).
- Refresh: the OAuth2 client's `tokens` event rewrites the cache on every refresh. On load it validates the cached token with `getAccessToken()` and `getTokenInfo()`, then falls through to a new login if that fails (`oauth2.ts`).

### Signed-in check

- No `auth status` command was found. A program can check for `~/.gemini/oauth_creds.json` and `security.auth.selectedType` in `~/.gemini/settings.json`, which the ACP `authenticate` writes. The only proof that the token works is an ACP `authenticate` or `session/new` that succeeds.

### ACP (built in: `gemini --acp`; `--experimental-acp` remains as an alias)

- `initialize` advertises `agent`-type methods with ids from `AuthType`: `oauth-personal` ("Log in with Google"), `gemini-api-key` (key in `_meta["api-key"]`), `vertex-ai` and `gateway` (`acpRpcDispatcher.ts`).
- `authenticate` calls `config.refreshAuth(method, …)`. This reuses valid cached credentials. Otherwise it runs the OAuth flow above, which opens a browser only when one can be launched. It then saves `security.auth.selectedType`. Switching method clears the cached credential file. Errors come back as JSON-RPC `-32000`.
- It does not advertise `logout` and has no auth-status extension.

## 4. ACP authentication (spec)

- Agents list `authMethods` in the `initialize` response, each with an `id`, a `name`, an optional `description` and an optional `type`. There are two types (`docs/protocol/v1/authentication.mdx`):
  - **`agent`** (the default): the client calls `authenticate { methodId }`, which returns `{}` on success. "After successful authentication, the Client can create new sessions without receiving an `auth_required` error."
  - **`terminal`**: allowed only if the client set `clientCapabilities.auth.terminal: true`. The client "launches a separate interactive process using the same configured Agent program", appends `args`, applies `env`, and "presents the terminal to the user". Exit 0 means success, and the client then reconnects and reinitializes. "The Client **MUST NOT** send an `authenticate` request for a terminal method."
- `logout` is available only when the agent advertises `agentCapabilities.auth.logout`. What happens to running sessions after `logout` is undefined.
- `auth_required` is JSON-RPC error `-32000` (`RequestError.authRequired` in the TypeScript SDK).
- There is **no standard way to ask "am I signed in?"** The `auth/status` method is only an RFD ("Agent Authentication State Query"). Its motivation section says `session/new` is unreliable for this, because "some agents validate credentials eagerly, others … lazily". The Claude and Codex adapters fill the gap with the `_auth/status_update` `_meta` extension, which they mark as interim.
- Device code reaches the client through **URL elicitation** (Codex). In ACP that is a client capability, not an auth method type.

## 5. What this means for the Computer

These are inferences from the facts above, for #1082:

1. **The Screen turns every CLI's "browser on this machine" flow into a working flow.** The Computer has a display and Chrome, so the localhost or loopback callback lands on the same machine:
   - `claude auth login --claudeai`.
   - `codex login`, or ACP `authenticate chat-gpt`, which calls `open(authUrl)` itself.
   - Gemini's "Sign in with Google" once `DISPLAY` is set.

   The user signs in to the vendor in Chrome on the Screen. No code is copied, and no port is forwarded. The cost is that the vendor password, and any 2FA, are typed into the sandbox's Chrome.

2. **The credential lives on the Computer's persistent disk** in all three cases: `~/.claude/.credentials.json`, `~/.codex/auth.json` and `~/.gemini/oauth_creds.json`. Each refreshes itself, so a sleeping Computer is fine as long as the refresh token stays valid. The OS keyring must stay off: Codex defaults to `file`, and Gemini uses the file unless `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE` is set. A keyring would likely not unlock in the sandbox.
3. **Without the Screen**, the fallbacks are:
   - Codex: device code, through the adapter's `chat-gpt-device-code` method if our ACP client implements URL elicitation, or `codex login --device-auth` in a terminal. The user must enable device code in ChatGPT settings first.
   - Claude: the pasted-code flow in a terminal on the Computer (`claude` `/login`), which is what the adapter's `terminal` method runs. Our client would need a terminal the user can type into, such as the Screen's terminal. Or the user runs `claude setup-token` anywhere and pastes the token, which we store as `CLAUDE_CODE_OAUTH_TOKEN` for one year with no refresh.
   - Gemini: only an interactive terminal with `NO_BROWSER=true`, never through ACP.
4. **Detecting sign-in**, from best to worst:
   - Claude: `claude auth status` (exit code plus JSON).
   - Codex: `codex login status` (exit code only; does not check the token is still valid).
   - Gemini: the cache file exists.
   - Any adapter: listen for `_auth/status_update` (Claude and Codex), or catch `auth_required` (`-32000`) from `session/new` or a prompt.

   Expiry shows up as `auth_required` mid-task. For Claude the docs warn that unattended sessions stall at that point.

5. **ACP shapes differ.** Claude's plan login is `terminal`-only, so our client would run the adapter with extra args in a terminal on the Computer. Codex and Gemini use `agent` `authenticate`. A single "sign in" UI needs both paths, or it can skip ACP auth entirely and run each CLI's own login command on the Screen.
6. **Gemini as a plan provider is in question.** Consumer Google plans no longer work in Gemini CLI. The plan path is Antigravity CLI, whose ACP support and headless login were not verified.

## 6. Open points (not verified here)

- **Antigravity CLI (`agy`).** Does it have an `--acp` mode? How does it log in on a remote machine, where does it store the credential, and does it need a keyring? Its [getting-started page](https://antigravity.google/docs/getting-started?tab=cli) lists `auth.type` values `oauth-personal` ("Authenticates personal Free, Pro, and Ultra plans"), `oauth-business`, `gemini-api-key` and `agent-platform`, but says nothing about ACP or headless login. Community reports conflict, so they are not cited as fact. This probably needs its own ticket under #978, or a note on #1078.
- Whether `claude auth login` and `codex login` actually open Chrome on an E2B desktop through `xdg-open` with `DISPLAY` set. This is expected but untested; a quick probe belongs in #1082.
- How long the Claude subscription refresh token lasts (the docs only give the 3-day warning) and how long the Codex refresh token lasts.
- Whether the vendors' terms allow this use at all: #1079.

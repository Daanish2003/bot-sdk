# ACP adapters for Claude Code, Codex and Gemini CLI

Research for [#1078](https://github.com/Daanish2003/bot-sdk/issues/1078) (child of map [#978](https://github.com/Daanish2003/bot-sdk/issues/978)). Researched 2026-10-30 against the ACP spec, the adapters' repos and source, and the vendors' own docs. Versions and commit SHAs are the ones current on that date.

## Question

Do maintained Agent Client Protocol adapters exist for Claude Code, Codex and Gemini CLI, and what does a client have to do to drive one headless on a Linux machine (our Computer)? Cover: where each adapter comes from and how it is maintained; the protocol surface a client implements; whether each CLI can be forced to ask permission before every edit or command (no auto-approve); how custom ACP agents (Goose, Qwen Code) are launched; whether there is a TypeScript client library; and any CLI without a usable ACP adapter, with its native fallback.

## Verdict

All three have a maintained ACP agent, and all three are listed in the official ACP registry. **No CLI needs a native fallback.** A client is a stdio JSON-RPC parent process, and the official TypeScript SDK `@agentclientprotocol/sdk` implements the client side.

| CLI         | ACP agent                                                                | Who maintains it                                                  | Launch on Linux                                | Version (2026-10-30)                      | Strictest "ask" mode over ACP                                                             |
| ----------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| Claude Code | Adapter `@agentclientprotocol/claude-agent-acp` [C1]                     | ACP org; registry lists Anthropic, Zed, JetBrains as authors [R1] | `npx -y @agentclientprotocol/claude-agent-acp` | 0.99.1 (2026-10-29), main `eb78afa8` [C1] | `default` ("Manual"): asks for every edit and non-read-only Bash [CC1]                    |
| Codex       | Adapter `@agentclientprotocol/codex-acp`, over the Codex App Server [X1] | ACP org; registry lists OpenAI, JetBrains, Zed [R2]               | `npx -y @agentclientprotocol/codex-acp`        | 2.5.0 (2026-10-29), main `ef45a6d9` [X1]  | `read-only`: asks for every write; commands run unasked inside the read-only sandbox [X2] |
| Gemini CLI  | **Native**: `gemini --acp` (no adapter) [G1]                             | Google, in the CLI's own repo [G2]                                | `npx -y @google/gemini-cli --acp`              | 0.66.0 (2026-10-27), main `a6094669` [G2] | `default`: "Prompts for approval" for edits and shell [G3]                                |
| Goose       | Native: `goose acp` [GS1]                                                | Block / `aaif-goose`                                              | `goose acp`                                    | 1.57.0 (2026-10-28) [R4]                  | `GOOSE_MODE=approve` (default is `auto`) [GS2]                                            |
| Qwen Code   | Native: `qwen --acp` [R5]                                                | Alibaba Qwen team                                                 | `npx -y @qwen-code/qwen-code --acp`            | 0.26.4 in the registry [R5]               | "Ask Permissions" (`default`); out of the box it is the classifier `auto` [Q1]            |

**Three findings that bear on the map's premise:**

1. **No CLI asks by default.** codex-acp starts in `agent` mode, which is Codex's own _Auto review_ ("Only ask for actions detected as potentially unsafe") [X2]. Qwen Code defaults to a classifier `auto` mode [Q1], and Goose to `auto` [GS2]. The Helper must set the mode explicitly at session start (`session/set_mode`, or a config option), and check `current_mode_update` notifications: an agent may change its own mode during a turn (for example Claude's plan-mode exit).
2. **"Ask before every command" is not exactly reachable on Codex through the adapter.** The adapter's four modes use the approval policy `on-request` or `never`, and it sets the policy on every turn from the mode [X2][X3], so a `CODEX_CONFIG` override of `approval_policy` (for example `untrusted`) is replaced. In `read-only` mode every write and every network or out-of-sandbox action asks, but read-only commands run in the sandbox without a permission request. Claude and Gemini also run read-only tools (file reads, grep, and on Claude a built-in set of read-only Bash commands) without asking [CC1]. On Claude, a settings `ask` rule can force a prompt for more [CC1]. So the realistic premise is "**every edit and every side-effecting command** goes through Auto-review", not literally every tool call.
3. **Claude plan login through this adapter conflicts with Anthropic's Agent SDK terms.** The Claude adapter is built on the Claude Agent SDK [C1], and the SDK docs say: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." [CC2] The adapter offers a claude.ai login method by default and has a `--hide-claude-auth` flag for integrations that "must never bill a claude.ai subscription" [C2]. That is a question for the terms ticket of this map, but it may mean the Claude coding-agent Helper must run on an API key or Console login, not the user's Claude plan.

## Where each adapter comes from

### Claude Code: `agentclientprotocol/claude-agent-acp`

- Repo [C1], Apache-2.0 (the registry entry says `proprietary`, presumably because it bundles the Claude Agent SDK, which is under Anthropic's Commercial Terms [CC2]). Formerly `zed-industries/claude-code-acp`; the old repo name now redirects to the ACP org.
- Built on `@anthropic-ai/claude-agent-sdk` 0.3.312 and `@agentclientprotocol/sdk` 2.2.0 (`package.json` at `eb78afa8`). The SDK runs the `claude` binary, so the user's Claude Code settings in `~/.claude` and the project's `.claude/` are loaded too [CC2].
- Very active: 0.99.1 released 2026-10-29, last push 2026-10-30, a `preview` npm channel built from every push to `main` [C1].
- Supports tool calls with permission requests, edit review, plans (TODO lists), slash commands, client MCP servers, subagent sessions, and the draft ACP v2 [C1].
- Auth methods it advertises (`src/acp-agent.ts`): on a headless machine (`NO_BROWSER`, `SSH_*` or `CLAUDE_CODE_REMOTE` set) a single "Run `claude /login` in the terminal" method; otherwise "Claude Subscription" (`auth login --claudeai`) and "Anthropic Console" (`auth login --console`). Gateway and Bedrock methods also exist. `--hide-claude-auth` removes the subscription method and refuses any turn a subscription would pay for (`src/hide-claude-auth.ts`) [C2].
- Permission modes (`src/permissions/modes.ts`): `default` (Claude Code 2.1.200 renamed it "Manual"), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. `bypassPermissions` is refused when running as root unless `IS_SANDBOX` is set [C3]. The adapter routes the SDK's `canUseTool` callback to `session/request_permission` (`src/acp-agent.ts`, `requestPermissionFromClient`).

### Codex: `agentclientprotocol/codex-acp`

- Repo [X1]. The first adapter, `zed-industries/codex-acp` (Rust, wrapped the Codex CLI), was **archived** in 2026-07 with the note: "Development has moved to agentclientprotocol/codex-acp. The new adapter is built on the new Codex App Server … Use `@agentclientprotocol/codex-acp` for new installs." [X4]
- TypeScript; "starts the Codex App Server, translates ACP requests into Codex operations, and maps Codex events back into the client" [X1]. The npm package bundles a compatible `@openai/codex` (`^0.165.0` at `ef45a6d9`; Codex itself was at `rust-v0.166.0` on 2026-10-29). `CODEX_PATH` picks another binary.
- 2.5.0 released 2026-10-29; preview channel from `main`; a `codex-update.yml` workflow tracks Codex releases [X1].
- Auth methods: ChatGPT login (hidden when `NO_BROWSER=1`), `CODEX_API_KEY` / `OPENAI_API_KEY`, or a client-provided gateway [X1]. On a headless Computer the user would sign in once in a terminal on the Computer: the Codex CLI has a device-code login (`codex login --device-auth`, `codex-rs/cli/src/login.rs`) [X5]. Not verified: that codex-acp then picks up `~/.codex` credentials without its own browser method; it runs the same App Server, so it should.
- Modes (`src/AgentMode.ts`, `INITIAL_AGENT_MODE`) [X2]:

  | Mode id             | Approval policy | Reviewer      | Sandbox                     |
  | ------------------- | --------------- | ------------- | --------------------------- |
  | `read-only`         | `on-request`    | `user`        | read-only, no network       |
  | `workspace-write`   | `on-request`    | `user`        | workspace write, no network |
  | `agent` (default)   | `on-request`    | `auto_review` | workspace write, no network |
  | `agent-full-access` | `never`         | `user`        | `danger-full-access`        |

  `runTurn` passes `agentMode.approvalPolicy` and `approvalsReviewer` on every turn (`src/CodexAcpClient.ts`) [X3]. `workspace-write` lets Codex edit workspace files without asking. Only `read-only` asks before every edit.

### Gemini CLI: built in

- `gemini --acp` (formerly `--experimental-acp`, now deprecated) is in Google's own repo, `packages/cli/src/acp/` [G1][G2]. It depends on `@agentclientprotocol/sdk` 0.16.1, an older SDK than the other two (2.2.0).
- Methods it documents: `initialize`, `authenticate`, `newSession`, `loadSession`, `prompt`, `cancel`, `setSessionMode`, `unstable_setSessionModel`; a proxied file system through the client [G1].
- Auth methods advertised at `initialize` (`acpRpcDispatcher.ts`): Log in with Google, Gemini API key, Vertex AI, and an AI API gateway [G4].
- Session modes (`acpUtils.ts`, `buildAvailableModes`): Default ("Prompts for approval"), Auto Edit, YOLO, and Plan (read-only) when plan is enabled [G3]. The CLI flag `--approval-mode` takes `default | auto_edit | yolo | plan` [G5].
- MCP permission requests carry `toolCall._meta['gemini-cli'].mcp.server_name` and `tool_name` [G1].
- Google also ships a separate, proprietary Antigravity ACP server (`agy_acp_server.par`, linux-x86_64 binary) in the registry [R3]. That is what OpenBot uses for Gemini plans (`docs/research/openbot-inventory.md` section 4). It is not Gemini CLI.

## The protocol a client implements (ACP v1)

Spec: [agentclientprotocol.com](https://agentclientprotocol.com/protocol/overview); repo `agentclientprotocol/agent-client-protocol`, schema `v1.28.0` (2026-10-30), main `ef8263a0` [A1]. A v2 draft exists; the Claude adapter serves both and negotiates by `protocolVersion` [C1]. Build on v1.

**Transport** [A2]: stdio only. "The client launches the agent as a subprocess." Newline-delimited JSON-RPC 2.0, one message per line; stdout is protocol only; stderr is free-form logs. A Streamable HTTP remote transport is still an RFD. So the Helper's client runs **on the Computer next to the CLI** (or pipes stdio over the sandbox's process API).

**Client → agent** [A1]:

- `initialize` (required): protocol version, `clientCapabilities` (`fs.readTextFile`, `fs.writeTextFile`, `terminal`), returns `agentCapabilities` and `authMethods`.
- `authenticate` (required when the agent asks): picks one of the advertised `authMethods`.
- `session/new` (required): `cwd`, `mcpServers`; returns `sessionId`, and modes or config options.
- `session/prompt` (required): content blocks; resolves with a `stopReason`: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled` [A3].
- `session/cancel` (notification), `session/load` (if `loadSession`), `session/set_mode` (optional), `logout` (optional).

**Agent → client**:

- `session/update` notifications [A3]: `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`, `plan`, `tool_call`, `tool_call_update`, `available_commands_update`, `current_mode_update`, and newer `config_option_update`, `session_info_update`, `usage_update`, `notice`, `compaction_update`.
- Tool calls [A4]: `toolCallId`, `title`, `kind` (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`), `status` (`pending`, `in_progress`, `completed`, `failed`), `content` (content blocks, `diff` with `path`/`oldText`/`newText`, or `terminal`), `locations`, `rawInput`, `rawOutput`.
- `session/request_permission` (required for every client) [A4]: `sessionId`, `toolCall`, `options[]` of `{optionId, name, kind}` with `kind` one of `allow_once`, `allow_always`, `reject_once`, `reject_always`. The client answers `{outcome: "selected", optionId}` or `{outcome: "cancelled"}`. "The Agent owns remembered decisions and their scope", so **Auto-review should only ever pick `allow_once` or `reject_once`**; picking an `allow_always` option makes the CLI stop asking for that kind of action.
- `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`: only if the client advertised the capability. `elicitation/create` is newer and also capability-gated [A1].

**Cancellation** [A3]: the client sends `session/cancel`, must answer every pending `session/request_permission` with `cancelled`, and should keep accepting `tool_call_update`s; the agent ends the turn with `stopReason: "cancelled"`.

**For our Helper**: the CLI runs on the Computer, so the client need not offer `fs` or `terminal` and the agent uses the Computer's disk and shell itself. Offering `fs/write_text_file` would route writes through us, but the permission request comes before the write anyway, so it adds nothing for Auto-review. (Not tested per agent: whether each agent falls back cleanly when the client declares neither.)

The ACP org also publishes `acp-tck`, a test kit that drives an agent over stdio through initialize, sessions, prompt turns and cancellation [A5]. Useful as a fake-agent reference for our tests.

## Forcing "ask" mode, per CLI

| CLI         | Set it                                                    | What still runs without a request                                                                                                | Turn off the escape hatches                                                                                                                                                    |
| ----------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | mode `default`; `settings.json` `permissions.defaultMode` | Read-only tools in the working directory; a built-in set of read-only Bash commands; preapproved docs domains for WebFetch [CC1] | `ask` rules force a prompt even when an allow rule or hook would allow it; `permissions.disableBypassPermissionsMode` / `disableAutoMode: "disable"` in managed settings [CC1] |
| Codex       | `INITIAL_AGENT_MODE=read-only` or `session/set_mode`      | Commands inside the read-only, no-network sandbox [X2]                                                                           | None through the adapter: the per-turn policy is fixed by the mode [X3]                                                                                                        |
| Gemini CLI  | session mode `default` or `--approval-mode default`       | Read-only tools; anything allowed by the user's policy or `tools.allowed` settings                                               | Keep the Computer's Gemini settings free of allow lists                                                                                                                        |
| Goose       | `GOOSE_MODE=approve` [GS2]                                | Per Goose's permission docs                                                                                                      | Default is `auto`, so this must be set                                                                                                                                         |
| Qwen Code   | `tools.approvalMode: "default"` ("Ask Permissions") [Q1]  | Read-only tools                                                                                                                  | Default is the classifier `auto`, so this must be set                                                                                                                          |

Because the user's own CLI config lives on the Computer and is read by each CLI, the user (or the CLI's own "allow always" choice) can widen what runs unasked. The Helper should pin the mode on every session and treat `current_mode_update` to a looser mode as a reason to cancel.

## Custom ACP agents (Goose, Qwen Code)

A custom agent is just a command line that speaks ACP on stdio. The registry [R0] describes each agent as either an `npx` package plus `args`, or a per-platform `binary` archive with `cmd`, `args` and a `sha256` (for example Goose's `linux-x86_64` archive with `./goose acp`) [R4]. Qwen Code's entry is `npx @qwen-code/qwen-code@0.26.4 --acp --experimental-skills` [R5]. Goose's own guide launches `spawn("goose", ["acp"])` and wraps the pipes with the TypeScript SDK's `ndJsonStream` [GS1]. So "custom ACP agent" in our product is: a command, args and env, run on the Computer; optionally picked from the registry's JSON.

## TypeScript client library

Yes: `@agentclientprotocol/sdk` (`agentclientprotocol/typescript-sdk`), the official SDK for both sides, v2.2.0 released 2026-10-30 [A6]. Entry points: `@agentclientprotocol/sdk` (stable v1, default), `/unstable`, `/experimental/v2`, `/experimental/v2/unstable`. It provides `ndJsonStream(writable, readable)` and a client builder with handlers per method, for example `.onNotification(acp.methods.client.session.update, …)` and `.onRequest(acp.methods.client.session.requestPermission, …)` [GS1]. Both adapters depend on 2.2.0; adding it to our repo is a new dependency and needs owner approval (AGENTS.md section 6).

## Missing adapters and native fallbacks

None is missing. For the record, the native fallbacks the map allows, should one break:

- Claude Code: the Claude Agent SDK (`canUseTool` callback) or `claude -p --output-format stream-json` [CC2].
- Codex: the Codex App Server, which is what codex-acp drives [X1].
- Gemini CLI: none needed; ACP is its built-in programmatic mode.

## Sources

- [A1] ACP overview, methods and capabilities: https://agentclientprotocol.com/protocol/overview ; repo https://github.com/agentclientprotocol/agent-client-protocol (release `schema-v1.28.0`, 2026-10-30; main `ef8263a016c548390ef0a5457e212c1772009431`)
- [A2] ACP transports: https://agentclientprotocol.com/protocol/transports
- [A3] ACP prompt turn: https://agentclientprotocol.com/protocol/prompt-turn
- [A4] ACP tool calls and permission requests: https://agentclientprotocol.com/protocol/tool-calls
- [A5] ACP test kit: https://github.com/agentclientprotocol/acp-tck
- [A6] TypeScript SDK: https://github.com/agentclientprotocol/typescript-sdk (v2.2.0, 2026-10-30)
- [C1] Claude adapter: https://github.com/agentclientprotocol/claude-agent-acp (v0.99.1, 2026-10-29; main `eb78afa8556b8fc4082495e48e3fd1762fb6a50f`), README and `package.json`
- [C2] `src/acp-agent.ts` (auth methods) and `src/hide-claude-auth.ts` at the same commit
- [C3] `src/permissions/modes.ts` at the same commit
- [CC1] Claude Code permissions: https://code.claude.com/docs/en/permissions (read 2026-10-30)
- [CC2] Claude Agent SDK overview (claude.ai login note, Commercial Terms): https://code.claude.com/docs/en/agent-sdk/overview (read 2026-10-30)
- [X1] Codex adapter: https://github.com/agentclientprotocol/codex-acp (v2.5.0, 2026-10-29; main `ef45a6d97cd81810aaebcba9533af5411dadec6f`), README and `package.json`
- [X2] `src/AgentMode.ts` at the same commit
- [X3] `src/CodexAcpClient.ts` (`runTurn` call) at the same commit
- [X4] Archived first adapter: https://github.com/zed-industries/codex-acp (archived; last push 2026-07-22)
- [X5] Codex CLI device-code login: https://github.com/openai/codex `codex-rs/cli/src/login.rs` (latest release `rust-v0.166.0`, 2026-10-29)
- [G1] Gemini CLI ACP mode: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md
- [G2] Gemini CLI repo: https://github.com/google-gemini/gemini-cli (v0.66.0, 2026-10-27; main `a60946692b11e2f144a8fe4db46bbc4e514daa7a`), `packages/cli/src/acp/`, `packages/cli/package.json`
- [G3] `packages/cli/src/acp/acpUtils.ts` (`buildAvailableModes`)
- [G4] `packages/cli/src/acp/acpRpcDispatcher.ts` (`initialize`)
- [G5] `packages/cli/src/config/config.ts` and `docs/cli/cli-reference.md` (`--acp`, `--experimental-acp`, `--approval-mode`)
- [GS1] Goose, "Build an app with goose": https://github.com/aaif-goose/goose/blob/main/documentation/docs/gdk/acp/index.md
- [GS2] Goose config files (`GOOSE_MODE`: `auto`, `approve`, `chat`, `smart_approve`; default `auto`): https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/config-files.md
- [Q1] Qwen Code approval modes: https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/approval-mode.md
- [R0] ACP registry: https://github.com/agentclientprotocol/registry (main `097724711ede52f99cfa4fdd838af307fa1ba957`, 2026-10-30)
- [R1] `claude-acp/agent.json`; [R2] `codex-acp/agent.json`; [R3] `antigravity-acp/agent.json`; [R4] `goose/agent.json`; [R5] `qwen-code/agent.json` in the registry at the same commit

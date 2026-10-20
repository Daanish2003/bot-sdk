# Secrets as environment variables on the E2B Computer

Research for [#683](https://github.com/Daanish2003/ai-chat/issues/683), a child of map [#420](https://github.com/Daanish2003/ai-chat/issues/420) (Bot step 9, Safety). Facts only, no pick. Inferences are marked **Inference**; things not checked are marked **Not verified**.

Read on 2026-10-21. Sources:

- The `e2b` JS SDK installed in the repo: `e2b@2.55.0` (`packages/bot-sdk/package.json` pins `"e2b": "2.55.0"`), read from `node_modules/.pnpm/e2b@2.55.0/node_modules/e2b/dist/` (`index.d.ts`, `index.mjs`). Cited below as `dist/index.d.ts Lnnn`.
- E2B runtime (envd, orchestrator, API, Embed), `e2b-dev/runtime` at commit [`568c7f09`](https://github.com/e2b-dev/runtime/tree/568c7f0959936c4da58b910fcc03fac0c68a6320). Links use `RT/` for `packages/` at that commit.
- E2B docs at `docs.e2b.dev` (`.md` form of each page).
- GitHub Actions docs and `actions/runner` at commit [`5fea684c`](https://github.com/actions/runner/tree/5fea684c16ea010a8d2b0d32dd60bae8a6372f46), for masking prior art.
- Lecture write-up: first comment of [#383](https://github.com/Daanish2003/ai-chat/issues/383).

Earlier findings not repeated: [`docs/research/always-on-agent/e2b-sdk-envd.md`](https://github.com/Daanish2003/ai-chat/blob/research/503-e2b-sdk-envd/docs/research/always-on-agent/e2b-sdk-envd.md) on `research/503-e2b-sdk-envd` (commands, pause modes, Embed).

## Where the repo is today

- `create()` calls `Sandbox.create(template, { ...connection, timeoutMs, lifecycle: { onTimeout: "pause" }, network: { allowPublicTraffic: false } })`. No `envs`. ([`packages/bot-sdk/plugins/computer/e2b/index.ts` L96-L104](../../../packages/bot-sdk/plugins/computer/e2b/index.ts))
- `run()` calls `sandbox.commands.run(script, { background: true, timeoutMs: 0, onStdout, onStderr })`, where `script` wraps the model's command in `exec setsid -w bash -l -c '<command>'`. No `envs`. stdout and stderr go into `boundedOutput()`, which "keeps only its ends", and that text goes back to the model. (same file, L153-L173)

## 1. The two `envs` the SDK offers

### Per-sandbox: `Sandbox.create({ envs })`

- Typed as "Custom environment variables for the sandbox. Used when executing commands and code in the sandbox. Can be overridden with the `envs` argument when executing commands or code. @default {}". (`dist/index.d.ts` L9262-L9267)
- The SDK sends them to the control-plane API as `envVars` in the `POST /v2/sandboxes` body. (`dist/index.mjs` L5394-L5397, L5412)
- The API puts them on the orchestrator's `SandboxCreateRequest.Sandbox.EnvVars` ([RT/api/internal/orchestrator/create_instance.go L428](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/packages/api/internal/orchestrator/create_instance.go#L428)); the orchestrator stores them as `Envd.Vars` ([RT/orchestrator/pkg/server/sandboxes.go L352-L356](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/packages/orchestrator/pkg/server/sandboxes.go#L352-L356)) and posts them to envd's `/init` as `envVars` ([RT/orchestrator/pkg/sandbox/envd.go L258-L273](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/packages/orchestrator/pkg/sandbox/envd.go#L258-L273)). The field is `json:"envVars,omitempty"` ([RT/orchestrator/pkg/sandbox/envd/envd.gen.go L368-L369](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/packages/orchestrator/pkg/sandbox/envd/envd.gen.go#L368-L369)).
- envd keeps them in memory, in `defaults.EnvVars`, via `ReplaceUserVars` ([RT/envd/internal/api/init.go L445-L449](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/packages/envd/internal/api/init.go#L445-L449)). It logs only the keys: `"Setting %d env vars: %s"` with `strings.Join(keys, ", ")` (same lines).
- User entries cannot overwrite envd's own internal entries (`E2B_SANDBOX_ID`, `E2B_TEMPLATE_ID`). ([RT/envd/internal/utils/envvars.go L5-L80](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/packages/envd/internal/utils/envvars.go#L5-L80))

### Per-command: `commands.run(cmd, { envs })`

- Typed as "Environment variables used for the command. This overrides the default environment variables from `Sandbox` constructor. @default `{}`". (`dist/index.d.ts` L5500-L5507)
- The SDK puts them in the Connect RPC `process.Start` request as `process.envs`, next to `cmd: "/bin/bash"`, `args: ["-l", "-c", cmd]`. They go straight to envd, not through the control plane. (`dist/index.mjs` L4845-L4855)
- PTYs take the same option (`pty.create({ envs })`); the SDK adds `TERM`, `LANG`, `LC_ALL` defaults. (`dist/index.d.ts` L5395-L5401; `dist/index.mjs` L4563-L4574)

### How envd builds a process's environment

envd builds `cmd.Env` from scratch, in this order ([RT/envd/internal/services/process/handler/handler.go L254-L275](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/packages/envd/internal/services/process/handler/handler.go#L254-L275)):

1. `PATH` from envd's own environment ("Take only 'PATH' variable from the current environment"), then `HOME`, `USER`, `LOGNAME` for the target user.
2. Every entry of `defaults.EnvVars` (the per-sandbox `envs`, plus `E2B_SANDBOX_ID` etc.).
3. Every entry of the request's `envs`. "Only the last values of the env vars are used - this allows for overwriting defaults".

So both kinds end up as ordinary `execve` environment entries of `/bin/bash -l -c …`.

## 2. Pause and resume

- On resume the API builds `SandboxMetadata` with no `EnvVars` field set ([RT/api/internal/handlers/sandbox_resume.go L379-L397](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/packages/api/internal/handlers/sandbox_resume.go#L379-L397)); on create it sets `EnvVars: sbxData.EnvVars` (create_instance.go L428). With `omitempty`, the resume `/init` carries no `envVars`, and envd only touches its env when `data.EnvVars != nil` (init.go L445).
- **Inference:** a memory resume (the default, and what `lifecycle: { onTimeout: "pause" }` does) keeps the per-sandbox `envs`, because envd's RAM, including `defaults.EnvVars`, is restored from the snapshot and nothing replaces it.
- **Inference:** a filesystem-only pause (`mode: 'filesystem'`) or `connect({ onResume: 'reboot' })` boots a fresh envd with an empty `defaults.EnvVars`, and the resume path does not resend them, so per-sandbox `envs` are lost. The Computer would have to pass them again (per command). Not tested.
- Per-command `envs` live only in the process. A memory resume keeps a running process and its environment; a filesystem-only resume does not keep processes at all (see the 503 research).
- **Inference:** a memory snapshot is a copy of guest RAM, so envd's map and every live process's environment block are in the pause snapshot on the host's disk (on Embed, the machine's own disk, per the 503 research). Nothing in the docs says snapshots are encrypted at rest on Embed. Not verified.

## 3. Where a value is visible

| Place                                     | Per-sandbox `envs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Per-command `envs`                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `env`, `echo $X`, `printenv` in a command | Yes, every command                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Yes, that command                                                                                                                                                                                                                                                                                                                    |
| Child processes                           | Yes, inherited (standard `execve` semantics; envd sets no filtering)                                                                                                                                                                                                                                                                                                                                                                                                                             | Yes, inherited                                                                                                                                                                                                                                                                                                                       |
| `/proc/<pid>/environ`                     | Yes, for every process envd starts. **Inference** (Linux rules, not E2B docs): readable by the same uid and root; commands run as `user` by default (503 research), so one model command can read another's.                                                                                                                                                                                                                                                                                     | Yes, same                                                                                                                                                                                                                                                                                                                            |
| Files written by envd                     | No. envd writes only `.E2B_SANDBOX_ID` and `.E2B_TEMPLATE_ID` to `/run/e2b/` ([RT/envd/internal/host/mmds.go L172-L179](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/packages/envd/internal/host/mmds.go#L172-L179)); the docs list `.E2B_SANDBOX` too ([Environment variables](https://docs.e2b.dev/sandbox/environment-variables.md))                                                                                                                      | No                                                                                                                                                                                                                                                                                                                                   |
| envd `GET /envs`                          | Yes: returns `defaults.EnvVars.All()` as JSON ([RT/envd/internal/api/envs.go L10-L24](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/packages/envd/internal/api/envs.go#L10-L24)). Not on the auth-excluded list (only `GET/health`, `POST/init` are), so it needs the envd access token ([RT/envd/internal/api/auth.go L25-L31](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/packages/envd/internal/api/auth.go#L25-L31)) | No                                                                                                                                                                                                                                                                                                                                   |
| `commands.list()`                         | No                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Yes: envd returns each running process's `Config`, which holds the request `envs` ([RT/envd/internal/services/process/list.go L12-L28](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/packages/envd/internal/services/process/list.go#L12-L28); `ProcessInfo.envs`, `dist/index.d.ts` L5551-L5556) |
| Shell history, `set -x`, error messages   | Whatever the command prints. `bash -l` loads the profile, so a profile with `set -x` would trace expansions. **Inference.**                                                                                                                                                                                                                                                                                                                                                                      | Same                                                                                                                                                                                                                                                                                                                                 |

- Every sandbox has a secured envd: the SDK's `secure` option is "@deprecated Every sandbox secures envd access; this option is accepted for backward compatibility and ignored." (`dist/index.d.ts` L9274-L9276). The token is held by envd and our server; envd does not put it in a process's environment (handler.go L254-L275). So `GET /envs` and `commands.list()` are reachable from our server, not from a model command, unless a tool exposes them.
- The docs say it plainly, for per-command and per-code envs: "These environment variables are scoped to the command but are not private in the OS." ([Environment variables](https://docs.e2b.dev/sandbox/environment-variables.md))
- E2B's own Secrets page: "Rather than passing a key as an environment variable or baking it into a template, where any code running in the sandbox can read it, you store the value once and reference it in a network rule." ([Secrets overview](https://docs.e2b.dev/secrets.md))

**The core fact:** an env var hides a value from the model's _prompt_, not from the model's _commands_. On the Computer the model writes the shell commands, so `echo $DB_PASSWORD` or `cat /proc/self/environ` returns the value in stdout, and stdout goes to the model. Env vars alone do not serve "never to the model"; something has to stand between stdout and the model.

## 4. E2B's own answer: Secrets injected by the egress proxy

- E2B Cloud has a Secrets API: `Secret.create / update / getInfo / list / exists / destroy`, and `Secret.fill(name)`. All present in the installed 2.55.0. (`dist/index.d.ts` L9825-L9911)
- `Secret.fill(name)` returns the placeholder string `${e2b.secrets.<name>}`, used in a network rule's `transform.headers`. (`dist/index.mjs` L3077-L3082)
- "The egress proxy injects the real value into matching outbound HTTPS requests outside the sandbox. Your sandbox configuration contains only a reference to the secret." Values are write-only. ([Secrets overview](https://docs.e2b.dev/secrets.md))
- HTTPS only: "Plain HTTP requests do not receive injected headers." Unresolved references fail open: the request goes out, the header is dropped. ([Injecting secrets](https://docs.e2b.dev/secrets/inject.md))
- Limits: value ≤ 64 KiB; 10 secrets (Hobby) or 100 (paid) per project; 32 names per host. ([Limits](https://docs.e2b.dev/secrets/limits.md))
- A related feature: workload identity tokens (`${e2b.identity.tokens.<name>}`) minted per request by the egress proxy. (`dist/index.d.ts` L8768-L8790; [Workload identity](https://docs.e2b.dev/iam/workload-identity.md))

What it covers and what it does not:

- It serves API keys sent as HTTP headers. It does not serve a password a program reads from its environment, a login typed into a form in the Screen's browser, a database password in a connection string, or SSH. **Inference** from the docs: injection is only into HTTPS request headers.

### On self-hosted (Embed)

- Injecting a header into HTTPS means terminating TLS, which needs a CA the guest trusts; envd's `/init` takes a `CaBundle` from the orchestrator's egress proxy (envd.go L270). The open runtime's default egress factory is `tcpfirewall` ([RT/orchestrator/main.go L54-L68](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/packages/orchestrator/main.go#L54-L68)), which only inspects SNI for the domain allowlist ([RT/orchestrator/pkg/tcpfirewall/proxy.go L122-L123](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/packages/orchestrator/pkg/tcpfirewall/proxy.go#L122-L123)) and returns an empty `CABundle()` (L198-L200). The factory is documented as "edition-specific" ([RT/orchestrator/pkg/factories/run.go L279](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/packages/orchestrator/pkg/factories/run.go#L279)). Embed's ports table lists only "TCP firewall proxy" ports for egress ([embed/docs/REFERENCE.md L58-L61](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/embed/docs/REFERENCE.md#L58-L61)).
- **Inference:** Embed does not inject secrets into requests; header transforms and `Secret.fill` are a Cloud-edition feature. The API has a `secrets.go` handler ([RT/api/internal/handlers/secrets.go](https://github.com/e2b-dev/runtime/blob/568c7f0959936c4da58b910fcc03fac0c68a6320/packages/api/internal/handlers/secrets.go)), so storing may work while injection does not. Not tested on our Embed; a probe would create a sandbox with a transform to `httpbin.org/headers` and look.

## 5. Keeping a value out of output returned to the model

Prior art, GitHub Actions:

- "GitHub automatically redacts" secrets in logs, by value. "Because there are multiple ways a secret value can be transformed, automatic redaction is not guaranteed." Structured secrets (JSON, YAML) defeat it, "because redaction largely relies on finding an exact match". Derived values (a JWT signed with the secret, a base64 copy) must be registered too, with `::add-mask::VALUE`. Redaction "is performed by your workflow runners". ([Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions))
- The runner's masker adds encoded forms of each secret: three base64 alignments, command-line escape, expression escape, JSON escape, URI data escape, XML escape, trimmed double quotes, two PowerShell escapes. ([actions/runner src/Runner.Common/HostContext.cs L103-L113](https://github.com/actions/runner/blob/5fea684c16ea010a8d2b0d32dd60bae8a6372f46/src/Runner.Common/HostContext.cs#L103-L113); [src/Sdk/DTLogging/Logging/ValueEncoders.cs](https://github.com/actions/runner/blob/5fea684c16ea010a8d2b0d32dd60bae8a6372f46/src/Sdk/DTLogging/Logging/ValueEncoders.cs))

What that means for the Computer (**Inference**, from the code above and the repo's `run()`):

- Redaction by value has to run on our server, in `run()`, on stdout and stderr, before `boundedOutput()` hands text to the model. E2B has no masking: envd streams raw bytes in 32 KiB chunks (503 research), and nothing in the SDK or envd redacts.
- A value can be split across two `onStdout` chunks, so matching on each chunk alone misses it; match on the joined text, or keep a tail of `maxSecretLength - 1` bytes between chunks.
- `boundedOutput()` keeps the ends and drops the middle. If the cut falls inside a secret, the kept part is a fragment that exact matching no longer finds. Redact before trimming.
- The same output also reaches anything else that records it (the Run's tool-result parts, logs, evals). Redaction belongs before all of them, not only before the prompt.
- Redaction is best effort: `base64`, `rev`, `xxd`, `cut -c1-4` all defeat an exact match, and the model writes the commands. GitHub's own docs call redaction "not guaranteed". It catches accidents, not a model trying to read the value.
- Files are a second path: a command can write the value to a file, and the Files tools (read) return file contents. The same redaction would have to cover file reads, screenshots excluded (pixels cannot be matched by value).

## 6. The lecture's line

The lecture: "Keep secrets hidden: passwords go into environment variables, never to the model." Also, sign-in forms via password-manager autofill: "the password never reaches the model." ([#383 write-up](https://github.com/Daanish2003/ai-chat/issues/383), lines 225, 273, 521)

How E2B can serve it today:

- **Delivery:** yes. The server reads the secret from its own store and passes it as per-command `envs` on each `commands.run` (it never enters the prompt or tool arguments), or as per-sandbox `envs` at create. The model refers to it by name (`$GITHUB_TOKEN`), and only names enter the prompt.
- **Per-command is the closer fit.** Per-sandbox `envs` reach every command for the sandbox's life and sit in envd memory; per-command `envs` reach only the commands we choose, and need no persistence across pause (we resend them). Per-sandbox `envs` are also set once at create; the SDK has no call to change them later. **Inference**: no update method appears in the 2.55.0 types.
- **"Never to the model":** not on its own. The model can print any variable its commands can see.

What E2B lacks for that line:

1. **No output masking.** Nothing in envd or the SDK redacts values from command output; our server must.
2. **No per-variable privacy inside the VM.** Every process of the same user can read the value (`env`, `/proc/<pid>/environ`); the docs say envs "are not private in the OS".
3. **No secret injection on Embed** (Inference, §4). Cloud's Secrets keep a value outside the VM entirely, but only for HTTPS headers, and the open runtime's egress proxy does not terminate TLS.
4. **No reliable persistence of per-sandbox `envs` across a filesystem-only resume or a reboot** (Inference, §2).
5. **No hook for form autofill.** The 1Password-style path (fill a login in the Screen's browser without the model seeing it) is outside E2B; it would be our own tool that types the value through the browser driver.

## Open questions

- Does Embed reject a sandbox created with a `transform` rule, accept and ignore it, or inject? Needs a probe.
- After a filesystem-only resume on Embed, does `echo $X` still print a per-sandbox env? The code says no (§2); not run.
- Is the default template's `user` a passwordless sudoer (which would let a command read root-owned processes' environ too)? Not checked here.

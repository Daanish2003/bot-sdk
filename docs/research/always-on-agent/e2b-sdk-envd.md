# E2B SDK and envd: Shell, Files, pause and resume when self-hosted

Research for [#503](https://github.com/Daanish2003/ai-chat/issues/503), a child of map [#416](https://github.com/Daanish2003/ai-chat/issues/416) (Bot step 5, The Computer). Facts only, no pick.

Read on 2026-10-17. Sources:

- E2B docs at `docs.e2b.dev` (the `.md` form of each page). The JS SDK reference read is v2.56.0.
- `e2b` JS SDK source, `e2b-dev/E2B` at commit [`62a17dfc`](https://github.com/e2b-dev/E2B/tree/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk) (`packages/js-sdk/package.json` says `2.56.0`). Links below use `SDK/` for `packages/js-sdk/src/` at that commit.
- E2B runtime, `e2b-dev/runtime` at commit [`4f35ab01`](https://github.com/e2b-dev/runtime/tree/4f35ab01d346408b29b843eac98fdea61a21f8d1). `e2b-dev/infra` now redirects to this repo (the GitHub API returns `e2b-dev/runtime` for `repos/e2b-dev/infra`). It holds envd (`packages/envd`) and E2B Embed (`embed/`), the self-hosted package.

Earlier findings not repeated here: [#387](https://github.com/Daanish2003/ai-chat/issues/387) (hosted sandbox options) and [#407](https://github.com/Daanish2003/ai-chat/issues/407) (where KVM runs, self-hostable projects).

## 1. Commands (`sandbox.commands`)

### How a command runs

- `commands.run(cmd)` sends envd a process start of `/bin/bash` with args `['-l', '-c', cmd]`. So every command is a bash login shell. ([SDK/sandbox/commands/index.ts L431-L438](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/sandbox/commands/index.ts#L431-L438))
- The SDK speaks Connect RPC to envd. The `Commands` class is built from a `Transport` and an `EnvdApiClient`. ([sandbox-commands reference](https://docs.e2b.dev/sdk-reference/js-sdk/v2.56.0/sandbox-commands))
- envd listens on port `49983` in the VM. ([SDK/sandbox/index.ts L113](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/sandbox/index.ts#L113))

### `CommandStartOpts` ([sandbox-commands reference](https://docs.e2b.dev/sdk-reference/js-sdk/v2.56.0/sandbox-commands))

| Option                  | Default                     | Meaning                                                  |
| ----------------------- | --------------------------- | -------------------------------------------------------- |
| `cwd`                   | home directory of the user  | Working directory.                                       |
| `envs`                  | `{}`                        | Env vars. Override the defaults set on `Sandbox` create. |
| `user`                  | the template's default user | User to run as.                                          |
| `timeoutMs`             | `60_000`                    | Timeout for the command.                                 |
| `requestTimeoutMs`      | `60_000`                    | Timeout for the API request.                             |
| `signal`                | none                        | `AbortSignal` that aborts the request.                   |
| `onStdout` / `onStderr` | none                        | Callbacks, `(data: string) => void \| Promise<void>`.    |
| `background`            | false                       | Return a `CommandHandle` at once instead of waiting.     |
| `stdin`                 | `false`                     | Keep stdin open for `sendStdin` / `closeStdin`.          |

- The template's default user is `user`, with `/home/user` as workdir. The last user and workdir set in the template become the sandbox defaults. ([User and workdir](https://docs.e2b.dev/template/user-and-workdir))
- `timeoutMs: 0` disables the command timeout. When the 60 s default expires, envd kills the process, even with `background: true`. ([Background commands](https://docs.e2b.dev/commands/background))

### Results and errors

- `run()` without `background` returns `CommandResult`: `exitCode`, `error?`, `stdout`, `stderr`. ([SDK/commandHandle.ts L20-L38](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/sandbox/commands/commandHandle.ts#L20-L38))
- A non-zero exit throws `CommandExitError`. It extends `SandboxError` and carries the same four fields. `wait()` throws it. ([commandHandle.ts L43-L77, L166-L182](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/sandbox/commands/commandHandle.ts#L43-L182))
- A stream that ends with no `end` event makes `wait()` throw `SandboxError('Process exited without a result')`. ([commandHandle.ts L173-L175](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/sandbox/commands/commandHandle.ts#L173-L175))
- `TimeoutError` covers three cases: `[unavailable]` (sandbox timeout), `[canceled]` (request timeout), `[deadline_exceeded]` (command or watch timeout). ([errors reference](https://docs.e2b.dev/sdk-reference/js-sdk/v2.56.0/errors))
- `SandboxNotRunningError` (a `TimeoutError`): the sandbox was killed, paused or timed out; retrying will not help. `SandboxUnreachableError` (a `TimeoutError`): the sandbox could not be reached and is not confirmed stopped, e.g. envd not up yet or the network is down. ([errors reference](https://docs.e2b.dev/sdk-reference/js-sdk/v2.56.0/errors))

### Streaming

- Pass `onStdout` / `onStderr`. ([Streaming](https://docs.e2b.dev/commands/streaming))
- Every stream asks envd for a keepalive ping every 50 s (header `Keepalive-Ping-Interval`). A stream normally stays open over an hour, but no single connection is guaranteed past one hour; the client must reconnect. ([Streaming](https://docs.e2b.dev/commands/streaming); [SDK/connectionConfig.ts L12-L14](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/connectionConfig.ts#L12-L14); [Sandbox lifetime FAQ](https://docs.e2b.dev/faq/sandbox-lifetime))
- When a stream drops, the SDK checks the sandbox. If it is gone, the error says so; any other connection error means only the connection was lost. ([Sandbox lifetime FAQ](https://docs.e2b.dev/faq/sandbox-lifetime))

### Background processes and reconnecting

- `background: true` returns a `CommandHandle` with `pid`, `wait()`, `kill()` (SIGKILL), `disconnect()`, `sendStdin()`, `closeStdin()`. `disconnect()` stops the events; it does not kill the process. ([commandHandle.ts L86-L247](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/sandbox/commands/commandHandle.ts#L86-L247))
- `commands.connect(pid, { onStdout, onStderr, timeoutMs })` reattaches to a running command, from any process. `commands.list()` returns `ProcessInfo` (`pid`, `cmd`, `args`, `envs`, `cwd?`, `tag?`) for running commands and PTYs. `commands.kill(pid)` returns `false` when not found. ([sandbox-commands reference](https://docs.e2b.dev/sdk-reference/js-sdk/v2.56.0/sandbox-commands))
- Streamed output goes only to the process that started the command. The docs say to redirect output to a file for a reconnecting process. A command that writes a lot can stall if its connection breaks without closing. ([Background commands](https://docs.e2b.dev/commands/background))
- PTYs: `sandbox.pty.create / connect / sendInput / resize / kill`. ([sandbox-commands reference](https://docs.e2b.dev/sdk-reference/js-sdk/v2.56.0/sandbox-commands))

### Output size

- The SDK keeps all stdout and stderr in memory strings, with no cap in `CommandHandle`. ([commandHandle.ts L91-L92, L282-L298](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/sandbox/commands/commandHandle.ts#L91-L298))
- envd reads stdout and stderr in chunks of 32 KiB (PTY 16 KiB), with an output channel buffer of 64 events. ([runtime packages/envd/internal/services/process/handler/handler.go L29-L38](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/packages/envd/internal/services/process/handler/handler.go#L29-L38))
- Not verified: any total output cap in envd. None was found in `handler.go`; the rest of envd was not read.

## 2. Files (`sandbox.files`)

Methods ([sandbox-filesystem reference](https://docs.e2b.dev/sdk-reference/js-sdk/v2.56.0/sandbox-filesystem)):

| Method                                                             | Returns                                                                | Notes                                                                                                                                |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `read(path, { format })`                                           | `string` (default), `Uint8Array` (`'bytes'`), `Blob`, `ReadableStream` | `gzip`, `streamIdleTimeoutMs` options.                                                                                               |
| `write(path, data)` / `write(entries[])` / `writeFiles(entries[])` | `WriteInfo` / `WriteInfo[]`                                            | `data`: `string`, `ArrayBuffer`, `Blob`, `ReadableStream`. Creates missing parent dirs. Overwrites.                                  |
| `list(path, { depth })`                                            | `EntryInfo[]`                                                          |                                                                                                                                      |
| `exists(path)`                                                     | `boolean`                                                              |                                                                                                                                      |
| `getInfo(path)`                                                    | `EntryInfo`                                                            | name, type, path, size, mode, permissions, owner, group, modifiedTime, symlinkTarget, metadata.                                      |
| `makeDir(path)`                                                    | `boolean`                                                              | `false` if it already exists. Creates parents.                                                                                       |
| `rename(old, new)`                                                 | `EntryInfo`                                                            |                                                                                                                                      |
| `remove(path)`                                                     | `void`                                                                 | File or directory.                                                                                                                   |
| `watchDir(path, onEvent, opts)`                                    | `WatchHandle`                                                          | `recursive`, `includeEntry` (envd ≥ 0.6.3), `allowNetworkMounts` (envd ≥ 0.6.4), `timeoutMs` (default 60 s, `0` disables), `onExit`. |

- Every call takes `user`, which sets relative-path resolution and the owner of created files. ([sandbox-filesystem reference](https://docs.e2b.dev/sdk-reference/js-sdk/v2.56.0/sandbox-filesystem))
- Binary: `read` with `format: 'bytes' | 'blob' | 'stream'`; `write` takes `ArrayBuffer`, `Blob` or `ReadableStream`. With `useOctetStream` (envd ≥ 0.5.7), a `ReadableStream` upload streams instead of buffering. ([sandbox-filesystem reference](https://docs.e2b.dev/sdk-reference/js-sdk/v2.56.0/sandbox-filesystem))
- No edit or patch primitive exists. The full method list is above; an edit is a read plus a write, or a command. ([sandbox-filesystem reference](https://docs.e2b.dev/sdk-reference/js-sdk/v2.56.0/sandbox-filesystem))
- Watch events are async and may arrive late. Fast nested folder creation may emit only `CREATE`. A watch is a stream and must be restarted after a drop. ([Watch](https://docs.e2b.dev/filesystem/watch); [Sandbox lifetime FAQ](https://docs.e2b.dev/faq/sandbox-lifetime))
- Pre-signed `uploadUrl` / `downloadUrl` exist for sandboxes created with `secure: true`. ([Upload](https://docs.e2b.dev/filesystem/upload); [Download](https://docs.e2b.dev/filesystem/download))
- Size limits: Cloud disk is 10 GiB (Hobby) or 20 GiB (Pro) per sandbox. `NotEnoughSpaceError` is thrown when the disk is full. ([Filesystem overview](https://docs.e2b.dev/filesystem); [errors reference](https://docs.e2b.dev/sdk-reference/js-sdk/v2.56.0/errors))
- Not verified: a per-file size limit for `read` / `write`. None is documented.

## 3. Lifecycle

### create, timeout, kill

- Default sandbox timeout is 5 minutes. `timeoutMs` on `create` changes it. ([Sandbox lifetime FAQ](https://docs.e2b.dev/faq/sandbox-lifetime))
- `setTimeout(ms)` resets the clock to `ms` from now. It can extend or shorten. Running commands, file reads and writes, and URL requests do not reset the timeout. ([Sandbox lifecycle](https://docs.e2b.dev/sandbox); [Auto-resume](https://docs.e2b.dev/sandbox/auto-resume))
- On Cloud, continuous runtime is capped at 1 hour (Hobby) or 24 hours (Pro). Pause and resume resets it. ([Persistence](https://docs.e2b.dev/sandbox/persistence))
- `kill()` is final from any state. A killed sandbox cannot be resumed. ([Persistence](https://docs.e2b.dev/sandbox/persistence))

### pause / betaPause

- `pause({ mode })` posts to `/sandboxes/{id}/pause`. It returns `true` when paused, `false` when already paused (409), and throws `SandboxNotFoundError` on 404. ([SDK/sandbox/sandboxApi.ts L1596-L1631](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/sandbox/sandboxApi.ts#L1596-L1631))
- `betaPause` is deprecated and just calls `pause`. ([sandboxApi.ts L1633-L1641](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/sandbox/sandboxApi.ts#L1633-L1641); [SDK/sandbox/index.ts L663-L668](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/sandbox/index.ts#L663-L668))
- A pause the node refuses throws `ServiceBusyError` (503). The sandbox keeps running, intact; retry later. It is not a `SandboxError`. SDK ≥ 2.48.0. Until rolled out in a region, this case returns 500. ([Persistence](https://docs.e2b.dev/sandbox/persistence); [errors reference](https://docs.e2b.dev/sdk-reference/js-sdk/v2.56.0/errors))

### What a pause snapshots

- Default `mode: 'full'`: filesystem and memory, so running processes and loaded variables survive. ([Persistence](https://docs.e2b.dev/sandbox/persistence))
- `mode: 'filesystem'` (SDK ≥ 2.55.0; old form `keepMemory: false`): disk only. Resume reboots from disk; processes and RAM are gone. On Cloud it can be refused with 400 `snapshot_filesystem_only_disabled` when not enabled for the project. ([Filesystem-only snapshots](https://docs.e2b.dev/sandbox/filesystem-only-snapshots))
- Network: clients outside the sandbox are disconnected on pause and must reconnect after resume. ([Persistence](https://docs.e2b.dev/sandbox/persistence))
- In the runtime, "Pause diffs memory and disk against the template and ships the diff to object storage." ([runtime README L46](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/README.md#L46))

### How long a snapshot lives, and latency

- A paused sandbox is kept indefinitely. No TTL, no auto-delete, no "auto-kill after N days" option. Remove it with `kill`. ([Persistence](https://docs.e2b.dev/sandbox/persistence); [Sandbox lifetime FAQ](https://docs.e2b.dev/faq/sandbox-lifetime))
- A paused sandbox is not billed and does not count toward concurrency (Cloud). ([Sandbox lifetime FAQ](https://docs.e2b.dev/faq/sandbox-lifetime))
- Pause takes about 4 s per 1 GiB of RAM. Resume takes about 1 s. ([Persistence](https://docs.e2b.dev/sandbox/persistence))
- A filesystem-only resume takes "several seconds". ([Filesystem-only snapshots](https://docs.e2b.dev/sandbox/filesystem-only-snapshots))

### connect resumes a paused sandbox

- Yes. "Connect to a sandbox. If the sandbox is paused, it will be automatically resumed. Sandbox must be either running or be paused." ([SDK/sandbox/index.ts L448-L476](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/sandbox/index.ts#L448-L476); [Persistence](https://docs.e2b.dev/sandbox/persistence))
- `Sandbox.connect(id, { timeoutMs })` only extends the lifetime: new expiry = later of current expiry and now + `timeoutMs` (default 5 min). ([Persistence](https://docs.e2b.dev/sandbox/persistence))
- `onResume: 'reboot'` on `connect` ignores the memory and boots from disk; unflushed writes are lost. Default is `'restore'`. ([Reboot on resume](https://docs.e2b.dev/sandbox/resume-without-memory))

### autoPause and autoResume

- Set on create: `lifecycle: { onTimeout: 'pause' | 'kill' | { action: 'pause', mode: 'filesystem' }, autoResume: boolean }`. Default `onTimeout` is `'kill'`, default `autoResume` is `false`. ([Auto-resume](https://docs.e2b.dev/sandbox/auto-resume))
- Auto-pause repeats on every later timeout. ([Persistence](https://docs.e2b.dev/sandbox/persistence))
- With `autoResume: true`, an SDK call (`commands.run`, `files.read`, `files.write`) or an HTTP request to a sandbox URL wakes it. The resumed timeout is the original timeout, with a 5-minute minimum. `autoResume` cannot be combined with filesystem-only pause. ([Auto-resume](https://docs.e2b.dev/sandbox/auto-resume))
- If the node keeps refusing an auto-pause for about two minutes past the timeout, Cloud falls back to a filesystem-only pause. The `sandbox.lifecycle.paused` event then has `pause_mode: filesystem`. ([Persistence](https://docs.e2b.dev/sandbox/persistence))

### Snapshots (not pause)

- `createSnapshot()` briefly pauses the sandbox, then it keeps running. It drops all active connections (WebSocket, PTY, command streams). One snapshot can start many sandboxes. Needs envd ≥ v0.5.0. ([Snapshots](https://docs.e2b.dev/sandbox/snapshots))

## 4. Templates

- Build from code: `Template()....` then `Template.build(template, 'name', { cpuCount, memoryMB, minFreeDiskMb, ... })`, or `buildInBackground` plus `getBuildStatus`. ([Build](https://docs.e2b.dev/template/build))
- Dockerfile to template: `Template().fromDockerfile(content)`. Supported: `FROM`, `RUN`, `COPY`/`ADD`, `WORKDIR`, `USER`, `ENV`, `CMD`/`ENTRYPOINT` (become the start command with a 20 s ready wait). Skipped: `EXPOSE`, `VOLUME`. Multi-stage Dockerfiles are not supported. `fromImage()` takes a pushed image instead. ([Base image](https://docs.e2b.dev/template/base-image))
- The V1 build system (`e2b template build`, `e2b.toml`) stopped working on 2026-08-01. Use `e2b template create` or the SDK. ([V1 build deprecation](https://docs.e2b.dev/migration/v1-build-deprecation))
- How a build works: container from the definition, filesystem extracted, layers run, sandbox started, optional start command and ready check, then the running sandbox is snapshotted. That snapshot is the template. ([How it works](https://docs.e2b.dev/template/how-it-works))
- Changing a template means a new build. Tags (`name:tag`, default tag `default`) point at builds. `Sandbox.create('name:<build_id>')` pins a build. `assignTags` moves a tag without rebuilding. Removing a tag does not delete the build artifact. ([Tags](https://docs.e2b.dev/template/tags))
- The kernel is fixed at template build time; a newer kernel needs a rebuild. ([How it works](https://docs.e2b.dev/template/how-it-works))
- Cloud build limits: up to 1 hour per build; Hobby 8 vCPU, 8 GiB RAM, 10 GiB disk; 20 concurrent builds. ([Template quickstart](https://docs.e2b.dev/template/quickstart))

### Paused sandbox and a template change

- The envd version a sandbox runs is pinned by its template. A long-lived paused sandbox stays on that version for its whole life. A filesystem-only pause and resume can bring it up on a newer envd. ([Filesystem-only snapshots](https://docs.e2b.dev/sandbox/filesystem-only-snapshots))
- The pause snapshot is a diff against the template. ([runtime README L46](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/README.md#L46))
- Not verified: what happens to a paused sandbox when its template tag moves to a new build. No doc states it. From the two facts above it would keep resuming from its own old build, but this is an inference, not a cited fact.
- The runtime README says envd "can be live-upgraded inside a running sandbox without dropping the workload". ([runtime README L49](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/README.md#L49)) Not verified: when that happens, or if Embed does it.

## 5. Self-hosted (E2B Embed)

### What self-hosted is

- Self-hosting means E2B Embed: the open-source runtime on one Linux machine with KVM. BYOC is a different thing: an Enterprise managed deployment in your cloud account. ([BYOC](https://docs.e2b.dev/byoc))
- Embed claims "the whole E2B stack, every feature included, on a single machine … Same SDK, same API as E2B Cloud", and "The same sandboxes as E2B Cloud. Isolated, paused and resumed on demand." ([embed/README.md](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/README.md))
- Runs with Docker Compose, Terraform (GCP, AWS, Azure) or Kubernetes. One node by design. ([embed/README.md](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/README.md))

### envd commands and files work on self-hosted

- Embed runs a real Firecracker orchestrator and fetches a pinned envd (`E2B_ENVD_VERSION=v0.9.202609130627-59497eb9134`). ([embed/compose/README.md](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/README.md); [embed/compose/.env L19](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/.env#L19))
- The Compose guide's own test does `sbx.commands.run("echo hello from the sandbox")`, and the packaged smoke test does the same with the JS SDK. ([embed/compose/README.md, Try it](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/README.md#try-it))
- The dashboard has "a terminal and a file browser for every sandbox". ([embed/README.md](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/README.md))
- The guide reports that on 2026-09-14 an arm64 bare-metal host "passed the smoke test, sandbox create, pause and resume, template builds". ([embed/compose/README.md L19-L22](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/README.md#L19-L22))
- Template builds work: `Template.build` runs "through the same API", in a sandbox on the machine, pulling from Docker Hub, no Docker daemon. ([embed/docs/REFERENCE.md, Beyond the first sandbox](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/docs/REFERENCE.md#beyond-the-first-sandbox))

### Pointing the SDK at it

- Embed prints four exports: `E2B_API_KEY=<team key>`, `E2B_API_URL=http://<host>:3000`, `E2B_SANDBOX_URL=http://<host>:3002`, `E2B_DASHBOARD_URL=http://<host>:3001`. ([embed/compose/compose.yaml L609](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/compose.yaml#L609))
- The SDK reads `E2B_API_KEY`, `E2B_DOMAIN` (default `e2b.app`), `E2B_API_URL` (default `https://api.${domain}`) and `E2B_SANDBOX_URL`. The `apiUrl` and `sandboxUrl` options are marked `@internal`; the env vars are the documented route. ([SDK/connectionConfig.ts L43-L80, L523-L541](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/connectionConfig.ts#L43-L80))
- With `sandboxUrl` set, all envd traffic goes to that one URL. The SDK sends `E2b-Sandbox-Id` and `E2b-Sandbox-Port` headers on envd requests, which client-proxy routes on. ([connectionConfig.ts L547-L567](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/connectionConfig.ts#L547-L567); [SDK/sandbox/index.ts L145-L163](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/sandbox/index.ts#L145-L163))
- The team API key is made by the seed on first start. Rotating it keeps the old key valid for up to 5 minutes. ([embed/docs/REFERENCE.md, Secrets](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/docs/REFERENCE.md#secrets))

### What differs when self-hosted

- Plain HTTP, no TLS of its own; meant to sit inside your network. ([embed/README.md, Limitations](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/README.md#limitations))
- `sandbox.getHost(port)` returns `{port}-{id}.e2b.app`, which does not resolve on Embed. Reach a port with headers `E2b-Sandbox-Id` and `E2b-Sandbox-Port` on `http://<host>:3002`. ([embed/docs/REFERENCE.md, Reaching a port](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/docs/REFERENCE.md#reaching-a-port-inside-a-sandbox))
- Port 5008 (orchestrator gRPC) is unauthenticated and must not be reachable. Only 3000, 3001, 3002 are for clients. ([embed/docs/REFERENCE.md, Ports](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/docs/REFERENCE.md#ports-on-the-host-network))
- Pause storage is the machine's disk. A pause the disk cannot hold is refused up front, keeping 1 GiB free (`PAUSE_ADMISSION_DISK_HEADROOM_MIB`). The estimate counts the sandbox's whole memory. ([embed/compose/README.md L54-L58](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/README.md#L54-L58))
- A refused pause answers 503 and leaves the sandbox running (`PAUSE_REFUSAL_RESTORE=true`). ([embed/compose/README.md, Known limitations](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/README.md#known-limitations); [embed/docs/REFERENCE.md, Logs](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/docs/REFERENCE.md#logs))
- Feature flags have "no LaunchDarkly" on Embed, so they are set as env vars in `compose.yaml`. ([embed/compose/compose.yaml L300-L375](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/compose.yaml#L300-L375))
- Capacity: 12 GiB RAM and 20 GiB free disk recommended. `HUGEPAGES=2048` reserves 4 GiB for sandboxes: about 8 `base` sandboxes at full memory or about 20 idle. At most 200 running sandboxes per node; `NBDS_MAX` (64) caps concurrent sandboxes; at most three starting at once. ([embed/compose/README.md L54-L73, L164-L186](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/README.md#L54-L186))
- Running sandboxes end when the orchestrator restarts; `docker compose down` ends them too. ([embed/compose/README.md L381-L382, L143](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/README.md#L140-L150))
- Logs are kept 7 days in ClickHouse. Metrics (`getMetrics`, dashboard charts) stay empty until a collector runs. ([embed/docs/REFERENCE.md, Observability](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/docs/REFERENCE.md#observability))
- arm64 hosts need kernel ≥ 6.10 for restore (userfaultfd write-protect). ([embed/compose/README.md L22-L26](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/README.md#L22-L26))
- `onResume: 'reboot'`: a self-hosted control plane that knows the option but has it off fails with an error. One older than the option ignores it and restores memory while returning success. ([Reboot on resume, Self-hosted](https://docs.e2b.dev/sandbox/resume-without-memory))

### Cloud-only or plan-bound

- BYOC is Enterprise-only and E2B-operated. ([BYOC](https://docs.e2b.dev/byoc))
- The 1 h / 24 h runtime caps, 10 / 20 GiB disk sizes and build limits are stated per Cloud plan. ([Persistence](https://docs.e2b.dev/sandbox/persistence); [Filesystem overview](https://docs.e2b.dev/filesystem); [Template quickstart](https://docs.e2b.dev/template/quickstart))
- The `sandbox.<domain>` stable host is used only for `e2b.app`, `e2b.dev`, `e2b.pro`, `e2b-staging.dev`. ([connectionConfig.ts L7-L8, L559-L564](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/connectionConfig.ts#L7-L8))

## Not verified

- Pause and resume latency on Embed. The 4 s/GiB and ~1 s figures are Cloud docs.
- Whether Embed applies the 1 h / 24 h continuous runtime cap, or which tier its seeded team has.
- Whether filesystem-only pause (`mode: 'filesystem'`) is enabled on Embed. On Cloud it is gated per project.
- Whether Embed has the auto-pause fallback to filesystem-only after two minutes of refusals.
- A total output cap in envd for command output.
- A per-file size limit for `files.read` / `files.write`.
- What happens to a paused sandbox when its template is rebuilt or its tag moves (see section 4).
- When envd live-upgrades inside a running sandbox, and if Embed does it.
- The Embed guides test with Python `e2b==2.46.0`; JS SDK 2.56.0 against Embed was not checked here beyond the smoke test that the guide says uses the JS SDK.

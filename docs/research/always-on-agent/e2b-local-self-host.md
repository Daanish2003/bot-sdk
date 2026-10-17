# Running self-hosted E2B on one local machine

Research for [#504](https://github.com/Daanish2003/ai-chat/issues/504), under map [#416](https://github.com/Daanish2003/ai-chat/issues/416). It feeds the task ticket [#505](https://github.com/Daanish2003/ai-chat/issues/505). It builds on the [#407 findings](https://github.com/Daanish2003/ai-chat/blob/research/self-hosted-sandbox/docs/research/always-on-agent/self-hosted-sandbox.md) and does not repeat them.

Facts only. Read on 2026-10-17. The E2B repo was renamed from `e2b-dev/infra` to `e2b-dev/runtime`; the old name redirects. Repo links are pinned to commit [`4f35ab0`](https://github.com/e2b-dev/runtime/tree/4f35ab01d346408b29b843eac98fdea61a21f8d1) (2026-10-17).

Short names used below:

- **Compose README**: [`embed/compose/README.md`](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/README.md)
- **Reference**: [`embed/docs/REFERENCE.md`](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/docs/REFERENCE.md)
- **Embed README**: [`embed/README.md`](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/README.md)
- **DEV-LOCAL**: [`DEV-LOCAL.md`](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/DEV-LOCAL.md)
- **preflight.sh**: [`embed/compose/scripts/preflight.sh`](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/scripts/preflight.sh)
- **wsl-config**: Microsoft, [Advanced settings configuration in WSL](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) (page dated 2026-10-16)

## 1. Install paths for one node

E2B Embed is the single-machine package. It runs "the whole E2B stack" on one machine, "one machine, by design" ([Embed README](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/README.md)).

| Path                           | You need                | Runs locally?                     | Source       |
| ------------------------------ | ----------------------- | --------------------------------- | ------------ |
| Docker Compose                 | a Linux host you own    | Yes, the only local path          | Embed README |
| Terraform on GCP / AWS / Azure | a cloud account         | No, creates one cloud VM          | Embed README |
| Kubernetes                     | one node in a cluster   | Only if you already run a cluster | Embed README |
| From source (`DEV-LOCAL.md`)   | Linux, Go, Node, gsutil | Yes, for developing E2B itself    | DEV-LOCAL    |

- The Compose install is two files and one command: download `compose.yaml` and `.env`, then `docker compose up -d --wait` (Compose README, Install).
- The first `up` checks the host, prepares it, downloads Firecracker artifacts (about 60 MB), pulls pinned images, migrates and seeds the databases and builds the `base` template. It exits 0 only when `base` is ready. That takes about 2 minutes on an 8-vCPU / 32 GiB VM; smaller hosts take longer (Compose README, Install).
- From-source dev is "a work in progress. Not everything will function as expected" (DEV-LOCAL). It needs `sudo` for the orchestrator and three terminals (DEV-LOCAL, Run the application locally).
- No account and no licence key are needed (Embed README, What you get). All images and binaries are public (Compose README, Requirements).
- E2B's own announcement describes the same Compose steps ([Introducing E2B Embed](https://e2b.dev/resources/introducing-e2b-embed)).

## 2. Host requirements (Compose path)

From the Compose README, Requirements, unless noted.

| Need               | Value                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| OS / arch          | Linux x86-64 or arm64, 4 KiB page kernel. "x86-64 is what the guides were written and tested on."             |
| Recommended distro | Ubuntu 24.04                                                                                                  |
| Kernel             | 6.8 or newer (6.10 on arm64)                                                                                  |
| glibc              | 2.34 or newer                                                                                                 |
| cgroup             | v2                                                                                                            |
| Host tools         | `iptables`, `rsync`, `e2fsprogs`, `iproute2`; `python3-venv` for the Python try-it                            |
| Devices            | `/dev/kvm` and `/dev/net/tun`                                                                                 |
| Kernel modules     | `nbd`, `tun`, `kvm` are loaded by `host-setup`                                                                |
| Docker             | Engine 27+ with Compose 2.24+, user in the `docker` group                                                     |
| RAM                | 12 GiB recommended. `HUGEPAGES=2048` reserves 4 GiB for sandboxes. `preflight` does not check RAM.            |
| Disk               | 20 GiB free on `/` (`PF_MIN_FREE_GIB`, checked by preflight.sh)                                               |
| Network out        | HTTPS to Docker Hub, `us-docker.pkg.dev`, `storage.googleapis.com`, `github.com`, `raw.githubusercontent.com` |

Details that matter for sizing and setup:

- `preflight` checks arch, page size, kernel floor, `/dev/kvm`, `/dev/net/tun`, cgroup v2, glibc, that `modprobe -n nbd` works, the host tools, and free disk on `/` ([preflight.sh](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/scripts/preflight.sh)).
- Hugepages bound concurrency. The default carries "eight sandboxes at full memory or about twenty idle ones". Past that each create fails with `500: Failed to place sandbox` (Compose README, Requirements).
- `NBDS_MAX` (default 64) caps concurrent sandboxes; each running sandbox holds one NBD device. The node refuses the 201st running sandbox (Compose README, Everyday commands).
- Privileged containers: several services run with `privileged: true`, `pid: host`, `network_mode: host`, and the orchestrator also `cgroup: host` ([`compose.yaml`](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/compose.yaml)). The orchestrator is a host process started through `nsenter` by a privileged container (Reference, What runs where). The launcher runs `nsenter -t 1 -m -u -i -n -C` ([`orchestrator-launch.sh`](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/scripts/orchestrator-launch.sh)).
- Host changes on every `up`: loads modules, writes files under `/etc/modules-load.d`, `/etc/modprobe.d`, `/etc/udev/rules.d`, `/etc/sysctl.d`, adds an iptables mangle TCP MSS clamp, reserves hugepages, creates `/var/lib/e2b`, `/fc-*`, `/orchestrator`, `/var/run/netns`. That is "why it should be a dedicated host or VM" (Compose README, What runs where).
- After a reboot, run `docker compose up -d --wait` once to restore the MSS clamp and `/var/run/netns` (Compose README, What runs where).

### Networking, DNS and TLS

- Plain HTTP, "no TLS of its own" (Embed README, Limitations).
- 13 ports bind every host interface. The SDK needs 3000 (api) and 3002 (client-proxy). A browser needs 3001 (dashboard). The other ten must be unreachable (Reference, Ports on the host network).
- Port 5008 is an "unauthenticated gRPC control API" that creates and kills sandboxes (Reference, Ports on the host network).
- Postgres 5432, Redis 6379 and ClickHouse 8123/9000 stay on `127.0.0.1` (Reference, Ports on loopback).
- No DNS is needed. `sandbox.get_host(port)` returns `{port}-{id}.e2b.app`, which "does not resolve here". Reach a sandbox port with headers instead: `curl -H "E2b-Sandbox-Id: $SANDBOX_ID" -H "E2b-Sandbox-Port: 8080" http://localhost:3002/` (Reference, Reaching a port inside a sandbox).
- "One stack per host; there are no VM-name or port knobs" (Compose README, Everyday commands).
- Template builds with `copy()` steps upload through port 5008. From another machine, tunnel 5008 too (Compose README, Ports).

## 3. WSL2

### What the E2B docs say

- DEV-LOCAL on `main` still says: "WSL2: KVM is not supported. Use a Linux VM with nested virtualization instead" (DEV-LOCAL, Troubleshooting).
- Open PR [e2b-dev/runtime#3660](https://github.com/e2b-dev/runtime/pull/3660) (2026-09-24) corrects this: "`/dev/kvm` does work on Windows 11; the real blocker is the 6.6 kernel." Its diff says `/dev/kvm` "appears once `kvm_intel` or `kvm_amd` is loaded, but the WSL2 kernel (6.6) is older than the 6.8 minimum, so snapshot restores fail". On 6.6 "every snapshot resume fails with `Failed to UFFD object`". It is not merged.
- The Compose README and Embed README do not mention WSL at all. Supported hosts listed are bare metal, GCE, EC2 and Apple silicon VMs (Compose README, Requirements).
- A search of `e2b-dev/runtime` issues and PRs for "wsl" found only #3660 relevant. No issue reports a working or failing Embed install on WSL2.

### What Microsoft and the WSL kernel say

- `nestedVirtualization` defaults to `true`, "enabling other nested VMs to run inside WSL 2". Windows 11 only (wsl-config, Main WSL settings).
- The kernel 6.6 blocker no longer holds for current WSL. WSL [3.0.3](https://github.com/microsoft/WSL/releases/tag/3.0.3) (stable, 2026-10-09) updates the kernel to 6.18.54.1. The move to 6.18 first shipped in pre-release [2.7.5](https://github.com/microsoft/WSL/releases/tag/2.7.5) (2026-05-15). Earlier lines used 6.6 (2.3.11, 2.5.1, 2.7.0 release notes).
- WSL 2.5.1 (2025-03-12) "switch[ed] modules to a vhd", so loadable modules ship with the kernel ([2.5.1 notes](https://github.com/microsoft/WSL/releases/tag/2.5.1)).
- The WSL kernel config for 6.18.54.1 has what Embed needs: `CONFIG_KVM=m`, `CONFIG_KVM_INTEL=m`, `CONFIG_KVM_AMD=m`, `CONFIG_BLK_DEV_NBD=m`, `CONFIG_TUN=m`, `CONFIG_USERFAULTFD=y`, `CONFIG_HAVE_ARCH_USERFAULTFD_WP=y`, `CONFIG_PTE_MARKER_UFFD_WP=y`, `CONFIG_HUGETLBFS=y`, `CONFIG_NETFILTER_XT_TARGET_TCPMSS=y`, `CONFIG_IP_NF_MANGLE=m`, `CONFIG_MEMCG=y` ([`config-wsl` at `linux-msft-wsl-6.18.54.1`](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.18.54.1/arch/x86/configs/config-wsl)).
- `.wslconfig` `loadKernelModules` takes "a comma-separated list of additional kernel modules to load when the WSL 2 VM starts". Defaults loaded are `tun`, `ip_tables`, `br_netfilter` (wsl-config, Main WSL settings).
- cgroup hierarchy defaults to `v2` (wsl.conf `[automount] cgroups`). systemd is off by default; turn it on with `[boot] systemd=true` (wsl-config).
- WSL VM memory defaults to 50% of Windows RAM; swap to 25%. Set `memory=` in `.wslconfig` to change it (wsl-config, Main WSL settings).
- The distro VHD defaults to a 1 TB maximum (`defaultVhdSize`) (wsl-config).
- `localhostForwarding` defaults to `true`: ports bound in WSL are reachable from Windows at `localhost:port` (wsl-config).

### Known WSL2 problem right now (October 2026)

- [microsoft/WSL#41917](https://github.com/microsoft/WSL/issues/41917): after the October 2026 cumulative update KB5127648 (build 26100/26200.9711), `nestedVirtualization` is silently off. `/dev/kvm` is missing and `dmesg` shows `Hyper-V: Nested features: 0x0`. Reports are all on AMD CPUs; one commenter says an Intel Core Ultra 7 155H was not affected. Several users fixed it by uninstalling KB5127648. Two reporters are on Windows 11 Home (26200.9711).
- A WSL maintainer wrote on 2026-10-15: "We have identified the issue with the Windows Update and are working with the servicing team to get a fix out". The issue was closed 2026-10-16 with no comment. Not verified whether a fix has shipped.
- The same thread shows nested KVM worked on Windows 11 Home with only VirtualMachinePlatform and HypervisorPlatform enabled (full Hyper-V not installed) before that update. This is user reports, not Microsoft docs.

### What remains Not verified for WSL2

- Not verified: anyone running Embed Compose end to end on WSL2. No E2B doc or issue reports it.
- Not verified: whether Docker Desktop's WSL backend works. The orchestrator and `host-setup` `nsenter` into PID 1 of the Docker host and need `iptables`, `rsync`, `e2fsprogs`, `iproute2` there (orchestrator-launch.sh, preflight.sh). With Docker Desktop that host is Docker's own VM, not the Ubuntu distro. Docker Engine installed inside the Ubuntu distro avoids this question; that is inference, not a documented step.
- Not verified: whether `kvm_intel`/`kvm_amd` autoload in WSL. PR #3660 says `/dev/kvm` appears "once" the module is loaded, and `host-setup` only runs `modprobe kvm`.
- Not verified: whether WSL's memory reclaim (`autoMemoryReclaim`, default `dropCache`) or the VM idle shutdown (`vmIdleTimeout` 60 s, `instanceIdleTimeout` 15 s) interferes with reserved hugepages or a running stack.
- Not verified: whether 2048 hugepages can be reserved inside the WSL VM.
- Not verified: the owner's CPU vendor, RAM, and whether KB5127648 is installed. The sandbox here refused the PowerShell query.

## 4. Building and registering a custom template

- Templates are built "through the same API, whichever way you run the stack" with `Template.build`. Example from the Reference, Beyond the first sandbox:

  ```python
  from e2b import Template, Sandbox
  tpl = Template().from_python_image("3.12").run_cmd("pip install requests")
  Template.build(tpl, alias="py-requests", cpu_count=2, memory_mb=1024, on_build_logs=lambda e: print(str(e)))
  sbx = Sandbox.create("py-requests")
  ```

- The build runs in its own sandbox on the machine and pulls the image from Docker Hub; "no Docker daemon is involved" (Reference, Beyond the first sandbox).
- The `alias` is the name you pass to `Sandbox.create` (same example).
- `copy()` steps upload through port 5008 (Compose README, Ports).
- If a build fails at the network level (`Hash Sum mismatch`, `Remote end closed connection`), the MSS clamp is missing; rerun `up` (Compose README, Troubleshooting).
- The `base` template is built by the `base-template` one-shot on first `up`. `FORCE_REBUILD=1` rebuilds it (Compose README, Everyday commands).
- The stack is tested with the 2.46 SDK line: `e2b@2.46.1` (JS) and `e2b==2.46.0` (Python) (Compose README, Developing).
- Not verified: the E2B desktop template (VNC) on self-host; carried over from #407.

## 5. How the SDK authenticates

- The seed generates one team API key per install on the first `up` and keeps it in the `seed-state` volume at `/run/e2b/team-api-key` (Compose README, Secrets).
- `docker compose exec ready cat /run/e2b/sdk.env` prints four exports. `docker compose logs ready` prints them too (Compose README, Try it). The `ready` service writes exactly ([`compose.yaml`](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/compose.yaml), service `ready`):

  ```
  export E2B_API_KEY=<key>
  export E2B_API_URL=http://localhost:3000
  export E2B_SANDBOX_URL=http://localhost:3002
  export E2B_DASHBOARD_URL=http://localhost:3001
  ```

- The JS SDK reads `E2B_API_KEY`, `E2B_API_URL` and `E2B_SANDBOX_URL` from the environment, or `apiKey`, `apiUrl`, `sandboxUrl` options. Without them it defaults to `https://api.${domain}` with `E2B_DOMAIN` or `e2b.app` ([`connectionConfig.ts`](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/connectionConfig.ts)). So `E2B_DOMAIN` is not needed for Embed; the two URLs are.
- Key format, to pin your own: `TEAM_API_KEY` = `e2b_` plus at least 32 hex characters, set in `.env` (Compose README, Secrets).
- Rotation is only through the seed. The old key keeps working up to five minutes (Compose README, Known limitations).
- `down -v` drops the key with the databases; the next `up` makes a new key (Compose README, Secrets).
- The api also has `ADMIN_TOKEN` and `SANDBOX_ACCESS_TOKEN_HASH_SEED`, generated into `/run/e2b/api.env`. The admin token can mint and revoke API keys without the team key (Reference, Secrets).
- From-source dev uses a fixed seeded key `e2b_53ae1fed82754c17ad8077fbc8bcdd90` with the same two URLs (DEV-LOCAL, Client configuration).

## 6. One cloud VM later

- Terraform modules exist for GCP, AWS and Azure; each takes `client_cidrs` for who may connect (Embed README).
- On a VM, `/dev/kvm` means nested virtualization was on at creation. GCE: `--enable-nested-virtualization`. EC2: `--cpu-options NestedVirtualization=enabled` on an Intel type that offers it, such as `m8i` (Compose README, Requirements).
- From another machine, tunnel 3000, 3001, 3002 and 5008 over SSH rather than open them, and use `127.0.0.1` in the URLs (Compose README, Ports).

## 7. Things on this repo's side

- This repo's local Postgres runs on 5435 because 5432 belongs to another project (owner memory, not an E2B fact). Embed's Postgres binds `127.0.0.1:5432` inside its host (Reference, Ports on loopback). Not verified whether that collides with the other project's 5432 through WSL `localhostForwarding`.

## Not verified (all in one place)

- Any end-to-end Embed run on WSL2.
- Docker Desktop (WSL backend) as the Docker host for Embed.
- `kvm_intel`/`kvm_amd` autoload in WSL; 2048 hugepages inside WSL; effect of WSL idle shutdown and memory reclaim.
- Whether the KB5127648 nested-virt regression is fixed, and whether the owner's machine (CPU vendor, RAM, update level) is affected.
- Port 5432 collision between Embed in WSL and the owner's other Postgres.
- E2B desktop/VNC template on self-host; self-hosted resume latency (from #407).

## Draft checklist for #505

Each step names its source. Steps marked _(inference)_ follow from the facts above but no source documents them for WSL.

1. **Check Windows.** Windows 11 is required for `nestedVirtualization` (wsl-config). Run `winver`. If the build is `.9711` and the CPU is AMD, expect `/dev/kvm` to be missing ([WSL#41917](https://github.com/microsoft/WSL/issues/41917)).
2. **Update WSL** to 3.0.3 or later so the kernel is 6.18.54.1: `wsl --update`, then `wsl --version` ([WSL 3.0.3](https://github.com/microsoft/WSL/releases/tag/3.0.3)). Embed needs kernel 6.8+ (Compose README, Requirements).
3. **Write `%UserProfile%\.wslconfig`** (keys from wsl-config):
   ```ini
   [wsl2]
   nestedVirtualization=true
   memory=14GB
   loadKernelModules=kvm_intel,nbd
   ```
   Use `kvm_amd` on AMD. `memory` covers the 12 GiB recommendation (Compose README). The module list is _(inference)_ from PR [#3660](https://github.com/e2b-dev/runtime/pull/3660).
4. **Install Ubuntu 24.04** in WSL, the recommended host (Compose README): `wsl --install -d Ubuntu-24.04`.
5. **Turn on systemd**: add `[boot]` `systemd=true` to `/etc/wsl.conf`, then `wsl --shutdown` (wsl-config).
6. **Check the host inside Ubuntu**: `uname -r` shows 6.8+; `ls -l /dev/kvm /dev/net/tun`; `grep -Ec 'vmx|svm' /proc/cpuinfo` is non-zero; `getconf PAGESIZE` is 4096; `ldd --version` shows 2.34+; `test -f /sys/fs/cgroup/cgroup.controllers`; `sudo modprobe -n nbd`; `df -BG /` shows 20+ GiB free. These mirror [preflight.sh](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/scripts/preflight.sh). If `/dev/kvm` is missing, try `sudo modprobe kvm_intel` (or `kvm_amd`) (PR #3660); on AMD with KB5127648, see WSL#41917.
7. **Install host tools**: `sudo apt-get update && sudo apt-get install -y iptables rsync e2fsprogs iproute2 python3-venv` (Compose README, Requirements).
8. **Install Docker Engine inside Ubuntu**, not Docker Desktop _(inference, see Not verified)_: `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`, then log in again. Check Engine 27+ and Compose 2.24+ with `docker version` and `docker compose version` (Compose README, Requirements).
9. **Free port 5432 inside the WSL host** or confirm nothing there uses it (Reference, Ports on loopback; collision Not verified).
10. **Install Embed**, pinned to a commit (Compose README, Install and Upgrading):
    ```bash
    mkdir ~/e2b && cd ~/e2b
    curl -fsSL --remote-name-all "https://raw.githubusercontent.com/e2b-dev/runtime/<commit>/embed/compose/{compose.yaml,.env}"
    docker compose up -d --wait
    ```
11. **If `up` fails**, read the `FIX:` line in `docker compose logs preflight` (or `host-setup`, `fetch-artifacts`, `base-template`), fix it, and rerun `up`; every step is idempotent (Compose README, If `up` fails). If `host-setup` says hugepages could not be reserved, lower `HUGEPAGES` in `.env` or raise WSL `memory` (Compose README, Requirements).
12. **Smoke test**: `docker compose --profile test run --rm smoke` (Compose README, Try it).
13. **Get SDK values**: `eval "$(docker compose exec ready cat /run/e2b/sdk.env)"` gives `E2B_API_KEY`, `E2B_API_URL=http://localhost:3000`, `E2B_SANDBOX_URL=http://localhost:3002` (Compose README, Try it; `compose.yaml` service `ready`). Put those in the app's environment; the JS SDK reads them ([`connectionConfig.ts`](https://github.com/e2b-dev/E2B/blob/62a17dfc3f11439d1d06bfb9bb515eadc5adfcd3/packages/js-sdk/src/connectionConfig.ts)). From Windows, `localhost` reaches WSL ports by default (`localhostForwarding`, wsl-config).
14. **Pin the SDK** to the tested line, `e2b@2.46.1` (Compose README, Developing).
15. **Build a custom template** with `Template.build(tpl, alias=...)`, then `Sandbox.create(alias)` (Reference, Beyond the first sandbox).
16. **Reach a sandbox port** with `E2b-Sandbox-Id` and `E2b-Sandbox-Port` headers on `http://localhost:3002/`, not `get_host()` (Reference, Reaching a port inside a sandbox).
17. **Keep ports private**: only 3000, 3001, 3002 for trusted clients; never expose 5008 (Reference, Ports on the host network).
18. **After each Windows or WSL restart**, run `docker compose up -d --wait` once (Compose README, What runs where).
19. **To remove**: `docker compose down -v && docker compose --profile purge run --rm host-teardown` (Compose README, Remove).
20. **Fallback if WSL2 fails**: a cloud VM with nested virtualization (GCE `--enable-nested-virtualization`, EC2 `m8i` with `NestedVirtualization=enabled`) running the same Compose install, or the Terraform module (Compose README, Requirements; Embed README).

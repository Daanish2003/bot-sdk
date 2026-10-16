# Research: Sandbox for the agent's computer

Ticket: [#387 Sandbox for the agent's computer](https://github.com/Daanish2003/ai-chat/issues/387) (child of map [#383](https://github.com/Daanish2003/ai-chat/issues/383)).
Researched: 2026-10-16, from vendor docs and pricing pages. Facts only; no pick.

## Question

What can provide the agent's computer as the lecture (slides 13 and 15) describes it: a Firecracker VM per user, a Debian container under a supervisor with a file server, a command runner and several virtual screens each with its own Chrome, memory plus disk snapshotted when idle and restored in place on the next tool call, a live desktop view, and files, tools and browser logins that persist? Compare self-hosted Firecracker against E2B, Fly Machines, Vercel Sandbox, Daytona, Modal and Morph (Fly Sprites added, found while reading the Fly docs).

## Answer in one paragraph

Restoring **memory plus disk** on wake is documented by E2B (pause/resume, ~1 s resume), Fly Machines (suspend, "a few hundred ms"), Fly Sprites (warm sleep, 100–500 ms, but drops to disk-only "cold" after a longer idle), Daytona (pause, VM sandboxes only), Morph (snapshot/pause, "<250ms" marketing figure) and Modal (memory snapshots, alpha, Python-only, 7-day expiry). Vercel Sandbox persists the **filesystem only**. No vendor documents multiple virtual displays; E2B and Daytona ship a single-display desktop with VNC/noVNC streaming, the rest are do-it-yourself. Self-hosted Firecracker needs `/dev/kvm`, which Render does not provide (privileged containers are not allowed) and Hetzner Cloud does not offer; it needs bare metal or a cloud that allows nested virtualization (e.g. GCP).

## Comparison

| Option                  | Memory + disk restore                                          | Wake latency (documented)             | Idle cost                                                   | Desktop / displays                                              | Persistence                                               | TS SDK                           | Compute price                                          |
| ----------------------- | -------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------- | ------------------------------------------------------ |
| Self-hosted Firecracker | Yes: snapshot = memory file + VM state; disks backed up by you | Not stated                            | Your host, always on                                        | DIY                                                             | DIY                                                       | None (REST API on a socket)      | Host cost                                              |
| E2B                     | Yes (default pause mode)                                       | Resume ~1 s; pause ~4 s per GiB RAM   | No compute while paused; snapshot storage charge not stated | Desktop template: one Xvfb display, noVNC stream                | Paused sandboxes kept indefinitely                        | `e2b`, `@e2b/desktop`            | $0.000014/vCPU-s, $0.0000045/GiB-s; Pro $150/mo        |
| Fly Machines            | Yes (suspend, ≤ 2 GB RAM)                                      | "a few hundred ms"                    | $0.15/GB-month rootfs; volumes $0.15/GB-month               | DIY                                                             | rootfs kept across suspend; volumes                       | None official (REST/OpenAPI, Go) | shared-cpu-1x 1 GB $6.70/mo running                    |
| Fly Sprites             | Warm: yes. Cold: disk only                                     | Warm 100–500 ms; cold 1–2 s           | Compute stops; storage $0.02/GB-month cold, $0.50 hot       | DIY                                                             | Disk always; checkpoints are filesystem-only              | `@fly/sprites`                   | $0.0385/CPU-h (used), $0.021875/GB-h (used)            |
| Vercel Sandbox          | No: filesystem only                                            | Not stated ("milliseconds" for start) | Snapshot storage $0.08/GB-month                             | DIY                                                             | Auto-snapshot on stop; 30-day default expiry, can be none | `@vercel/sandbox`                | Active CPU $0.128/h, memory $0.0212/GB-h               |
| Daytona                 | Pause (VM sandboxes): yes. Stop: disk only                     | Not stated                            | Paused/stopped: reserved disk only; archived: nothing       | Computer Use: Xvfb + xfce4 + x11vnc + noVNC; API lists displays | Disk on stop; auto-stop 15 min default                    | `@daytona/sdk`                   | $0.0504/vCPU-h, $0.0162/GiB-h, $0.000108/GiB-h disk    |
| Modal                   | Memory snapshots: alpha, Python only, 7-day expiry             | Not stated                            | Snapshot storage not stated                                 | DIY                                                             | Filesystem/directory snapshots (30 days default)          | `modal` (JS)                     | $0.00003942/core-s, $0.00000667/GiB-s                  |
| Morph Cloud             | Yes: snapshots hold memory + disk + processes                  | "<250ms" (marketing page)             | Paused: storage only                                        | "Built-in browser-based access" (no detail)                     | Snapshots; TTL optional                                   | `morphcloud`                     | MCU at $0.05; 1 MCU = 1 vCPU-h + 4 GB-h + 16 GB disk-h |

## Self-hosted Firecracker

- Needs read/write access to `/dev/kvm`; supports x86_64 and aarch64 Linux. The getting-started guide uses EC2 `.metal` instances "because EC2 only supports KVM on `.metal` instance types" ([getting started](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md)).
- A snapshot is a guest memory file plus a microVM state file; "the block device backing files should be backed up externally by the user". Diff snapshots are "still in developer preview". Snapshots must resume on identical software and hardware; network connectivity is not guaranteed after resume; restores are slow under cgroups v1 ([snapshot support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)).
- **Render:** the Docker docs do not mention privileged mode, devices or `/dev/kvm` ([Render Docker](https://render.com/docs/docker)). A Render staff reply on the community forum says Render does not allow services to run Docker in privileged mode ([thread](https://community.render.com/t/run-docker-container-in-privileged-mode/1814); date not read, forum host did not resolve). Not verified against a current policy page.
- **Hetzner Cloud:** "Can I run virtual machines on cloud servers, or rather is nested virtualization possible?" "No, this is not possible on cloud server." ([Hetzner Cloud FAQ](https://docs.hetzner.com/cloud/servers/faq/)). Hetzner dedicated (bare-metal) servers exist; prices were not readable from the page.
- **GCP:** nested virtualization is supported with Linux KVM as the L1 hypervisor, except on E2, memory-optimized, Arm and AMD VMs (N4D excepted); expect "a 10% or greater decrease in performance" ([GCP nested virtualization](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview)).
- E2B's runtime is open source and is "Firecracker microVMs that resume from a snapshot"; it self-hosts on one KVM Linux host via Docker Compose, or via Terraform on GCP, AWS and Azure ([e2b-dev/infra](https://github.com/e2b-dev/infra)).

## E2B

- Pause saves "both the sandbox's filesystem and memory state", including "all the running processes, loaded variables, data". A `filesystem` mode reboots on resume. Pause takes "approximately 4 seconds per 1 GiB of RAM"; resume "approximately 1 second". "A paused sandbox is kept indefinitely." `onTimeout: "pause"` auto-pauses, and re-pauses after each resume. Continuous runtime: 24 h Pro, 1 h Hobby; pause/resume resets it ([persistence](https://docs.e2b.dev/sandbox/persistence)).
- Billing: "You only pay while a sandbox is actively running"; paused retention "Unlimited". Whether paused snapshots carry a storage charge is not stated ([billing](https://docs.e2b.dev/billing)).
- Pricing: $0.000014/vCPU-s, $0.0000045/GiB-s, storage free; Hobby $0 with $100 one-time credit, 20 concurrent; Pro $150/month, 100 concurrent; 1–8 vCPU, 1–8 GiB RAM ([pricing](https://e2b.dev/pricing)).
- Desktop: `@e2b/desktop` with `sandbox.stream.start()` / `getUrl()` VNC streaming and a configurable resolution ([desktop SDK](https://docs.e2b.dev/docs/desktop)). The desktop template runs one Xvfb display (`:0`, 1024x768) with x11vnc and noVNC on port 6080; Chrome is not listed among preinstalled apps ([desktop template](https://docs.e2b.dev/template/desktop)). Multiple displays: not documented.

## Fly Machines

- Suspend "uses Firecracker snapshots to capture the entire VM state: CPU registers, memory contents, open file handles" and "does not reset the machine's `rootfs`". Resume "a few hundred ms" vs cold start "~2+ seconds". Requirements: ≤ 2 GB memory, no swap, no schedule. Suspended machines are billed like stopped ones: storage only, "no CPU/RAM charges". Auto-suspend via `auto_stop_machines = "suspend"` in `fly.toml`; the proxy wakes on request ([suspend/resume](https://docs.fly.io/reference/suspend-resume)).
- Pricing: shared-cpu-1x 1 GB $6.70/month running; stopped/suspended $0.15/GB-month of rootfs; volumes $0.15/GB-month; volume snapshots $0.08/GB-month, first 10 GB free ([pricing](https://docs.fly.io/about/pricing)).
- SDK: no official TS SDK for the Machines API; fly-go or an OpenAPI-generated client ([Machines API](https://docs.fly.io/machines/api/)). Desktop/VNC: not provided.

## Fly Sprites

- "persistent, hardware-isolated Linux environments", each in a "dedicated microVM"; disk on NVMe while running, backed up to object storage when idle ([Sprites](https://docs.fly.io/sprites)).
- After "about 30 seconds" idle the Sprite goes warm: "The VM is suspended with everything in memory frozen in place"; wake 100–500 ms. After a longer idle it goes cold: "in-memory state is dropped"; wake 1–2 s. Disk is kept in both. Compute billing stops while asleep. Max 8 vCPU, 100 GB storage ([lifecycle](https://docs.fly.io/sprites/concepts/lifecycle.md)).
- Checkpoints snapshot "the writable filesystem overlay" only; no memory or processes ([checkpoints](https://docs.fly.io/sprites/concepts/checkpoints.md)).
- Pricing: $0.0385/CPU-hour (cumulative usage), $0.021875/GB-hour (actual memory), hot storage ≈ $0.50/GB-month, cold ≈ $0.02/GB-month. SDK `@fly/sprites` ([sprites](https://fly.io/sprites)). Desktop/VNC: not documented.

## Vercel Sandbox

- "Each sandbox runs in a secure Firecracker microVM"; SDK `@vercel/sandbox` ([overview](https://vercel.com/docs/sandbox)).
- Persistent sandboxes (the default) "automatically save their filesystem state when stopped"; any SDK call auto-resumes; a new session "boots from that snapshot" ([persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes)). Snapshots capture "the filesystem and installed packages", expire 30 days after last use by default (can be none) ([snapshots](https://vercel.com/docs/sandbox/concepts/snapshots)). Memory and running processes are not restored.
- Pricing (Pro, `iad1`): Active CPU $0.128/h, provisioned memory $0.0212/GB-h, snapshot storage $0.08/GB-month, drives $0.05/GB-month; max session 24 h (Pro), 45 min (Hobby); up to 8 vCPU / 16 GB on Pro ([pricing](https://vercel.com/docs/sandbox/pricing)). Desktop/VNC: not documented.

## Daytona

- Stop: "The filesystem is preserved, but memory state is not." Pause (VM sandboxes only): "The filesystem and memory state are preserved, and CPU is no longer consumed"; "Pause is not supported for container sandboxes". Auto-stop defaults to 15 minutes; VM auto-pause defaults to 60 minutes. Archive (containers) moves the filesystem to object storage ([sandboxes](https://www.daytona.io/docs/en/sandboxes.md)).
- Billing: stopped and paused bill reserved disk only ("preserved memory state is not billed"); archived bills nothing ([billing](https://www.daytona.io/docs/en/billing.md)). Rates: $0.0504/vCPU-h, $0.0162/GiB-h, $0.000108/GiB-h storage, per-second billing, $200 free compute ([pricing](https://www.daytona.io/pricing)).
- Computer Use starts Xvfb, xfce4, x11vnc and noVNC; default 1024x768; mouse, keyboard, screenshots, recording, AT-SPI accessibility tree; `display.getInfo()` returns a list of displays, but configuring several is not documented ([computer use](https://www.daytona.io/docs/en/computer-use.md)). SDK `@daytona/sdk`. Wake latency: not stated.

## Modal

- Filesystem and directory snapshots (30-day default TTL). Memory snapshots are alpha ("experimental"), "expire 7 days after creation and cannot currently be extended", restore only on the same instance type, close open TCP connections, and are shown in Python only ([snapshots](https://modal.com/docs/guide/sandbox-snapshots)).
- Default lifetime 5 minutes, max 24 h; `idle_timeout` available; JS SDK package `modal` ([sandboxes](https://modal.com/docs/guide/sandboxes)).
- Sandbox rates: $0.00003942/core-s (physical core = 2 vCPU), $0.00000667/GiB-s; Starter $0 + $30/month credit, Team $250/month ([pricing](https://modal.com/pricing)). Desktop/VNC: not documented.

## Morph Cloud

- Snapshots are "immutable point-in-time copies of both memory and disk state", capturing "all running processes and services" ([snapshots](https://cloud.morph.so/docs/documentation/instances/creating-snapshot)). Pause preserves memory state; "You'll only be charged for storage, not compute resources" ([pause & resume](https://cloud.morph.so/docs/documentation/instances/pause-resume)).
- "snapshot, branch, and restore entire computational environments in under 250ms"; "Built-in browser-based access" for remote desktop (no detail); SDK `morphcloud` ([developers](https://cloud.morph.so/developers)).
- Pricing: 1 MCU = 1 vCPU-h + 4 GB RAM-h + 16 GB disk-h, standard rate $0.05; Team $40/month, Scale $250/month ([pricing](https://cloud.morph.so/web/pricing)).

## Not verified

- Wake latency for Vercel, Daytona and Modal; Morph's figure is from a marketing page.
- E2B and Modal storage charges for paused/snapshotted state.
- Any vendor supporting several virtual displays, each with its own Chrome, in one sandbox. Every option would need that built inside the image (e.g. several Xvfb displays).
- Render's current policy on `/dev/kvm` (forum reply only); Hetzner dedicated prices.

# Research: Render persistent disks and zero-downtime deploys

Ticket: [#167 Render persistent disks and zero-downtime deploys](https://github.com/Daanish2003/ai-chat/issues/167) (child of map [#166](https://github.com/Daanish2003/ai-chat/issues/166)).
Researched: 2026-10-12, from Render, Railway and Fly official docs only.

## Question

What does attaching a persistent disk do to a Render web service? Does it turn off zero-downtime deploys, limit the service to one instance, how long does a deploy go down for, and does it affect the shutdown delay and `SIGTERM` drain that [ADR 0009](../adr/0009-production-on-render.md) relies on? Do Railway and Fly volumes have the same limits? ADR 0009 assumes two processes overlap for up to 300 s during a deploy; [ADR 0012](../adr/0012-synced-sources-on-a-disk.md) needs a disk for Synced sources.

## Answer

A disk on Render turns the deploy from "start new, then drain old" into "stop old, then start new". There is no overlap, the service is limited to one instance, and the service is unavailable while the swap happens. Railway and Fly volumes have the same shape: no overlap, no replicas (Railway) or one volume per Machine (Fly), and downtime on every deploy of a single instance.

## Render

- **Zero-downtime deploys are off.** "All service types redeploy with zero downtime, unless they attach a persistent disk." "Adding a persistent disk to your service disables zero-downtime deploys for it." ([deploys](https://render.com/docs/deploys)) "Adding a disk to a service prevents zero-downtime deploys." ([disks](https://render.com/docs/disks))
- **Stop before start.** On redeploy, "Render stops the existing instance before bringing up the new instance." This is a safeguard against two app versions writing to the same disk. ([disks](https://render.com/docs/disks))
- **One instance.** "A persistent disk is accessible by only a single service instance, and only at runtime." "You can't scale a service to multiple instances if it has a disk attached." ([disks](https://render.com/docs/disks)); "Services with an attached persistent disk cannot scale to multiple instances." ([scaling](https://render.com/docs/scaling))
- **How long it goes down.** For deploys: "This instance swap takes a few seconds, during which your service is unavailable." ([disks](https://render.com/docs/disks)). For platform maintenance (OS upgrades), disk services are fully stopped before the replacement starts, "typically" a few minutes of downtime ([platform maintenance](https://render.com/docs/platform-maintenance)).
- **Shutdown delay and `SIGTERM`.** The documented sequence (new instance healthy, traffic moved, 60 s wait, `SIGTERM` to the old instance, `SIGKILL` after the shutdown delay, default 30 s, max 300 s via `maxShutdownDelaySeconds`) is described under _Zero-downtime deploys_ ([deploys](https://render.com/docs/deploys), [article](https://render.com/articles/how-render-handles-zero-downtime-deploys)). **Neither page says whether the shutdown delay applies to a disk service's stop-first swap, nor how its old instance is stopped.** Not verified. If the delay is honoured, the drain happens while no new instance is serving, so the outage would be at least the drain time plus boot, not "a few seconds"; this is an inference, to be confirmed with Render support or a test deploy.
- **Disk is runtime-only.** "You can't access persistent disks during a service's build command or pre-deploy command." "You can't access a service's disk from a one-off job you run for the service." ([disks](https://render.com/docs/disks), [deploys](https://render.com/docs/deploys))
- **Other facts.** Paid web services, private services and background workers can have a disk; cron jobs cannot. Size can grow (no downtime) but never shrink. Snapshots every 24 h, kept at least 7 days; restoring discards later changes. ([disks](https://render.com/docs/disks))

## Railway

- "Replicas cannot be used with volumes." ([volumes](https://docs.railway.com/reference/volumes))
- "we prevent multiple deployments from being active and mounted to the same service", so "there will be a small amount of downtime when re-deploying a service that has a volume attached". ([volumes](https://docs.railway.com/reference/volumes))
- One volume per service; live resize up to 1 TB on Pro; no downsizing; manual and automated backups. ([volumes](https://docs.railway.com/reference/volumes))
- Normal deploys overlap (`RAILWAY_DEPLOYMENT_OVERLAP_SECONDS`) and drain (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, default 0) after `SIGTERM` ([deployments](https://docs.railway.com/reference/deployments)). The docs do not say how draining interacts with a volume service. Not verified.

## Fly.io

- A volume "can attach to one Machine", a Machine "can only mount one volume at a time", and "a volume exists on one server in a single region"; no replication between volumes. ([volumes overview](https://docs.fly.io/volumes/overview))
- Scaling out means one volume per Machine, each with its own data; Fly advises "Always provision at least two volumes per app" and replicating in the app. ([volumes overview](https://docs.fly.io/volumes/overview))
- A single Machine with a volume has downtime "whenever you deploy your app". ([volumes overview](https://docs.fly.io/volumes/overview))
- `canary` and `bluegreen` "cannot be used for Machines with attached volumes"; `rolling` (default) and `immediate` remain. `kill_timeout` defaults to 5 s, max 300 s; `kill_signal` defaults to `SIGINT`. ([fly.toml reference](https://docs.fly.io/reference/configuration/))
- Volumes are not mounted on the temporary Machine that runs the release command. ([volumes overview](https://docs.fly.io/volumes/overview))

## What this means for ADRs 0009 and 0012

Facts and implications only; the decisions belong to the map.

- **ADR 0009's 300 s overlap does not exist on a disk service.** Its "two processes for up to 300 s" premise holds only without a disk. With the disk ADR 0012 needs on the same web service, each deploy is a gap with no process serving, and in-flight Runs either drain during that gap (if the shutdown delay applies, unverified) or are cut and left to the reaper.
- **ADR 0009's single-instance assumption already matches**, but the disk makes it a hard ceiling: the web service can never scale out while it holds the disk.
- **ADR 0009's reason for Redis from day one changes**: with no overlap, a reader can't reconnect to a second live process during deploy; that stated reason ("two processes for up to 300 s") no longer applies to the disk-bearing service. Other reasons may still hold.
- **ADR 0012's sync can't run in Render's pre-deploy or a one-off job**, since neither sees the disk; cloning has to happen in the running service.
- **Moving hosts doesn't avoid this**: Railway and Fly volumes impose the same no-overlap, single-instance shape.
- **The shape that keeps zero-downtime web deploys** is putting the disk on a separate service (a Render private service or background worker can hold a disk) that runs the sync and the allowlisted commands, while the web service stays disk-free. This is an option, not a recommendation.

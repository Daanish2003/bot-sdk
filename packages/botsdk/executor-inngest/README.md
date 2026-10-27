# @botsdk/executor-inngest

Runs the Bot SDK's background jobs (Turns, Routines, Check-ins, sleep checks and the Host's own jobs) on [Inngest](https://www.inngest.com) instead of the in-process poller (ADR 0029, spec #878). Use it on a serverless platform, or when you want Inngest's retries and dashboard.

Jobs still live in the `botsdk.job` table, and the core still claims, leases and replays them, so a Turn stays exactly-once however often Inngest delivers its event. Inngest only wakes jobs up:

- When a job is queued (after its transaction commits), the Executor sends one `<app id>/botsdk.job.due` event (the client's app id, so two apps in one Inngest environment never wake each other's jobs; `botsdkRunner.events` names both events) with `{ jobId, runAfter }`; a job due now gets the send time as its `runAfter`. The event id is the job id and that time, so the same wake-up sent twice is one event, while a later one (a re-notify, a retry) is a new event.
- The `botsdk-run-job` function has the core run the job at once when it is due by the serving process's clock; otherwise it sleeps until a second past `runAfter` (which also covers that clock being a little behind the notifier's). A job that already ran, or that another delivery holds, is left alone.
- The `botsdk-sweep-jobs` function runs every 5 minutes (`sweepCron` changes that). It re-queues jobs whose lease expired (their process crashed) and sends an event for every due job, so a lost event never strands a job. It also deletes finished jobs past their retention (at most once an hour per SDK instance), as the in-process runner's reaper does. One sweep runs at a time. Sending its `<app id>/botsdk.jobs.sweep` event runs it at once. A long-lived process also re-queues expired leases every 30 s, as with the in-process runner; the sweep is what does it on a serverless platform.

`inngest` is a dependency of this package only; `@botsdk/bot` is a peer.

## Setup

Pass the Executor in the `runner` slot, and serve its functions with your app's Inngest `serve()` handler:

```ts
import { Inngest } from "inngest";
import { createBotSdk } from "@botsdk/bot";
import { inngestExecutor } from "@botsdk/executor-inngest";

export const inngest = new Inngest({ id: "my-app" });
export const botsdkRunner = inngestExecutor({ client: inngest });

export const chat = createBotSdk({
  // …
  runner: botsdkRunner,
});
```

```ts
// app/api/inngest/route.ts (Next.js; Inngest has a serve() for each framework)
import { serve } from "inngest/next";
import { chat, botsdkRunner, inngest } from "@/bot-sdk";

await chat.start();

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [...botsdkRunner.functions /* , your own functions */],
});
```

The process that serves the functions must have called `chat.start()`: a delivery to one that hasn't started (or has stopped) fails, and Inngest retries it. `chat.stop()` stops taking deliveries: Inngest retries each one (its default retries, with backoff), usually on another process, and a job whose retries all landed on stopped processes waits for the next sweep.

A job runs inside one Inngest request, so your platform's request time limit must cover your longest job (a Bot Turn can take minutes). A job cut off mid-way resumes from its last Checkpoint once the sweep finds its lease expired.

A job with a `concurrency` (or a group of jobs with one `budget`) runs at most that many at once on Inngest, across every process that serves the functions (the in-process runner counts per process). For each such budget, `botsdkRunner.functions` has a function `botsdk-run-job-<budget>` with Inngest's `concurrency` limit set to it; the Executor looks up a job's budget when it sends its event (`budget` in the event data), and that function alone takes the event. Jobs with no `concurrency` run at once, as before, so size your database pool for them. The budgets come from the jobs the SDK started with, so read `functions` after `chat.start()`, as in the setup above, and re-sync the app after a deploy that adds or changes a `concurrency`.

Queue jobs in the SDK's own transactions (`ctx.db` in a job or a feature). A job queued in a transaction of your own Drizzle instance is written but not sent to Inngest; the next sweep sends it, up to 5 minutes later.

The `botsdk-run-job` function compares `runAfter` with the clock of the process Inngest delivers it to. If that clock and the notifier's differ by more than about 1 s, a job that is due now can wait for a sweep: usually within one `sweepCron` interval (5 minutes by default), and at most about two. If the clocks differ by more than an interval, it waits longer. Keep the clocks synchronised (NTP; serverless platforms already do), or pass a shorter `sweepCron`.

## Local development

Run the Inngest dev server and point your app at it:

```sh
docker run --rm -p 8288:8288 inngest/inngest:v1.46.0 inngest dev -u http://host.docker.internal:3000/api/inngest
```

`host.docker.internal` works on Docker Desktop. On Docker Engine (Linux), add `--add-host=host.docker.internal:host-gateway` to `docker run`, or run the container with `--network host` and use `http://127.0.0.1:3000/api/inngest`.

Set `INNGEST_DEV=1` in your app's environment, so the client sends events to the dev server and skips signing. The dev server's UI at http://localhost:8288 shows each event and function run; "Invoke" on `botsdk-sweep-jobs` sweeps at once.

## Inngest Cloud

1. Set `INNGEST_EVENT_KEY` (to send events) and `INNGEST_SIGNING_KEY` (to verify Inngest's calls) in your app's environment, from your Inngest environment's settings. Leave `INNGEST_DEV` unset.
2. Deploy, then sync the app: add your `serve()` URL (for example `https://my-app.com/api/inngest`) in the Inngest dashboard, or use its Vercel or Netlify integration, which syncs on each deploy.
3. Re-sync after a deploy that changes the functions, so Inngest has the current ones.

The sweep's cron runs in the cloud as soon as the app is synced.

## Tests

The package's suite runs the core's Executor conformance suite against a real dev server, plus Inngest's own cases (a duplicate event, a due-time wait, the sweep). Start a dev server and set `TEST_INNGEST_URL`:

```sh
docker run -d --name inngest-test -p 8288:8288 inngest/inngest:v1.46.0 inngest dev --no-discovery
TEST_INNGEST_URL=http://127.0.0.1:8288 pnpm exec vitest run packages/botsdk/executor-inngest
```

The dev server calls the suite's endpoint at `host.docker.internal` (on Docker Engine, start it with `--add-host=host.docker.internal:host-gateway`); set `TEST_INNGEST_CALLBACK_HOST` when it reaches this machine some other way (CI runs it on the host network, with `127.0.0.1`). Without `TEST_INNGEST_URL` the suite is skipped, except in CI, where it fails.

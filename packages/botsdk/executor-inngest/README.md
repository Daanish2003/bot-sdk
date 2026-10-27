# @botsdk/executor-inngest

Runs the Bot SDK's background jobs (Turns, Routines, Check-ins, sleep checks and the Host's own jobs) on [Inngest](https://www.inngest.com) instead of the in-process poller (ADR 0029, spec #878). Use it on a serverless platform, or when you want Inngest's retries and dashboard.

Jobs still live in the `botsdk.job` table, and the core still claims, leases and replays them, so a Turn stays exactly-once however often Inngest delivers its event. Inngest only wakes jobs up:

- When a job is queued (after its transaction commits), the Executor sends one `botsdk/job.due` event with `{ jobId, runAfter }`. The event id is the job id (with `runAfter` for a retry), so sending the same wake-up twice is a no-op.
- The `botsdk-run-job` function sleeps until `runAfter`, then has the core run the job. A job that already ran, or that another delivery holds, is left alone.
- The `botsdk-sweep-jobs` function runs every 5 minutes. It re-queues jobs whose lease expired (their process crashed) and sends an event for every due job, so a lost event never strands a job. Sending a `botsdk/jobs.sweep` event runs it at once.

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

The process that serves the functions must have called `chat.start()`: a delivery to one that hasn't started (or has stopped) fails, and Inngest retries it. `chat.stop()` stops taking deliveries; Inngest delivers to another process.

A job runs inside one Inngest request, so your platform's request time limit must cover your longest job (a Bot Turn can take minutes). A job cut off mid-way resumes from its last Checkpoint once the sweep finds its lease expired.

Queue jobs in the SDK's own transactions (`ctx.db` in a job or a feature). A job queued in a transaction of your own Drizzle instance is written but not sent to Inngest; the next sweep sends it, up to 5 minutes later.

## Local development

Run the Inngest dev server and point your app at it:

```sh
docker run --rm -p 8288:8288 inngest/inngest:v1.46.0 inngest dev -u http://host.docker.internal:3000/api/inngest
```

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

The dev server calls the suite's endpoint at `host.docker.internal`; set `TEST_INNGEST_CALLBACK_HOST` when it reaches this machine some other way (CI runs it on the host network, with `127.0.0.1`). Without `TEST_INNGEST_URL` the suite is skipped, except in CI, where it fails.

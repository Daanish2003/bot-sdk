// The Computer lifecycle eval (spec #519, "Evals"): no Model. It drives the real `computer` plugin on
// the E2B adapter and local E2B through sleeping, waking and rebuilding, and checks that the files
// (and, across a sleep, a running process) survive. Run it with
// `pnpm -F @ai-chat/bot-sdk eval:computer:lifecycle`; see eval/computer/README.md.
//
//   1. Write a file and start a process.
//   2. Age the Computer and run the sleep check: it is asleep and its archive is stored.
//   3. Run an operation: the file and the process survived.
//   4. Change the template name: the next operation rebuilds and restores the file.

import { randomUUID } from "node:crypto";

import { user as userTable } from "@ai-chat/db/schema/auth";
import { eq } from "drizzle-orm";

import { computer as computerTable } from "../../core/server/db/schema";
import { computerBlobKey, computerIdleMs } from "../../plugins/computer/server/plugin";
import type { ComputerProvider } from "../../plugins/computer/server";
import { systemClock } from "../../plugins/runner/server/jobs/in-process";
import { claimJob, runClaimedJob } from "../../plugins/runner/server/jobs/store";
import {
  createComputerSdk,
  databaseUrlFromEnv,
  defaultTemplate,
  fail,
  localE2bProvider,
  prepareSchema,
} from "./setup";

const filePath = "/home/user/bots/eval/note.txt";
const fileContent = "remember this across a sleep and a rebuild";

/** The provider with each slow call timed, so the output can report pause, resume and create. */
function timed(provider: ComputerProvider, timings: Map<string, number[]>): ComputerProvider {
  const wrap =
    <A extends unknown[], R>(name: string, call: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      const started = Date.now();
      try {
        return await call(...args);
      } finally {
        timings.set(name, [...(timings.get(name) ?? []), Date.now() - started]);
      }
    };
  return {
    ...provider,
    create: wrap("create", provider.create),
    resume: wrap("resume", provider.resume),
    pause: wrap("pause", provider.pause),
  };
}

async function main() {
  const rebuildTemplate = process.env.EVAL_REBUILD_TEMPLATE ?? `${defaultTemplate}-eval`;
  const template = process.env.EVAL_TEMPLATE ?? defaultTemplate;
  if (rebuildTemplate === template) fail("EVAL_REBUILD_TEMPLATE must differ from the template");
  const db = await prepareSchema(databaseUrlFromEnv());
  const timings = new Map<string, number[]>();
  const sdk = createComputerSdk({ db, provider: timed(localE2bProvider(template), timings) });
  const rebuilt = createComputerSdk({
    db,
    provider: timed(localE2bProvider(rebuildTemplate), timings),
  });

  const userId = randomUUID();
  await db.insert(userTable).values({ id: userId, name: "Eval", email: `${userId}@eval.invalid` });
  const row = async () =>
    (await db.select().from(computerTable).where(eq(computerTable.userId, userId)))[0];

  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
    if (!ok) failures.push(name);
  };
  const timeOf = (name: string) => (timings.get(name) ?? []).map((ms) => `${ms} ms`).join(", ");

  /** Runs every queued sleep check as if `computerIdleMs` had passed, and returns the time it took. */
  const runSleepCheck = async (over: typeof sdk) => {
    const started = Date.now();
    const due = new Date(Date.now() + computerIdleMs + 60_000);
    // A bounded loop: a check that keeps the Computer awake queues its follow-up inside the window.
    for (let ran = 0; ran < 10; ran++) {
      const claimed = await claimJob(db, due);
      if (!claimed) break;
      await runClaimedJob(db, claimed, { clock: systemClock, logger: console, deps: () => over });
    }
    return Date.now() - started;
  };
  /** Makes the Computer look idle: its last activity is past the idle limit. */
  const ageComputer = () =>
    db
      .update(computerTable)
      .set({ lastActiveAt: new Date(Date.now() - computerIdleMs - 60_000) })
      .where(eq(computerTable.userId, userId));

  console.log(`Computer lifecycle eval: template ${template}, rebuild template ${rebuildTemplate}`);
  try {
    // 1. Write a file and start a process.
    console.log("1. write a file and start a process");
    const handle = sdk.plugin("computer").forUser(userId);
    const started = Date.now();
    await handle.writeFile(filePath, fileContent);
    const create = Date.now() - started;
    const spawned = await handle.run("setsid nohup sleep 86400 >/dev/null 2>&1 & echo $!");
    const pid = "stdout" in spawned ? spawned.stdout.trim() : "";
    check("the process started", /^\d+$/.test(pid), `pid ${pid}, first operation ${create} ms`);
    const first = await row();
    check("the Computer is awake", first?.state === "awake" && !!first.sandboxId);

    // 2. Age it, run the check, and expect it asleep with its archive stored.
    console.log("2. age last_active_at and run the sleep check");
    await ageComputer();
    const checkMs = await runSleepCheck(sdk);
    const asleep = await row();
    check("the Computer is asleep", asleep?.state === "asleep", `sleep check ${checkMs} ms`);
    check("the sandbox is kept", asleep?.sandboxId === first?.sandboxId);
    const archive = await sdk.blobStore.get(computerBlobKey(userId));
    check(
      "the archive is stored",
      !!archive && !!asleep?.syncedAt && (asleep.syncedBytes ?? 0) > 0,
      `${archive?.length ?? 0} bytes`,
    );

    // 3. Run an operation: the file and the process survived the pause.
    console.log("3. run an operation");
    const woke = Date.now();
    const bytes = await handle.readFile(filePath);
    const resumeMs = Date.now() - woke;
    check(
      "the file survived",
      new TextDecoder().decode(bytes ?? new Uint8Array()) === fileContent,
      `wake ${resumeMs} ms`,
    );
    const alive = await handle.run(`kill -0 ${pid} && echo alive`);
    check("the process survived", "stdout" in alive && alive.stdout.trim() === "alive");
    const awake = await row();
    check(
      "it woke the same sandbox",
      awake?.state === "awake" && awake.sandboxId === first?.sandboxId,
    );

    // 4. Change the template name: the next operation rebuilds and restores the file.
    console.log("4. change the template name");
    await ageComputer();
    await runSleepCheck(sdk);
    check("the Computer is asleep again", (await row())?.state === "asleep");
    // Local E2B Embed fits one sandbox at a time: a rebuild that creates the new sandbox while the old
    // one is paused fails to place it. So the old one is killed first; the rebuild is the same, since
    // a changed template never resumes the old sandbox, and the kill it ends with is then a no-op.
    if (asleep?.sandboxId) await localE2bProvider(template).kill(asleep.sandboxId);
    const rebuildHandle = rebuilt.plugin("computer").forUser(userId);
    const rebuildStarted = Date.now();
    const restored = await rebuildHandle.readFile(filePath);
    const rebuildMs = Date.now() - rebuildStarted;
    const after = await row();
    check(
      "the next operation rebuilt the Computer",
      after?.template === rebuildTemplate && after.sandboxId !== first?.sandboxId,
      `rebuild ${rebuildMs} ms`,
    );
    check(
      "the file was restored",
      new TextDecoder().decode(restored ?? new Uint8Array()) === fileContent,
    );
    const rebuild = rebuildHandle.takeRebuild();
    check("the rebuild reports what it restored", !!rebuild?.restoredAsOf);
  } finally {
    const last = await row();
    if (last?.sandboxId)
      await localE2bProvider(template)
        .kill(last.sandboxId)
        .catch(() => {});
    await db.delete(computerTable).where(eq(computerTable.userId, userId));
    await sdk.blobStore.delete([computerBlobKey(userId)]).catch(() => {});
    await db.delete(userTable).where(eq(userTable.id, userId));
  }

  console.log("\nTimings");
  console.log(`  create:  ${timeOf("create")}`);
  console.log(`  pause:   ${timeOf("pause")}`);
  console.log(`  resume:  ${timeOf("resume")}`);
  console.log(failures.length === 0 ? "\nAll checks passed." : `\nFailed: ${failures.join("; ")}`);
  await db.$client.end();
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();

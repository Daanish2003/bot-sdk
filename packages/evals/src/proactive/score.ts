// Scores the Proactive eval (spec #1024, ticket #1032) from what a Turn left behind: its status, its
// tool calls (a `run_tool` call already unwrapped to the tool it names) and, for the first-Bot case,
// the Routines it saved. Everything here is deterministic; no judge. Text is normalised first (curly
// quotes and dashes made plain).

import { normalise } from "../channels/score";

/** One tool call of a Turn, in order, with its args. */
export type Call = { name: string; args: unknown };

/** What a run's Turn left behind. */
export type Observed = {
  status: "running" | "complete" | "error" | "stopped";
  calls: Call[];
  /** The Bot's saved Routines, for the `offers` expectation. */
  routines?: { name: string; state: string; readOnly: boolean; schedule: unknown }[];
};

/** What a Turn is expected to do. */
export type Expect =
  /** Nothing is new (or already noted): no Message and no attempt to change anything. */
  | { kind: "quiet" }
  /** An urgent item: a Message about it, marked `urgent`. */
  | { kind: "urgent"; item: RegExp }
  /** A non-urgent item: no Message, and a Note (a write or edit of `notes.md`) about it. */
  | { kind: "note"; item: RegExp }
  /** The next brief: a Message that includes what the Watch noted. */
  | { kind: "brief-includes"; item: RegExp }
  /** A write is needed: a Message with a choice, and at most one refused attempt. */
  | { kind: "draft"; item: RegExp }
  /** The first Bot saved the Morning brief and the Watch, both pending. */
  | { kind: "offers" };

export type Score = { passed: boolean; reasons: string[] };

export const sendToUser = "send_to_user";

/** Connector tools that change something; the Mail Connection's `send_email`. */
const connectorWrites = new Set(["mail_send_email"]);

/** Calls a read-only run refuses, besides a Connector write. */
const refusedCalls = new Set([
  "shell",
  "start_helper",
  "generate_image",
  "watch_user",
  "create_routine",
  "update_routine",
  "delete_routine",
  "propose_rule",
]);

const asObject = (args: unknown): Record<string, unknown> =>
  typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};

/** A Message the Turn sent: its text, whether it is marked urgent, and the options of its choice. */
export type Sent = { text: string; urgent: boolean; options: string[] };

export function sentMessages(calls: readonly Call[]): Sent[] {
  return calls
    .filter((call) => call.name === sendToUser)
    .flatMap((call) => {
      const args = asObject(call.args);
      if (typeof args.text !== "string" || !args.text.trim()) return [];
      const options = asObject(args.choice).options;
      return [
        {
          text: normalise(args.text),
          urgent: args.urgent === true,
          options: Array.isArray(options) ? options.map(String) : [],
        },
      ];
    });
}

/** The calls that write or edit a Notes file, with the text they put in it. */
export function noteWrites(calls: readonly Call[]): string[] {
  return calls.flatMap((call) => {
    if (call.name !== "write" && call.name !== "edit") return [];
    const args = asObject(call.args);
    if (typeof args.path !== "string" || !args.path.endsWith("notes.md")) return [];
    const text = call.name === "write" ? args.content : args.newText;
    return typeof text === "string" ? [normalise(text)] : [];
  });
}

/** Calls the Turn made that a read-only run refuses (a Connector write counts). */
export function refusedAttempts(calls: readonly Call[]): Call[] {
  return calls.filter((call) => refusedCalls.has(call.name) || connectorWrites.has(call.name));
}

const weekdays = ["mon", "tue", "wed", "thu", "fri"];
const sameSet = (a: unknown, b: readonly string[]) =>
  Array.isArray(a) && a.length === b.length && b.every((item) => a.includes(item));

/** Scores one Turn of a run against its expectation. `watch` turns also must not loop on a refusal. */
export function scoreProactive(
  expect: Expect,
  observed: Observed,
  { watch }: { watch: boolean } = { watch: true },
): Score {
  const reasons: string[] = [];
  if (observed.status !== "complete") reasons.push(`the Turn ended ${observed.status}`);
  const { calls } = observed;
  const sent = sentMessages(calls);
  const refused = refusedAttempts(calls);
  if (watch && refused.length > 1) {
    reasons.push(
      `kept trying what a read-only run refuses: ${refused.map((c) => c.name).join(", ")}`,
    );
  }

  switch (expect.kind) {
    case "quiet": {
      for (const message of sent) reasons.push(`sent a Message: ${message.text.slice(0, 80)}`);
      for (const call of refused) reasons.push(`tried ${call.name}`);
      break;
    }
    case "urgent": {
      const about = sent.filter((message) => expect.item.test(message.text));
      if (about.length === 0) reasons.push("sent no Message about the urgent item");
      else if (!about.some((message) => message.urgent)) {
        reasons.push("sent the urgent item but didn't mark it urgent");
      }
      break;
    }
    case "note": {
      for (const message of sent) reasons.push(`sent a Message: ${message.text.slice(0, 80)}`);
      if (!noteWrites(calls).some((text) => expect.item.test(text))) {
        reasons.push("saved no Note about the item");
      }
      break;
    }
    case "brief-includes": {
      if (!sent.some((message) => expect.item.test(message.text))) {
        reasons.push("the brief didn't include the item the Watch noted");
      }
      break;
    }
    case "draft": {
      if (sent.length === 0) reasons.push("sent no Message");
      else if (
        !sent.some((message) => message.options.length >= 2 && expect.item.test(message.text))
      ) {
        reasons.push("sent no draft about the item with a choice");
      }
      break;
    }
    case "offers": {
      const saved = observed.routines ?? [];
      const brief = saved.find((routine) => {
        const schedule = asObject(routine.schedule);
        return (
          !routine.readOnly &&
          sameSet(schedule.times, ["08:00"]) &&
          sameSet(schedule.days, weekdays)
        );
      });
      const check = saved.find((routine) => {
        const schedule = asObject(routine.schedule);
        return (
          routine.readOnly &&
          sameSet(schedule.times, ["11:00", "14:00", "17:00", "20:00"]) &&
          sameSet(schedule.days, weekdays)
        );
      });
      if (!brief) reasons.push("saved no Morning brief (weekdays 08:00, not read-only)");
      if (!check) reasons.push("saved no Watch (weekdays 11:00, 14:00, 17:00, 20:00, read-only)");
      for (const routine of saved) {
        if (routine.state !== "pending")
          reasons.push(`${routine.name} is ${routine.state}, not pending`);
      }
      if (saved.length > 2) reasons.push(`saved ${saved.length} Routines, expected 2`);
      break;
    }
  }
  return { passed: reasons.length === 0, reasons };
}

/** A Turn's cost from its usage rows. */
export type Cost = {
  rows: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** What the rows record, in US dollars: 0 on the user's own key or plan. */
  recordedUsd: number;
  /** The tokens at the list prices (`priceFromEnv`), in US dollars. */
  listUsd: number;
};

/** Dollars per million tokens. */
export type Prices = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Sonnet's list prices unless the environment says otherwise. */
export const defaultPrices: Prices = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

export type UsageRow = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros: number;
};

/** Sums usage rows. `inputTokens` includes cache reads and writes, so those are priced apart. */
export function costOf(rows: readonly UsageRow[], prices: Prices = defaultPrices): Cost {
  const sum = (pick: (row: UsageRow) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);
  const inputTokens = sum((row) => row.inputTokens);
  const outputTokens = sum((row) => row.outputTokens);
  const cacheReadTokens = sum((row) => row.cacheReadTokens);
  const cacheWriteTokens = sum((row) => row.cacheWriteTokens);
  const fresh = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  const listUsd =
    (fresh * prices.input +
      outputTokens * prices.output +
      cacheReadTokens * prices.cacheRead +
      cacheWriteTokens * prices.cacheWrite) /
    1_000_000;
  return {
    rows: rows.length,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    recordedUsd: sum((row) => row.costMicros) / 1_000_000,
    listUsd,
  };
}

/** A run, for the tally. */
export type Run = { caseId: string; gating: boolean; score: Score };

/** Passed over total for the gating runs. */
export function tallyProactive(runs: readonly Run[]) {
  const gating = runs.filter((run) => run.gating);
  return {
    gating: { passed: gating.filter((run) => run.score.passed).length, total: gating.length },
  };
}

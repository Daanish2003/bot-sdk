/*
 * The workflow engine (ADR 0011, the #481 and #482 amendments): Temporal's history replay, without
 * its sandbox. A workflow records each call in a history. Replaying its code against that history
 * returns the recorded results without running anything, and calls past the end run for real and
 * are recorded. This module imports nothing, so it can become its own package later.
 */

/** What a history entry records. */
export type HistoryKind = "activity" | "now" | "random" | "patched";

/** One recorded call. `seq` is its place in call order, from 1. */
export type HistoryEntry = {
  seq: number;
  kind: HistoryKind;
  /** The activity's or the patch's name; empty for `now` and `random`. */
  name: string;
  /** The activity's JSON result (its Checkpoint), the time in ms, the number, or null. */
  result: unknown;
};

/**
 * Where a workflow's history is saved. Every save is fenced to the attempt that runs it: it
 * returns `saved: false` and writes nothing once that attempt no longer owns the workflow.
 */
export type HistoryStore<Tx> = {
  /** Saves an entry whose result is already known. */
  save: (entry: HistoryEntry) => Promise<boolean>;
  /**
   * Runs `fn` in a transaction and saves the entry with its result in that same transaction, so
   * `fn`'s writes commit with the entry or not at all.
   */
  saveWith: <T>(
    entry: Omit<HistoryEntry, "result">,
    fn: (tx: Tx) => Promise<T>,
  ) => Promise<{ saved: true; result: T } | { saved: false }>;
};

/** What a workflow's code calls. Each call is recorded, and replayed on a later attempt. */
export type WorkflowContext<Tx> = {
  /**
   * Runs `fn` and saves its JSON result, the Checkpoint. On replay it returns the saved result
   * without running `fn`. A thrown `fn` saves nothing.
   *
   * - `activity(name, () => …)`: side effects are at-least-once. A crash after `fn` but before the
   *   save runs it again.
   * - `activity(name, (tx) => …)`: `fn` gets the transaction its Checkpoint is saved in, so a write
   *   to the same database commits exactly once. A function that declares a parameter gets one.
   */
  activity: <T>(name: string, fn: (tx: Tx) => Promise<T> | T) => Promise<T>;
  /** The current time, recorded, so a replay returns the same time. */
  now: () => Promise<Date>;
  /** A random number in [0, 1), recorded, so a replay returns the same number. */
  random: () => Promise<number>;
  /**
   * As in Temporal: `true` in a new run (records a marker), `true` on a replay with the marker,
   * and `false` on a replay that passes this point without it (records nothing).
   */
  patched: (id: string) => Promise<boolean>;
};

/**
 * A replay met a call that doesn't match the recorded entry, or the workflow ended with entries
 * left over. It fails the job permanently, even if the workflow's code catches it.
 */
export class NonDeterminismError extends Error {
  constructor(seq: number, recorded: Call, called: string) {
    super(
      `Non-deterministic workflow at seq ${seq}: the history recorded ${describe(recorded)}, ` +
        `but the code ${called}`,
    );
    this.name = "NonDeterminismError";
  }
}

/** The attempt lost its workflow (its lease expired, or it was cancelled), so nothing was saved. */
export class WorkflowLostError extends Error {
  constructor() {
    super("The attempt no longer owns its workflow");
    this.name = "WorkflowLostError";
  }
}

/**
 * The workflow saved a Checkpoint after its runner asked it to yield (a deploy's `stop()`), and
 * stopped there so that another process can resume it. Like `NonDeterminismError`, it stands even
 * if the workflow's code catches it.
 */
export class WorkflowYieldedError extends Error {
  constructor() {
    super("The workflow yielded at a Checkpoint");
    this.name = "WorkflowYieldedError";
  }
}

type Call = Pick<HistoryEntry, "kind" | "name">;

function describe({ kind, name }: Call): string {
  return name ? `${kind} "${name}"` : kind;
}

/** A value as it reads back from the history: JSON, with `undefined` as null. */
function asJson<T>(value: T): T {
  return (value === undefined ? null : JSON.parse(JSON.stringify(value))) as T;
}

export type WorkflowOptions<Tx> = {
  /** The history recorded so far, in seq order. Empty for a new workflow. */
  history: readonly HistoryEntry[];
  store: HistoryStore<Tx>;
  now: () => Date;
  random?: () => number;
  /** Once aborted, no new work starts: a call past the end of the history throws its reason. */
  signal?: AbortSignal;
  /**
   * Once aborted, the workflow yields at its next Checkpoint: the next activity saves its result,
   * then throws `WorkflowYieldedError`.
   */
  yieldSignal?: AbortSignal;
  /** Called once when a save finds the attempt no longer owns its workflow. */
  onLost?: () => void;
};

export type Workflow<Tx> = {
  context: WorkflowContext<Tx>;
  /**
   * Called once the workflow's code has returned. Throws the `NonDeterminismError` a replay met or
   * the `WorkflowYieldedError` a yield threw, even one the code caught, or a `NonDeterminismError`
   * for history entries the code never reached.
   */
  finish: () => void;
};

/**
 * A workflow that replays `history`, then records each new call through `store`. Call order is
 * identity, so the context's calls run one at a time: each is awaited before the next starts.
 */
export function createWorkflow<Tx>({
  history,
  store,
  now,
  random = Math.random,
  signal,
  yieldSignal,
  onLost,
}: WorkflowOptions<Tx>): Workflow<Tx> {
  let next = 0;
  let failure: NonDeterminismError | WorkflowYieldedError | undefined;
  let busy = false;

  /** Runs one call, refusing a second while the first is still pending. */
  const oneAtATime = async <T>(run: () => Promise<T>): Promise<T> => {
    if (failure) throw failure;
    if (busy) throw new Error("A workflow's calls run one at a time: await each before the next");
    busy = true;
    try {
      return await run();
    } finally {
      busy = false;
    }
  };

  /** The recorded entry for this call, or undefined past the end of the history. */
  const replay = (call: Call): HistoryEntry | undefined => {
    const entry = history[next];
    if (!entry) {
      signal?.throwIfAborted();
      return undefined;
    }
    if (entry.kind !== call.kind || entry.name !== call.name) {
      failure = new NonDeterminismError(entry.seq, entry, `called ${describe(call)}`);
      throw failure;
    }
    next += 1;
    return entry;
  };

  // Past the end of the history, a call's seq follows the last one saved.
  let seq = history.at(-1)?.seq ?? 0;
  const lost = (): never => {
    onLost?.();
    throw new WorkflowLostError();
  };
  const record = async <T>(call: Call, result: T): Promise<T> => {
    const value = asJson(result);
    if (!(await store.save({ seq: seq + 1, ...call, result: value }))) lost();
    seq += 1;
    return value;
  };
  // Called once an activity's Checkpoint is saved: a yield requested by then stops the workflow here.
  const checkpointed = <T>(result: T): T => {
    if (!yieldSignal?.aborted) return result;
    failure = new WorkflowYieldedError();
    throw failure;
  };

  const context: WorkflowContext<Tx> = {
    activity: <T>(name: string, fn: (tx: Tx) => Promise<T> | T) =>
      oneAtATime(async (): Promise<T> => {
        const call: Call = { kind: "activity", name };
        const entry = replay(call);
        if (entry) return entry.result as T;
        if (fn.length === 0) {
          return checkpointed(await record(call, await (fn as () => Promise<T> | T)()));
        }
        const saved = await store.saveWith({ seq: seq + 1, ...call }, async (tx) =>
          asJson(await fn(tx)),
        );
        if (!saved.saved) return lost();
        seq += 1;
        return checkpointed(saved.result);
      }),

    now: () =>
      oneAtATime(async () => {
        const entry = replay({ kind: "now", name: "" });
        if (entry) return new Date(entry.result as number);
        return new Date(await record({ kind: "now", name: "" }, now().getTime()));
      }),

    random: () =>
      oneAtATime(async () => {
        const entry = replay({ kind: "random", name: "" });
        if (entry) return entry.result as number;
        return record({ kind: "random", name: "" }, random());
      }),

    patched: (id) =>
      oneAtATime(async () => {
        const entry = history[next];
        if (entry) {
          // A replay: the marker is here, or this run started before the patch.
          if (entry.kind !== "patched" || entry.name !== id) return false;
          next += 1;
          return true;
        }
        signal?.throwIfAborted();
        await record({ kind: "patched", name: id }, null);
        return true;
      }),
  };

  return {
    context,
    finish: () => {
      if (failure) throw failure;
      const left = history[next];
      if (left) throw new NonDeterminismError(left.seq, left, "ended before reaching it");
    },
  };
}

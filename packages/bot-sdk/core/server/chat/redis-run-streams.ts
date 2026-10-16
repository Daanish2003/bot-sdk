import type { StreamChunk } from "@tanstack/ai";

import type { RedisConnection } from "./redis-connection";
import {
  CLOSED_LOG_TTL_MS,
  FLUSH_MS,
  START,
  type RunEntry,
  type RunStreams,
  type RunStreamsOptions,
} from "./run-streams";

/** Entries a reader fetches per round trip. */
const READ_BATCH = 100;
const STREAM_ID = /^\d+-\d+$/;
const FIRST_ID = "0-0";

type Marker = { state: "open" | "closed" };
type Field = { chunk?: string; state?: Marker["state"] };

/** A run's appends that the owning process has accepted but not yet written to Redis. */
type Pending = {
  queued: Array<{ chunk: StreamChunk; resolve: () => void; reject: (error: unknown) => void }>;
  timer?: ReturnType<typeof setTimeout>;
  /** Writes to one log happen one batch at a time, so the log keeps its order. */
  chain: Promise<void>;
  closed: boolean;
};

/**
 * `RunStreams` over one Redis Stream per Run (ADR 0006). The owning process batches appends about
 * every 50 ms and writes each batch in one MULTI; a `closed` marker ends the log, and the stream
 * expires a fixed time after it. The `open` marker lets a read of a never-opened run end at once.
 *
 * Readers poll the stream every 50 ms rather than hold a blocking connection each: a blocking
 * `XREAD` would tie up one connection per reader, and abort could only be honoured by tearing it
 * down.
 */
export function createRedisRunStreams(
  connection: RedisConnection,
  prefix: string,
  { closedLogTtlMs = CLOSED_LOG_TTL_MS }: RunStreamsOptions = {},
): RunStreams {
  const keyOf = (runId: string) => `${prefix}run-log:${runId}`;
  /** Runs this process opened and has not closed: the only ones it may append to. */
  const open = new Map<string, Pending>();

  const flush = (runId: string) => {
    const pending = open.get(runId);
    if (!pending) return Promise.resolve();
    clearTimeout(pending.timer);
    pending.timer = undefined;
    const queued = pending.queued.splice(0);
    if (queued.length === 0) return pending.chain;

    pending.chain = pending.chain.then(async () => {
      try {
        const client = await connection.command();
        const multi = client.multi();
        for (const { chunk } of queued) {
          multi.xAdd(keyOf(runId), "*", { chunk: JSON.stringify(chunk) });
        }
        await multi.exec();
        for (const { resolve } of queued) resolve();
      } catch (error) {
        for (const { reject } of queued) reject(error);
      }
    });
    return pending.chain;
  };

  return {
    async open(runId) {
      if (open.has(runId)) return;
      open.set(runId, { queued: [], chain: Promise.resolve(), closed: false });
      try {
        const client = await connection.command();
        await client.xAdd(keyOf(runId), "*", { state: "open" satisfies Marker["state"] });
      } catch (error) {
        // Forget the run, so a retried open writes its marker.
        open.delete(runId);
        throw error;
      }
    },

    append(runId, chunk) {
      const pending = open.get(runId);
      if (!pending || pending.closed) {
        return Promise.reject(new Error(`Run ${runId} is not open for appends`));
      }
      return new Promise<void>((resolve, reject) => {
        pending.queued.push({ chunk, resolve, reject });
        pending.timer ??= setTimeout(() => void flush(runId), FLUSH_MS);
      });
    },

    async close(runId) {
      const pending = open.get(runId);
      if (!pending || pending.closed) return;
      pending.closed = true;
      await flush(runId);
      const client = await connection.command();
      const multi = client.multi();
      multi.xAdd(keyOf(runId), "*", { state: "closed" satisfies Marker["state"] });
      multi.pExpire(keyOf(runId), closedLogTtlMs);
      await multi.exec();
      open.delete(runId);
    },

    read(runId, offset, signal) {
      return readLog(connection, keyOf(runId), offset, signal);
    },
  };
}

async function* readLog(
  connection: RedisConnection,
  key: string,
  offset: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<RunEntry> {
  const from = offset === START ? FIRST_ID : offset;
  if (!STREAM_ID.test(from)) throw new Error(`Unknown run offset "${offset}"`);
  let lastId = from;

  while (!signal?.aborted) {
    const client = await connection.command();
    const [stream] = (await client.xRead({ key, id: lastId }, { COUNT: READ_BATCH })) ?? [];
    const messages = stream?.messages ?? [];

    if (messages.length === 0) {
      // Nothing new. A log that doesn't exist was never opened, or has expired: nothing to wait for.
      if ((await client.exists(key)) === 0) return;
      await sleep(FLUSH_MS, signal);
      continue;
    }

    for (const { id, message } of messages) {
      lastId = id;
      const field = message as Field;
      if (field.state === "closed") return;
      if (field.state === "open") continue;
      yield { offset: id, chunk: JSON.parse(field.chunk ?? "null") as StreamChunk };
    }
  }
}

/** Waits `ms`, or until the signal aborts, whichever comes first. */
function sleep(ms: number, signal: AbortSignal | undefined) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

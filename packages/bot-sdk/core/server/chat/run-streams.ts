import type { StreamChunk, StreamDurability } from "@tanstack/ai";

/**
 * The offset that reads a log from its first entry: TanStack AI's `offset=-1` join convention.
 * Every other offset is one `read` returned.
 */
export const START = "-1";

/** One entry of a Run's log, with the offset a reader resumes from. */
export type RunEntry = { offset: string; chunk: StreamChunk };

/**
 * One append-only, replayable chunk log per Run, keyed by the Run's id (ADR 0006). The Run appends
 * every chunk before anyone reads it; readers replay from an offset and then tail until the log
 * closes. A log is `open`ed before its first append and `close`d once the Run has ended.
 *
 * Offsets are opaque to callers. Implementations share the contract in `run-streams.contract.ts`.
 */
export interface RunStreams {
  /** Starts a run's log. A read of a run that was never opened ends at once with nothing. */
  open(runId: string): Promise<void>;
  /** Adds a chunk after the ones already appended. Resolves once it is readable. */
  append(runId: string, chunk: StreamChunk): Promise<void>;
  /** Makes every appended chunk readable, then ends the log for its readers. */
  close(runId: string): Promise<void>;
  /** The entries after `offset` (`START` for all), then the ones appended later, until the log closes. */
  read(runId: string, offset: string, signal?: AbortSignal): AsyncIterable<RunEntry>;
}

/** How long appends queue before they're made readable together. */
export const FLUSH_MS = 50;
/** How long a closed log stays readable before it expires. */
export const CLOSED_LOG_TTL_MS = 60 * 60_000;

export type RunStreamsOptions = {
  /** How long a closed log stays readable. Defaults to an hour (ADR 0006). */
  closedLogTtlMs?: number;
};

type Log = {
  entries: RunEntry[];
  queued: Array<{ chunk: StreamChunk; ack: () => void }>;
  flushTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
  /** Readers waiting for an entry, a close or their abort. */
  wake: Set<() => void>;
};

/** The in-process `RunStreams`: one process, logs held in memory, appends batched about every 50 ms. */
export function createMemoryRunStreams({
  closedLogTtlMs = CLOSED_LOG_TTL_MS,
}: RunStreamsOptions = {}): RunStreams {
  const logs = new Map<string, Log>();

  const notify = (log: Log) => {
    const waiting = [...log.wake];
    log.wake.clear();
    for (const wakeReader of waiting) wakeReader();
  };

  const flush = (log: Log) => {
    clearTimeout(log.flushTimer);
    log.flushTimer = undefined;
    const queued = log.queued.splice(0);
    for (const { chunk } of queued) {
      log.entries.push({ offset: String(log.entries.length), chunk });
    }
    for (const { ack } of queued) ack();
    notify(log);
  };

  const logOf = (runId: string) => logs.get(runId);

  return {
    async open(runId) {
      if (!logs.has(runId)) {
        logs.set(runId, { entries: [], queued: [], closed: false, wake: new Set() });
      }
    },

    append(runId, chunk) {
      const log = logOf(runId);
      if (!log || log.closed) {
        return Promise.reject(new Error(`Run ${runId} is not open for appends`));
      }
      return new Promise<void>((ack) => {
        log.queued.push({ chunk, ack });
        log.flushTimer ??= setTimeout(() => flush(log), FLUSH_MS);
      });
    },

    async close(runId) {
      const log = logOf(runId);
      if (!log || log.closed) return;
      flush(log);
      log.closed = true;
      notify(log);
      setTimeout(() => logs.delete(runId), closedLogTtlMs);
    },

    read(runId, offset, signal) {
      return readLog(logOf(runId), offset, signal);
    },
  };
}

async function* readLog(
  log: Log | undefined,
  offset: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<RunEntry> {
  if (!log) return;
  let next = offset === START ? 0 : Number(offset) + 1;
  if (!Number.isInteger(next) || next < 0) throw new Error(`Unknown run offset "${offset}"`);

  while (!signal?.aborted) {
    const entry = log.entries[next];
    if (entry) {
      next++;
      yield entry;
      continue;
    }
    if (log.closed) return;
    await new Promise<void>((resolve) => {
      const wakeReader = () => {
        log.wake.delete(wakeReader);
        signal?.removeEventListener("abort", wakeReader);
        resolve();
      };
      log.wake.add(wakeReader);
      signal?.addEventListener("abort", wakeReader, { once: true });
    });
  }
}

/**
 * A TanStack AI `StreamDurability` over one Run's log, served by `resumeServerSentEventsResponse`.
 * TanStack's `memoryStream` keeps its own process-wide logs, so it can't read a `RunStreams`; this
 * adapter is keyed by the Run's id instead. Only the replay path is used: the Run writes through
 * `RunStreams.append`, not through the adapter.
 */
export function runStreamDurability(
  streams: RunStreams,
  runId: string,
  resumeFrom: string,
): StreamDurability {
  return {
    resumeFrom: () => resumeFrom,
    read: (offset, signal) => streams.read(runId, offset, signal),
    append: () => {
      throw new Error("A Run appends to its log through RunStreams.append");
    },
    close: async () => {},
    snapshot: () => {
      throw new Error("A Run's log is read with RunStreams.read, not snapshot");
    },
  };
}

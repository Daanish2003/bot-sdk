import { EventType, type StreamChunk } from "@tanstack/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMemoryRunStreams,
  type RunEntry,
  START,
} from "../../../../core/server/chat/run-streams";
import { runStreamsContract } from "./run-streams.contract";

runStreamsContract("memory", (options) => createMemoryRunStreams(options));

const chunk = (delta: string) =>
  ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta, timestamp: 0 }) as StreamChunk;

/** Reads a run's log from the start into `seen`, as it arrives. */
function follow(streams: ReturnType<typeof createMemoryRunStreams>, runId: string) {
  const seen: RunEntry[] = [];
  void (async () => {
    for await (const entry of streams.read(runId, START)) seen.push(entry);
  })();
  return seen;
}

describe("memory RunStreams timing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("makes appends readable in one batch about 50 ms after the first of them", async () => {
    const streams = createMemoryRunStreams();
    const runId = "run-batch";
    await streams.open(runId);
    const seen = follow(streams, runId);

    void streams.append(runId, chunk("a"));
    void streams.append(runId, chunk("b"));
    await vi.advanceTimersByTimeAsync(49);
    expect(seen).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(seen.map((entry) => entry.chunk)).toEqual([chunk("a"), chunk("b")]);
  });

  it("keeps a closed log for an hour, then expires it", async () => {
    const streams = createMemoryRunStreams();
    const runId = "run-expiry";
    await streams.open(runId);
    const kept = streams.append(runId, chunk("kept"));
    await vi.advanceTimersByTimeAsync(50);
    await kept;
    await streams.close(runId);

    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    const before: RunEntry[] = [];
    for await (const entry of streams.read(runId, START)) before.push(entry);
    expect(before).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    const after: RunEntry[] = [];
    for await (const entry of streams.read(runId, START)) after.push(entry);
    expect(after).toEqual([]);
  });

  it("does not expire a log that is still open", async () => {
    const streams = createMemoryRunStreams();
    const runId = "run-open";
    await streams.open(runId);
    const first = streams.append(runId, chunk("first"));
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    await first;
    const seen = follow(streams, runId);
    await vi.advanceTimersByTimeAsync(0);

    expect(seen.map((entry) => entry.chunk)).toEqual([chunk("first")]);
  });
});

import {
  type AdapterYieldChunk,
  type AnyTextAdapter,
  EventType,
  type TextOptions,
  type TokenUsage,
} from "@tanstack/ai";

/**
 * A scripted TanStack AI text adapter for tests, modelled on TanStack AI's in-repo
 * `createMockAdapter`. Each call to `chatStream` (one per tool-loop iteration) plays the
 * next scripted round. With `manual: true`, every chunk waits until the test releases it.
 */

type Chunks = AdapterYieldChunk[];

let nextId = 0;
const id = (prefix: string) => `${prefix}-${++nextId}`;

/** An assistant text message, streamed as one delta per argument. */
export function text(...deltas: string[]): Chunks {
  const messageId = id("fake-text");
  return [
    { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", timestamp: Date.now() },
    ...deltas.map((delta): AdapterYieldChunk => ({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta,
      timestamp: Date.now(),
    })),
    { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: Date.now() },
  ];
}

/** Thinking, streamed as `REASONING_*` events with one delta per argument. */
export function thinking(...deltas: string[]): Chunks {
  const messageId = id("fake-reasoning");
  return [
    { type: EventType.REASONING_START, messageId, timestamp: Date.now() },
    {
      type: EventType.REASONING_MESSAGE_START,
      messageId,
      role: "reasoning",
      timestamp: Date.now(),
    },
    ...deltas.map((delta): AdapterYieldChunk => ({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId,
      delta,
      timestamp: Date.now(),
    })),
    { type: EventType.REASONING_MESSAGE_END, messageId, timestamp: Date.now() },
    { type: EventType.REASONING_END, messageId, timestamp: Date.now() },
  ];
}

/** A tool call the model asks for. A round containing one finishes with `tool_calls`. */
export function toolCall({
  id: toolCallId = id("fake-call"),
  name,
  input,
}: {
  id?: string;
  name: string;
  input: unknown;
}): Chunks {
  return [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: name,
      toolName: name,
      timestamp: Date.now(),
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify(input),
      timestamp: Date.now(),
    },
    { type: EventType.TOOL_CALL_END, toolCallId, toolCallName: name, input, timestamp: Date.now() },
  ];
}

/** A Provider error that ends the round, as an adapter reports it. */
export function runError(message: string, code?: string): Chunks {
  return [
    {
      type: EventType.RUN_ERROR,
      message,
      code,
      error: { message, code },
      timestamp: Date.now(),
    },
  ];
}

/**
 * One model call: `RUN_STARTED`, the parts, then `RUN_FINISHED` (`tool_calls` when a part
 * calls a tool, otherwise `stop`). A round ending in `runError` gets no `RUN_FINISHED`.
 */
export function round(...parts: Chunks[]): Chunks {
  const chunks = parts.flat();
  const failed = chunks.some((chunk) => chunk.type === EventType.RUN_ERROR);
  const callsTool = chunks.some((chunk) => chunk.type === EventType.TOOL_CALL_START);
  const started: AdapterYieldChunk = {
    type: EventType.RUN_STARTED,
    runId: "",
    threadId: "",
    timestamp: Date.now(),
  };
  const finished: AdapterYieldChunk = {
    type: EventType.RUN_FINISHED,
    runId: "",
    threadId: "",
    finishReason: callsTool ? "tool_calls" : "stop",
    timestamp: Date.now(),
  };
  return [started, ...chunks, ...(failed ? [] : [finished])];
}

/** The same round, with the usage it reports on its `RUN_FINISHED`. A round without it reports none. */
export function withUsage(played: Chunks, usage: TokenUsage): Chunks {
  return played.map((chunk) =>
    chunk.type === EventType.RUN_FINISHED ? { ...chunk, usage } : chunk,
  );
}

export type FakeAdapter = {
  adapter: AnyTextAdapter;
  /** The options of every `chatStream` call, in order. */
  calls: TextOptions[];
  /**
   * Lets `count` more chunks through (manual mode). Resolves once they have been consumed,
   * that is when the consumer asks for the next chunk, or the stream ends.
   */
  release: (count?: number) => Promise<void>;
  /** Lets every remaining chunk through (manual mode). */
  releaseAll: () => Promise<void>;
};

export function createFakeAdapter({
  rounds,
  model = "fake-model",
  manual = false,
}: {
  rounds: Chunks[];
  model?: string;
  manual?: boolean;
}): FakeAdapter {
  const calls: TextOptions[] = [];
  let released = manual ? 0 : Infinity;
  let consumed = 0;
  let finished = false;
  let wakeStream: (() => void) | undefined;
  let waiters: Array<{ until: number; resolve: () => void }> = [];

  const settleWaiters = () => {
    const ready = waiters.filter((waiter) => finished || consumed >= waiter.until);
    waiters = waiters.filter((waiter) => !ready.includes(waiter));
    for (const waiter of ready) waiter.resolve();
  };

  const waitForRelease = (signal: AbortSignal | undefined) =>
    new Promise<void>((resolve) => {
      if (released > consumed || signal?.aborted) return resolve();
      const wake = () => {
        signal?.removeEventListener("abort", wake);
        resolve();
      };
      wakeStream = wake;
      signal?.addEventListener("abort", wake, { once: true });
    });

  const finish = () => {
    finished = true;
    settleWaiters();
  };

  // Rounds play one after another (one per tool-loop iteration), never concurrently.
  async function* play(options: TextOptions): AsyncGenerator<AdapterYieldChunk> {
    const index = calls.push(options) - 1;
    const script = rounds[index];
    if (!script) {
      finish();
      throw new Error(`The fake adapter has no round ${index + 1} scripted`);
    }
    const signal = options.request?.signal ?? undefined;
    let playedAll = false;
    try {
      for (const chunk of script) {
        await waitForRelease(signal);
        if (signal?.aborted) return;
        yield withRunIds(chunk, options);
        consumed++;
        settleWaiters();
      }
      playedAll = true;
    } finally {
      // The run is over after the last round, a run error, or a round that ended early
      // (aborted, or the consumer stopped pulling).
      const failed = script.some((chunk) => chunk.type === EventType.RUN_ERROR);
      if (!playedAll || failed || index === rounds.length - 1) finish();
    }
  }

  const release = (count = 1) => {
    released = Math.max(released, consumed) + count;
    const done = new Promise<void>((resolve) => {
      waiters.push({ until: released, resolve });
    });
    settleWaiters();
    wakeStream?.();
    return done;
  };

  const adapter: AnyTextAdapter = {
    kind: "text",
    name: "fake",
    model,
    "~types": {
      providerOptions: {},
      inputModalities: ["text"],
      messageMetadataByModality: {
        text: undefined,
        image: undefined,
        audio: undefined,
        video: undefined,
        document: undefined,
      },
      toolCapabilities: [],
      toolCallMetadata: undefined,
      systemPromptMetadata: undefined as never,
    },
    chatStream: play,
    structuredOutput: async () => {
      throw new Error("The fake adapter does not support structured output");
    },
  };

  return {
    adapter,
    calls,
    release,
    releaseAll: () => release(Infinity),
  };
}

function withRunIds(chunk: AdapterYieldChunk, options: TextOptions): AdapterYieldChunk {
  if (chunk.type !== EventType.RUN_STARTED && chunk.type !== EventType.RUN_FINISHED) return chunk;
  return {
    ...chunk,
    runId: options.runId ?? "fake-run",
    threadId: options.threadId ?? "fake-thread",
  };
}

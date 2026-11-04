import type { AnyServerTool } from "@tanstack/ai";

import type { BotSdkContext, Transaction } from "../../plugin";
import { PermanentJobError, type WorkflowContext } from "../../runner/internal";
import { capResult } from "./computer-tools";
import {
  type LoopKit,
  type LoopOptions,
  type LoopResult,
  type LoopSetup,
  type RepresentativeIdentity,
  runLoop,
} from "./loop";

/*
 * The `representativeLoop` core service (ticket #1188, ADR 0029): how a feature reaches the loop. It
 * accepts only a Representative's identity and names every option it passes on, so a feature can't
 * run a Bot's loop, and whatever else a caller casts its way into the call goes no further.
 */

/**
 * What a Representative's tools run through: the loop's activities, recorded so a replay never runs
 * them twice. A tool that sends or changes anything calls one. There's no Computer and no review.
 */
export type RepresentativeLoopKit = Pick<LoopKit, "liveActivity" | "signal"> & {
  liveRequest: <T>(
    name: string,
    toolCallId: string | undefined,
    run: () => Promise<T>,
    write?: (tx: Transaction, result: T | string) => Promise<void>,
  ) => Promise<T | string>;
};

/** A Representative's loop, as a feature's job asks for it. */
export type RepresentativeLoopOptions = {
  /** Who runs, for which Customer. Code sets the Customer's id; a Model never names one. */
  representative: Omit<RepresentativeIdentity, "botId">;
  /** The Representative Turn its model calls are recorded for. */
  sourceId: string;
  input: LoopOptions["input"];
  /** When the loop started: its time limit counts from here. */
  startedAt: Date;
  /** The most Steps it may take. */
  stepLimit: number;
  /** The wall-clock limit from `startedAt`. */
  timeLimitMs: number;
  /**
   * Asked in its own Checkpoint before each model call, a replay getting the recorded answer: true ends
   * the loop there, and the call never starts. A feature's own limit, such as a spending cap.
   */
  stopBefore?: (tx: Transaction) => Promise<boolean>;
  /** The note that gets a Step ending in plain text one more Step, as in `LoopOptions`. */
  plainTextReminder?: string;
  /**
   * Its system prompts and its tools: the Model's list is exactly these. May run activities first,
   * which replay in order, as a loop's setup does.
   */
  setup: (
    kit: RepresentativeLoopKit,
  ) => Promise<Pick<LoopSetup, "tools" | "ended" | "newest"> & { systemPrompts: string[] }>;
};

/** What a played Representative loop came to. */
export type RepresentativeLoopResult = Omit<LoopResult, "failure" | "overBudget"> & {
  /** `stopBefore` ended the loop before a model call. */
  capped: boolean;
  /** The owner's Quota was spent before the loop started: no model call was made. */
  quotaSpent: boolean;
};

export type RepresentativeLoopService = {
  /**
   * Plays the loop in `job`, the feature job's own context. A failure that recorded nothing, or a
   * cancel, throws, so the job retries or ends as it should. The Quota is checked once, recorded,
   * so a resumed loop is never refused. Refuses any identity but a Representative's.
   */
  run: (
    job: WorkflowContext<Transaction> & { signal: AbortSignal },
    options: RepresentativeLoopOptions,
  ) => Promise<RepresentativeLoopResult>;
};

/** `tool` with its result cut when long, nothing saved, however its `execute` got it. */
const cutting = (tool: AnyServerTool): AnyServerTool => {
  const { execute } = tool;
  if (!execute) return tool;
  return {
    ...tool,
    execute: async (args: unknown, context?: unknown) =>
      capResult(await execute(args, context), ""),
  };
};

export function representativeLoopService(deps: BotSdkContext): RepresentativeLoopService {
  return {
    run: async (job, options) => {
      const { userId, representativeId, customerId, model } = options.representative;
      const { stopBefore } = options;
      if ("botId" in options.representative || !representativeId || !customerId) {
        throw new PermanentJobError(
          "The Representative loop runs only a Representative's identity",
        );
      }
      const mayRun = await job.step("representative_quota", async () => {
        const call = await deps.models.resolveModelCall(userId, model);
        // No Model to call: the loop's first model call reports it.
        return !call || (await call.meter.mayRun()).ok;
      });
      if (!mayRun) {
        return {
          quotaSpent: true,
          capped: false,
          timedOut: false,
          stepLimit: false,
          stopped: false,
          error: undefined,
          finished: false,
          transcript: [],
          usage: null,
          lastInput: undefined,
        };
      }
      const { failure, overBudget, ...played } = await runLoop(deps, job, {
        owner: { userId, representativeId, customerId, model },
        sourceId: options.sourceId,
        input: options.input,
        startedAt: options.startedAt,
        stepLimit: options.stepLimit,
        timeLimitMs: options.timeLimitMs,
        plainTextReminder: options.plainTextReminder,
        attempt: job.signal,
        budget: stopBefore && {
          check: async (tx) => ({ stop: await stopBefore(tx) }),
          afterCheck: async () => {},
          spend: async () => {},
        },
        setup: async ({ liveActivity, liveRequest, signal }) => {
          const { tools, systemPrompts, ended, newest } = await options.setup({
            liveActivity,
            // Never pending or blocked: this loop has no review source, so nothing is reviewed.
            liveRequest: liveRequest as RepresentativeLoopKit["liveRequest"],
            signal,
          });
          return { tools: tools.map(cutting), systemPrompts, ended, newest };
        },
      });
      job.signal.throwIfAborted();
      if (failure !== undefined) throw failure;
      return { ...played, quotaSpent: false, capped: overBudget };
    },
  };
}

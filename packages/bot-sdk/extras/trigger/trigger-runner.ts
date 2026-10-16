// The Trigger.dev job runner (ADR 0011). Optional: a Host on Trigger.dev copies this folder next to
// core/ and passes the runner to createBotSdk. The Host owns this file once copied. The SDK never
// imports it, so @trigger.dev/sdk is a Host dependency only.
import { tasks } from "@trigger.dev/sdk";

import type { EnqueueOptions, JobRunner } from "../../plugins/assistant/server/index";

export type TriggerJobRunnerOptions = {
  /** The id of the Host's Trigger.dev task that calls `chat.plugin("assistant").runJob(name, payload)`. */
  taskId: string;
};

/**
 * A JobRunner that hands each job to Trigger.dev. The Host's task receives `{ name, payload }` and
 * calls `chat.plugin("assistant").runJob(name, payload)`. Trigger.dev runs the attempts and retries, so `start()` and
 * `stop()` do nothing here.
 *
 * Only `enqueue` works. `cancel`, `status` and `schedule` throw until a ticket needs them.
 */
export function triggerJobRunner({ taskId }: TriggerJobRunnerOptions): JobRunner {
  const unsupported = (method: string) => {
    throw new Error(`The Trigger.dev job runner does not support ${method} yet`);
  };

  return {
    async enqueue(name: string, payload: unknown, options: EnqueueOptions = {}) {
      const handle = await tasks.trigger(
        taskId,
        { name, payload },
        { idempotencyKey: options.idempotencyKey, delay: options.runAfter },
      );
      return handle.id;
    },
    cancel: async () => unsupported("cancel"),
    status: async () => unsupported("status"),
    schedule: async () => unsupported("schedule"),
    start: async () => {},
    stop: async () => {},
  };
}

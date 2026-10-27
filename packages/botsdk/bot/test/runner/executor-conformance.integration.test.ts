import { inProcessExecutor } from "../../src/runner/internal";
import { executorContract } from "@ai-chat/test-support/executor.contract";
import { manualExecutor, recordingNotify } from "@ai-chat/test-support/executors";

/*
 * The Executor conformance suite (spec #872), run against the in-process Executor and against a
 * manual one, where the test decides when the core's `run` is called.
 */

const silent = { error: () => {} };

executorContract("the in-process Executor", (timer) => {
  const inProcess = inProcessExecutor({ logger: silent, clock: timer.clock });
  const { executor, notified } = recordingNotify(inProcess);
  return { executor, notified, deliver: (jobId) => inProcess.notify(jobId) };
});

executorContract("a manual Executor", () => {
  const manual = manualExecutor();
  return { executor: manual.executor, notified: manual.notified, deliver: manual.run };
});

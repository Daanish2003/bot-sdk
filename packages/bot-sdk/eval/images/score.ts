// Scores the Images eval (spec #801, ticket #809) from what a Turn left behind: its status and its
// tool calls. Everything here is deterministic; no judge.

/** One tool call of a Turn, in order, with its args (a `run_tool` call already unwrapped). */
export type Call = { name: string; args: unknown };

/** What a run's Turn left behind. */
export type Observed = {
  status: "running" | "complete" | "error" | "stopped";
  calls: Call[];
};

/** What a case expects. */
export type Expect =
  /** The user asked for an image: the Bot generates one, then sends a file from `images/` in the same Turn. */
  | { kind: "generate-and-send" }
  /** The user asked for no image: no `generate_image` call, and the Bot answers in a Message. */
  | { kind: "no-image" }
  /** "Change that image": `generate_image` names `path` in `editPaths`, then the Bot sends a file. */
  | { kind: "edit"; path: string };

export type Score = { passed: boolean; reasons: string[] };

export const generateImage = "generate_image";
export const sendToUser = "send_to_user";

const asObject = (args: unknown): Record<string, unknown> =>
  typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};

/** The files a SendToUser call carries, as paths. */
function sentFiles(call: Call): string[] {
  const files = asObject(call.args).files;
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
}

/** Whether `path` is a file under the Bot's `images/` folder, however it is spelled. */
const isImagePath = (path: string) => /(^|\/)images\/[^/]+$/.test(path);

/** Scores one run against the case's expectation. */
export function scoreImages(expect: Expect, observed: Observed): Score {
  const reasons: string[] = [];
  if (observed.status !== "complete") reasons.push(`the Turn ended ${observed.status}`);
  const { calls } = observed;
  const generated = calls.findIndex((call) => call.name === generateImage);

  if (expect.kind === "no-image") {
    if (generated >= 0) reasons.push("generated an image that was not asked for");
    const texts = calls.filter((call) => call.name === sendToUser);
    if (!texts.some((call) => typeof asObject(call.args).text === "string")) {
      reasons.push("sent no Message");
    }
    return { passed: reasons.length === 0, reasons };
  }

  if (generated < 0) {
    reasons.push("did not call generate_image");
    return { passed: false, reasons };
  }
  const input = asObject(calls[generated]!.args);
  if (typeof input.prompt !== "string" || !input.prompt.trim()) reasons.push("sent no prompt");
  if (expect.kind === "edit") {
    const named = Array.isArray(input.editPaths) ? input.editPaths : [];
    if (!named.some((path) => typeof path === "string" && path.endsWith(expect.path))) {
      reasons.push(`did not edit ${expect.path}`);
    }
  }
  const sentAfter = calls
    .slice(generated + 1)
    .some((call) => call.name === sendToUser && sentFiles(call).some(isImagePath));
  if (!sentAfter) reasons.push("did not send the image in the same Turn");
  return { passed: reasons.length === 0, reasons };
}

/** A run, for the tally. */
export type Run = { caseId: string; gating: boolean; score: Score };

/** Passed over total for the gating runs. */
export function tallyImages(runs: readonly Run[]) {
  const gating = runs.filter((run) => run.gating);
  return {
    gating: { passed: gating.filter((run) => run.score.passed).length, total: gating.length },
  };
}

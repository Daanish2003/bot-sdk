import type { Context } from "../../../core/server/context";
import type { ModelsDeps } from "./types";

// Each instance's `ModelsDeps`, keyed by its `models` API, which `plugin("models")` returns.
const states = new WeakMap<object, ModelsDeps>();

/** Records the `ModelsDeps` an instance's `models` API runs on. */
export function bindModelsDeps(api: object, deps: ModelsDeps): void {
  states.set(api, deps);
}

/**
 * The `models` plugin's own `ModelsDeps`, for its procedures, found through the request context's
 * `plugin("models")`.
 */
export function modelsDeps(context: Pick<Context, "plugin">): ModelsDeps {
  const state = states.get(context.plugin("models"));
  if (!state) throw new Error("The models plugin isn't enabled");
  return state;
}

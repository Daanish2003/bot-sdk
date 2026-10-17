import type { HostServerTool } from "./chat/host-tools";
import type { RunStreams } from "../../../core/server/chat/run-streams";
import type { Limits, SearchClient } from "./deps";
import type { McpServerConfig } from "./mcp/servers";
import type { BotSdkContext } from "../../../core/server/plugin";

/** What the `assistant` plugin owns beside the core context: its options and its Run machinery. */
export type AssistantState = {
  /** The Host's own tools, offered to every reply whose Model has tools (`assistant({ tools })`). */
  tools: HostServerTool[];
  /** The remote MCP servers the Host offers (`assistant({ mcpServers })`, spec #91). */
  mcpServers: McpServerConfig[];
  /** Whether Artifacts are on: the `create_artifact` tool, the panel and the version route (`assistant({ artifacts })`). */
  artifacts: boolean;
  /** Whether Memory is on for the Host (`assistant({ memory })`, ADR 0013). */
  memory: boolean;
  searchClient: SearchClient;
  /** Every Run's chunk log, which its POST response and any joiner read (ADR 0006). */
  runStreams: RunStreams;
  /** This process's live Runs by Message id, so `stop()` can drain them; Stop goes through `pubsub`. */
  runs: Map<string, AbortController>;
  limits: Limits;
};

// Each instance's state, keyed by its `assistant` API, which `plugin("assistant")` returns.
const states = new WeakMap<object, AssistantState>();

/** Records the state an instance's `assistant` API runs on. */
export function bindAssistantState(api: object, state: AssistantState): void {
  states.set(api, state);
}

/** The `assistant` plugin's own state, found through the context's `plugin("assistant")`. */
export function assistantState(sdk: Pick<BotSdkContext, "plugin">): AssistantState {
  const state = states.get(sdk.plugin("assistant"));
  if (!state) throw new Error("The assistant plugin isn't enabled");
  return state;
}

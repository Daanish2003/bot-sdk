import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { bindAssistantState, type AssistantState } from "./state";
import { createArtifactToolName, updateArtifactToolName } from "../shared/chat/artifact";
import { fetchUrlToolName } from "../shared/chat/fetch-url";
import { searchKnowledgeToolName } from "../shared/chat/knowledge-search";
import { webSearchToolName } from "../shared/chat/web-search";
import type { SharedConversation } from "../shared/share/conversation";
import { ratingTotals, type RatingTotal } from "./admin/ratings";
import { generatedImageBlobKey } from "./blob-keys";
import { assistantConversationDelete } from "./chat/conversation-delete";
import { handleChat } from "./chat/handle-chat";
import type { HostServerTool } from "./chat/host-tools";
import { handleJoin } from "./chat/join-run";
import { stopUserRuns } from "./chat/run";
import { generatedImage } from "../../../core/server/db/schema";
import { createTavilyClient } from "./chat/tavily";
import { defaultLimits } from "./deps";
import { assistantUserDelete } from "./delete-user";
import { exportAssistantData } from "./export-user";
import { rotateConnectionKeys } from "./mcp/connections";
import { createLifecycle, type Lifecycle } from "./lifecycle";
import { callbackRoute, connectRoute } from "./mcp/routes";
import { checkMcpServers, type McpServerConfig } from "./mcp/servers";
import type { BotSdkContext, BotSdkPlugin, Route } from "../../../core/server/plugin";
import { defaultRateLimits, type RateLimit } from "../../../core/server/rate-limits";
import { appRouter } from "./routers/index";
import { loadSharedGeneratedImage, loadSharedConversation } from "./share/store";

export type AssistantOptions = {
  /**
   * The Host's own tools, written with TanStack AI's `toolDefinition(...).server(fn)`. The Model
   * can call them in any reply whose Model has tools; each call runs on this server. Their names
   * must not be `web_search`, `fetch_url` or `search_knowledge`, the SDK's own tools.
   */
  tools?: HostServerTool[];
  /**
   * Remote MCP servers the users may connect to (spec #91). Streamable HTTP over HTTPS only. Each
   * server needs an OAuth client the Host registered with it ahead of time; the README says which
   * redirect URI to register.
   */
  mcpServers?: McpServerConfig[];
  /**
   * Turns Artifacts on (ADR 0016): the `create_artifact` tool for a Model with tools, the side
   * panel and the version route. Off by default, and then none of them exist.
   */
  artifacts?: boolean;
};

/**
 * The `assistant` plugin's API (`sdk.plugin("assistant")`): the server-only actions a Host calls.
 * `stopRuns` and `ratingTotals` serve the Host's Admin views (spec #277); they have no HTTP route,
 * so the Host decides who may call them.
 */
export type AssistantApi = {
  /**
   * Stops every live Run of the user's, through the same path as Stop (spec #277). A Run whose
   * owner is gone ends `stopped` here; the others end when their owner sees the Stop.
   */
  stopRuns: (userId: string) => Promise<void>;
  /** 👍 and 👎 counts per Model over Ratings stamped at or after `since` (spec #277). */
  ratingTotals: (range: { since: Date }) => Promise<RatingTotal[]>;
  /** The public Shared link snapshot for a token, or `null` for an unknown or removed link. */
  getSharedConversation: (token: string) => Promise<SharedConversation | null>;
};

declare module "../../../core/server/plugin" {
  interface PluginApis {
    assistant: AssistantApi;
  }
}

type AssistantEvent = "onRunEnd" | "onSharedLinkChanged" | "moderate";

type AssistantRule = "runStart" | "sharedLinkView" | "rating";

export type AssistantPlugin = BotSdkPlugin<"assistant", AssistantRule, AssistantEvent>;

/** The rate-limit rules the assistant declares, and their defaults. */
const assistantRateLimits: Record<AssistantRule, RateLimit> = {
  runStart: defaultRateLimits.runStart,
  sharedLinkView: defaultRateLimits.sharedLinkView,
  rating: defaultRateLimits.rating,
};

/**
 * The `assistant` plugin (ADR 0020): Runs and their streams, tools, MCP servers, Artifacts,
 * Knowledge and the reaper. It reaches `models`, `runner` for its background jobs, and `memory`
 * when the Host installs it, only through `plugin(id)`.
 */
export function assistant(options: AssistantOptions = {}): AssistantPlugin {
  const builtIns = [
    webSearchToolName,
    fetchUrlToolName,
    searchKnowledgeToolName,
    ...(options.artifacts ? [createArtifactToolName, updateArtifactToolName] : []),
  ];
  for (const builtIn of builtIns) {
    if (options.tools?.some((tool) => tool.name === builtIn)) {
      throw new Error(`A Host tool can't be named "${builtIn}": the SDK's tool has it`);
    }
  }
  return assistantPlugin((sdk) => {
    // At construction, so a misconfigured server fails the Host's boot (spec #91).
    checkMcpServers(options.mcpServers ?? [], sdk.fetchAllowHosts);
    return productionState(sdk, options);
  });
}

/**
 * The `assistant` plugin with any `given` part of its state in place of the built one: the test
 * seam (`createTestSdk`). Nothing is checked.
 */
export function assistantOver(given: Partial<AssistantState>): AssistantPlugin {
  return assistantPlugin((sdk) => ({ ...productionState(sdk, {}), ...given }));
}

function assistantPlugin(buildState: (sdk: BotSdkContext) => AssistantState): AssistantPlugin {
  // One lifecycle per instance, built by `init`.
  const lifecycles = new WeakMap<BotSdkContext, Lifecycle>();
  const lifecycleOf = (sdk: BotSdkContext) => {
    const lifecycle = lifecycles.get(sdk);
    if (!lifecycle) throw new Error("The assistant plugin wasn't initialised");
    return lifecycle;
  };
  return {
    id: "assistant",
    requires: ["models", "runner"],
    // Softly: without it, past chats aren't searched.
    uses: ["memory"],
    router: appRouter,
    routes: assistantRoutes,
    rateLimits: assistantRateLimits,
    init: (sdk) => {
      const api = assistantApi(sdk);
      bindAssistantState(api, buildState(sdk));
      lifecycles.set(sdk, createLifecycle(sdk, sdk.logger));
      return { api };
    },
    databaseHooks: { conversation: { delete: assistantConversationDelete } },
    deleteUser: assistantUserDelete,
    exportUser: (sdk, userId, tx) => exportAssistantData(sdk, tx, userId),
    rotateKeys: async (sdk) => {
      const { reencrypted, unreadable } = await rotateConnectionKeys(sdk);
      if (unreadable > 0) {
        sdk.logger.error("Stored MCP tokens can't be read; left in place", { unreadable });
      }
      return { reencrypted, unreadable };
    },
    // The reaper.
    start: (sdk) => lifecycleOf(sdk).start(),
    // Drains the Runs; the runner drains the jobs after it.
    stop: (sdk) => lifecycleOf(sdk).stop(),
  };
}

/** The production state, over the core context. */
function productionState(sdk: BotSdkContext, options: AssistantOptions): AssistantState {
  return {
    tools: options.tools ?? [],
    mcpServers: options.mcpServers ?? [],
    artifacts: options.artifacts ?? false,
    searchClient: createTavilyClient(globalThis.fetch),
    runStreams: sdk.runtime.runStreams,
    runs: new Map(),
    limits: defaultLimits,
  };
}

function assistantApi(sdk: BotSdkContext): AssistantApi {
  return {
    stopRuns: async (userId) => {
      // As Stop does, each ended Run fires `onRunEnd` (#265).
      for (const run of await stopUserRuns(sdk, userId)) sdk.events.fire("onRunEnd", run);
    },
    ratingTotals: (range) => ratingTotals(sdk, range),
    getSharedConversation: async (token) => (await loadSharedConversation(sdk, token)) ?? null,
  };
}

/** The assistant's non-RPC routes, under `basePath`. */
const assistantRoutes: Route[] = [
  {
    // A Generated image on a Shared link is public: the link's token is the only key (ADR 0004).
    method: "GET",
    path: "/shared/:token/generated-images/:id",
    public: true,
    handle: async (request, { sdk, params }) =>
      sharedGeneratedImageResponse(sdk, params.token!, params.id!, wantsDownload(request)),
  },
  {
    method: "POST",
    path: "/run",
    handle: async (request, { user, sdk }) =>
      sdk.lifecycle.stopping ? shuttingDown() : handleChat(request, user, sdk),
  },
  {
    method: "GET",
    path: "/run",
    handle: (request, { user, sdk }) => handleJoin(request, user, sdk),
  },
  {
    method: "GET",
    path: "/generated-images/:id",
    handle: async (request, { user, sdk, params }) =>
      generatedImageResponse(sdk, user.id, params.id!, wantsDownload(request)),
  },
  ...(["connect", "callback"] as const).map((step): Route => ({
    method: "GET",
    path: `/mcp/${step}`,
    handle: (request, { user, sdk, basePath }) => {
      const redirectUri = `${new URL(request.url).origin}${basePath}/mcp/callback`;
      const route = step === "connect" ? connectRoute : callbackRoute;
      return route(request, user.id, sdk, redirectUri);
    },
  })),
];

const wantsDownload = (request: Request) =>
  new URL(request.url).searchParams.get("download") === "1";

/**
 * One of the user's Generated images, its bytes straight from the blob store (spec #278). Another
 * user's image, an unknown id or an id that isn't one is 404. The bytes never change, so they are
 * cached for good; `?download=1` names the file for saving.
 */
async function generatedImageResponse(
  deps: BotSdkContext,
  userId: string,
  id: string,
  download: boolean,
): Promise<Response> {
  if (!z.uuid().safeParse(id).success) return notFound();
  const [row] = await deps.db
    .select({ mediaType: generatedImage.mediaType })
    .from(generatedImage)
    .where(and(eq(generatedImage.id, id), eq(generatedImage.userId, userId)));
  const bytes = row ? await deps.blobStore.get(generatedImageBlobKey(id)) : null;
  if (!row || !bytes) return notFound();
  return imageResponse(id, row.mediaType, bytes, download);
}

/**
 * One Generated image on a Shared link (spec #315), served to anyone with the token. Unknown or
 * removed links, a blocked owner, and an image off the shared Branch are all 404.
 */
async function sharedGeneratedImageResponse(
  deps: BotSdkContext,
  token: string,
  id: string,
  download: boolean,
): Promise<Response> {
  if (!z.uuid().safeParse(id).success) return notFound();
  const image = await loadSharedGeneratedImage(deps, token, id);
  if (!image) return notFound();
  return imageResponse(id, image.mediaType, image.bytes, download);
}

/** An image's bytes: immutable and cacheable, named for saving when `download` is set. */
function imageResponse(id: string, mediaType: string, bytes: Uint8Array, download: boolean) {
  const extension = mediaType === "image/jpeg" ? "jpg" : mediaType.split("/")[1];
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": mediaType,
      "Cache-Control": "private, max-age=31536000, immutable",
      ...(download && {
        "Content-Disposition": `attachment; filename="generated-image-${id.slice(0, 8)}.${extension}"`,
      }),
    },
  });
}

function shuttingDown() {
  return Response.json({ code: "error.shuttingDown", params: {} }, { status: 503 });
}

function notFound() {
  return new Response("Not found", { status: 404 });
}

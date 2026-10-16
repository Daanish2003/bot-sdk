import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { ModelsRule } from "../../plugins/models/server/plugin";
import { createArtifactToolName, updateArtifactToolName } from "../shared/chat/artifact";
import { fetchUrlToolName } from "../shared/chat/fetch-url";
import { searchKnowledgeToolName } from "../shared/chat/knowledge-search";
import { webSearchToolName } from "../shared/chat/web-search";
import type { SharedConversation } from "../shared/share/conversation";
import { ratingTotals, type RatingTotal } from "./admin/ratings";
import { generatedImageBlobKey } from "./blob/store";
import { handleChat } from "./chat/handle-chat";
import type { HostServerTool } from "./chat/host-tools";
import { handleJoin } from "./chat/join-run";
import { stopUserRuns } from "./chat/run";
import { generatedImage } from "./db/schema";
import { deleteUserData } from "./delete-user";
import { createAppDeps, type AppDeps } from "./deps";
import { exportUserData, type UserExport } from "./export-user";
import { runRegisteredJob } from "./jobs/define";
import type { JobRunner } from "./jobs/runner";
import { createLifecycle } from "./lifecycle";
import { callbackRoute, connectRoute } from "./mcp/routes";
import { checkMcpServers, type McpServerConfig } from "./mcp/servers";
import { handleConversationEvents } from "./memory/notice";
import type { BotSdkContext, BotSdkPlugin, Route } from "./plugin";
import { defaultRateLimits, type RateLimit, type ResolvedRateLimits } from "./rate-limits";
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
  /**
   * Runs the background jobs (ADR 0011). Defaults to the in-process runner, which polls the
   * `chat` schema and needs nothing beyond Postgres. `start()` and `stop()` start and stop it.
   */
  jobs?: JobRunner;
  /**
   * Turns Memory on or off for the whole Host (ADR 0013). On by default: the assistant learns facts
   * from what users say, in the background, on the Background Model. `false` makes no Memories.
   */
  memory?: boolean;
};

/** The temporary `assistant` plugin's API: today's SDK but `models`, until the rest is carved out. */
export type AssistantApi = {
  /** The dependency bundle every module still reads (until the core context replaces it). */
  deps: AppDeps;
  getSharedConversation: (token: string) => Promise<SharedConversation | null>;
  runJob: (name: string, payload: unknown) => Promise<void>;
  deleteUser: (userId: string) => Promise<void>;
  exportUser: (userId: string) => Promise<UserExport>;
  admin: {
    stopRuns: (userId: string) => Promise<void>;
    ratingTotals: (range: { since: Date }) => Promise<RatingTotal[]>;
  };
};

declare module "./plugin" {
  interface PluginApis {
    assistant: AssistantApi;
  }
}

/** Every event hook but `models`'s `onUsage`: the temporary plugin is the rest of the SDK. */
type AssistantEvent =
  | "onRunEnd"
  | "onConversationCreated"
  | "onConversationDeleted"
  | "onSharedLinkChanged"
  | "moderate";

type AssistantRule = Exclude<keyof ResolvedRateLimits, ModelsRule>;

export type AssistantPlugin = BotSdkPlugin<"assistant", AssistantRule, AssistantEvent>;

/** The rate-limit rules the assistant declares: every rule but the `models` plugin's. */
const assistantRateLimits: Record<AssistantRule, RateLimit> = {
  runStart: defaultRateLimits.runStart,
  attachmentUpload: defaultRateLimits.attachmentUpload,
  conversationSearch: defaultRateLimits.conversationSearch,
  sharedLinkView: defaultRateLimits.sharedLinkView,
  rating: defaultRateLimits.rating,
};

/**
 * The `assistant` plugin. For now it is today's SDK but the `models` plugin, still on `AppDeps`
 * inside; the core is carved out of it ticket by ticket (spec #439). It reaches `models` only
 * through `plugin("models")`.
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
  return assistantPlugin((sdk) => assistantDeps(sdk, options));
}

/**
 * The `assistant` plugin over a ready dependency bundle: the test seam (`createTestSdk`) and the
 * handler the tests drive. The bundle's `plugin` becomes the instance's.
 */
export function assistantOver(deps: AppDeps): AssistantPlugin {
  return assistantPlugin((sdk) => Object.assign(deps, { plugin: sdk.plugin }));
}

function assistantPlugin(buildDeps: (sdk: BotSdkContext) => AppDeps): AssistantPlugin {
  // One bundle per instance, built by `init`.
  const states = new WeakMap<
    BotSdkContext,
    { deps: AppDeps; lifecycle: ReturnType<typeof createLifecycle> }
  >();
  const ready = (sdk: BotSdkContext) => {
    let state = states.get(sdk);
    if (!state) {
      const deps = buildDeps(sdk);
      state = { deps, lifecycle: createLifecycle(deps, deps.logger) };
      states.set(sdk, state);
    }
    return state;
  };
  return {
    id: "assistant",
    requires: ["models"],
    router: appRouter,
    routes: assistantRoutes((sdk) => ready(sdk).deps),
    rateLimits: assistantRateLimits,
    init: (sdk) => ({ api: assistantApi(ready(sdk).deps) }),
    start: async (sdk) => {
      await ready(sdk).lifecycle.start();
    },
    stop: async (sdk) => {
      await ready(sdk).lifecycle.stop();
    },
  };
}

/** The production `AppDeps`, over the core context. Throws on a misconfigured MCP server. */
function assistantDeps(sdk: BotSdkContext, options: AssistantOptions): AppDeps {
  checkMcpServers(options.mcpServers ?? [], sdk.fetchAllowHosts);
  const resolved = Object.fromEntries(
    Object.keys(defaultRateLimits).map((rule) => [rule, sdk.rateLimits[rule] ?? false]),
  ) as ResolvedRateLimits;
  const deps = createAppDeps({
    db: sdk.db,
    plugin: sdk.plugin,
    blobStore: sdk.blobStore,
    isUserBlocked: sdk.isUserBlocked,
    keyEncryptionSecrets: sdk.keyring,
    runtime: sdk.runtime,
    rateLimits: resolved,
    tools: options.tools ?? [],
    fetchAllowHosts: sdk.fetchAllowHosts,
    mcpServers: options.mcpServers ?? [],
    logger: sdk.logger,
    artifacts: options.artifacts,
    jobs: options.jobs,
    memory: options.memory,
  });
  // The core's emitter, fetch and clock; `stopping` is the core's flag, `runs` the assistant's.
  const runs: AppDeps["lifecycle"]["runs"] = new Map();
  return Object.assign(deps, {
    hooks: sdk.events,
    fetch: sdk.fetch,
    clock: sdk.clock,
    lifecycle: {
      get stopping() {
        return sdk.lifecycle.stopping;
      },
      set stopping(stopping: boolean) {
        sdk.lifecycle.stopping = stopping;
      },
      runs,
    },
  });
}

function assistantApi(deps: AppDeps): AssistantApi {
  return {
    deps,
    getSharedConversation: async (token) => (await loadSharedConversation(deps, token)) ?? null,
    runJob: (name, payload) => runRegisteredJob(name, payload, deps),
    deleteUser: (userId) => deleteUserData(deps, userId),
    exportUser: (userId) => exportUserData(deps, userId),
    admin: {
      stopRuns: async (userId) => {
        // As Stop does, each ended Run fires `onRunEnd` (#265).
        for (const run of await stopUserRuns(deps, userId)) deps.hooks.fire("onRunEnd", run);
      },
      ratingTotals: (range) => ratingTotals(deps, range),
    },
  };
}
/** The assistant's non-RPC routes, under `basePath`. */
function assistantRoutes(getDeps: (sdk: BotSdkContext) => AppDeps): Route[] {
  return [
    {
      // A Generated image on a Shared link is public: the link's token is the only key (ADR 0004).
      method: "GET",
      path: "/shared/:token/generated-images/:id",
      public: true,
      handle: async (request, { sdk, params }) =>
        sharedGeneratedImageResponse(
          getDeps(sdk),
          params.token!,
          params.id!,
          wantsDownload(request),
        ),
    },
    {
      method: "POST",
      path: "/run",
      handle: async (request, { user, sdk }) => {
        const deps = getDeps(sdk);
        return deps.lifecycle.stopping ? shuttingDown() : handleChat(request, user, deps);
      },
    },
    {
      method: "GET",
      path: "/run",
      handle: (request, { user, sdk }) => handleJoin(request, user, getDeps(sdk)),
    },
    {
      method: "GET",
      path: "/events",
      handle: (request, { user, sdk }) => handleConversationEvents(request, user, getDeps(sdk)),
    },
    {
      method: "GET",
      path: "/export",
      handle: async (_request, { user, sdk }) => exportResponse(getDeps(sdk), user.id),
    },
    {
      method: "GET",
      path: "/generated-images/:id",
      handle: async (request, { user, sdk, params }) =>
        generatedImageResponse(getDeps(sdk), user.id, params.id!, wantsDownload(request)),
    },
    ...(["connect", "callback"] as const).map((step): Route => ({
      method: "GET",
      path: `/mcp/${step}`,
      handle: (request, { user, sdk, basePath }) => {
        const redirectUri = `${new URL(request.url).origin}${basePath}/mcp/callback`;
        const route = step === "connect" ? connectRoute : callbackRoute;
        return route(request, user.id, getDeps(sdk), redirectUri);
      },
    })),
  ];
}

const wantsDownload = (request: Request) =>
  new URL(request.url).searchParams.get("download") === "1";

/** The user's export as a JSON download; the file is named by the date the export was taken. */
async function exportResponse(deps: AppDeps, userId: string) {
  const document = await exportUserData(deps, userId);
  const date = document.exportedAt.toISOString().slice(0, 10);
  return Response.json(document, {
    headers: { "Content-Disposition": `attachment; filename="chat-export-${date}.json"` },
  });
}

/**
 * One of the user's Generated images, its bytes straight from the blob store (spec #278). Another
 * user's image, an unknown id or an id that isn't one is 404. The bytes never change, so they are
 * cached for good; `?download=1` names the file for saving.
 */
async function generatedImageResponse(
  deps: AppDeps,
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
  deps: AppDeps,
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

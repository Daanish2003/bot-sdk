import type { AnyServerTool, AnyTextAdapter, ChatMiddleware, ModelMessage } from "@tanstack/ai";

import { storedParts, type StoredParts } from "../../shared/message-parts";
import { attachmentsForSend } from "../attachments/send";
import { tavilyService } from "../../shared/credentials/services";
import type { ErrorCode } from "../../shared/i18n";
import type { ConversationTools } from "../../shared/chat/conversation-tools";
import type { AspectRatio } from "../../shared/chat/generated-image";
import { parseStoredParts, type StoredAttachment, toModelMessages } from "../../shared/chat/parts";
import { type CuratedModel, effortFor, type ReasoningChoice } from "../../shared/chat/models";
import { resolveModelCall, resolveToolCall, type ToolCall } from "../credentials/resolve";
import { unusableModelCode, type ErrorParams } from "../rpc-error";
import type { AppDeps } from "../deps";
import type { conversation } from "../db/schema";
import { pastChatsOffered } from "../search/past-chats";
import { mcpToolsFor, type McpTools } from "../mcp/tools";
import { projectInstructionsOf } from "../project/store";
import { loadSettings } from "../settings/store";
import { recalledMemoriesPrompt } from "../memory/recall";
import { knowledgeSearchFor } from "../knowledge/search";
import { resolveModel } from "./available-models";
import { resolveImageModelFor, type ResolvedImageModel } from "./image-models";
import { imageRequestFor } from "./adapters";
import { editSourcesOf } from "./edit-sources";
import type { ResolvedEmbeddingModel } from "./embedding-models";
import { allowTools, trackTools, type HostToolContext } from "./host-tools";
import type { RunToolState } from "./tracked-tool";
import { systemPromptsFor } from "./system-prompts";
import { artifactContextPrompts } from "./artifact-context";
import { quotaExceededCode } from "./quota";
import { generationOptionsFor } from "./generation";
import { compactionFor, contextBudgetOf, estimateModelMessageTokens } from "./compaction";
import type { ModelMeter } from "./meter";
import { createArtifactTool, updateArtifactTool } from "./artifact-tool";
import { createWebSearchTool } from "./web-search-tool";
import { createSearchPastChatsTool } from "./past-chats-tool";
import { createFetchUrlTool } from "./fetch-url-tool";
import { createKnowledgeSearchTool } from "./knowledge-search-tool";
import { createGenerateImageTool } from "./generate-image-tool";
import { loadPath } from "./store";
import { type RunOf, startRun } from "./run";

/** What a Run is planned for. A send writes a new reply; a resume continues a waiting one (ADR 0008). */
export type RunPlanInput = {
  userId: string;
  conversation: typeof conversation.$inferSelect;
  /** The `"provider:model"` id the Run asks for. */
  model: string;
  /** The reasoning effort asked for; the plan keeps it only when the Model offers it. */
  reasoningEffort: ReasoningChoice | null;
  /** The Conversation's MCP Connections and allowances the Run offers (spec #91, #159). */
  toolSettings: ConversationTools;
  /** Whether the Web tools were asked for. */
  web: boolean;
  /** The reply the Run writes. */
  replyId: string;
  /** The last Message of the path the Run reads: a send's parent, or the waiting reply on a resume. */
  leafId: string | null;
  /**
   * Set on a send (a new Message, an edit or a regenerate): the new Message's text (none on a
   * regenerate), the id it is written with, and its Attachments. Absent on a resume.
   */
  send?: { text: string | undefined; userMessageId: string; attachmentIds: string[] };
};

/**
 * The tools a Run offers, decided once: the tools themselves, the replay flags of
 * `toModelMessages` and the system prompts are all derived from it.
 */
export type Offered = {
  /** The Tavily Tool credential and its meter, when the Run offers `web_search`. */
  webSearch: ToolCall | null;
  /** Whether the Run offers `fetch_url`, which needs no credential. */
  fetchUrl: boolean;
  /** Set when the Run offers `search_past_chats`: the Project that sets its scope (spec #263). */
  pastChats: { projectId: string | null } | null;
  /** Set when the Run offers `search_knowledge`: the Project, its embedding Model and ready files (spec #357). */
  knowledge: { projectId: string; model: ResolvedEmbeddingModel; fileNames: string[] } | null;
  /** Set when the Run offers `generate_image` (spec #278). */
  image: ImageTool | null;
  /** Whether the Run offers `create_artifact` and `update_artifact` (ADR 0016). */
  artifacts: boolean;
  /** The Host tools the Run offers, with the Conversation's allowances lifted (#159). */
  hostTools: AnyServerTool[];
  /** The MCP tools the Run offers, opened by the plan (spec #91). */
  mcp: McpTools | undefined;
};

type ImageTool = {
  adapter: NonNullable<ReturnType<AppDeps["imageAdapterFor"]>>;
  meter: ResolvedImageModel["meter"];
  model: string;
  request: (aspectRatio: AspectRatio) => ReturnType<typeof imageRequestFor>;
  /** The Image Model's input-image limit, and the path's images an edit may read (spec #278). */
  edit: { maxInputImages: number; sources: ReturnType<typeof editSourcesOf> };
};

/** Everything a Run needs before it starts, the same for a send and a resume. */
export type RunPlan = {
  replyId: string;
  model: CuratedModel;
  /** The user and Conversation the Run is for: the Host tools' context. */
  context: HostToolContext;
  /** The reasoning effort the Run sends and the reply records. */
  effort: ReasoningChoice | undefined;
  offered: Offered;
  adapter: AnyTextAdapter;
  messages: ModelMessage[];
  systemPrompts: string[];
  /** The Provider's options for the Run (max output, reasoning). */
  modelOptions: Record<string, unknown> | undefined;
  /** Set for a Model with a known window: drops the oldest Messages past it (`compactionFor`). */
  compaction?: { middleware: ChatMiddleware; contextStartId: () => string | null };
  /** The Model call's meter: on Host credentials it records the Run in `chat.usage` (ADR 0007). */
  meter: ModelMeter;
  /** A send's new user Message: its parts (none on a regenerate) and its Attachments. */
  added: { parts: StoredParts | undefined; attachments: StoredAttachment[] };
  /** The tools of one Run of the plan (`toolsOf`), each writing its calls to that Run's parts. */
  tools: (state: RunToolState) => AnyServerTool[];
};

/** Why a Run could not be planned: an HTTP status, and the dictionary code and its params. */
export type PlanRefusal = {
  status: number;
  code: ErrorCode | typeof quotaExceededCode;
  params: ErrorParams;
};

/** Starts the planned Run (`startRun`), which owns the plan's MCP clients from then on. */
export type StartPlanned = (run?: RunOf) => Promise<void>;

/**
 * Plans a Run (ADR 0002, 0008): resolves its Model and payer, checks the Quota, loads its path,
 * decides once which tools it offers, and builds its messages, system prompts and compaction. A
 * send and a resume get the same plan for the same Conversation and Model.
 *
 * `use` gets the plan and `start`, which hands it to the Run. The MCP clients the plan opened are
 * closed here whenever `use` doesn't start the Run: a refusal while planning, one `use` returns, or
 * a throw. Answers the refusal, or what `use` returned.
 */
export async function planRun<T>(
  deps: AppDeps,
  input: RunPlanInput,
  use: (plan: RunPlan, start: StartPlanned) => Promise<T>,
): Promise<{ refused: PlanRefusal } | { done: T }> {
  const opened: { mcp?: McpTools } = {};
  let started = false;
  try {
    const planned = await buildPlan(deps, input, opened);
    if ("refused" in planned) return planned;
    const start: StartPlanned = async (run = {}) => {
      started = true;
      await startRun(deps, planned.plan, run);
    };
    return { done: await use(planned.plan, start) };
  } finally {
    if (!started) await opened.mcp?.close();
  }
}

const refusal = (status: number, code: PlanRefusal["code"], params: ErrorParams = {}) => ({
  refused: { status, code, params },
});

async function buildPlan(
  deps: AppDeps,
  input: RunPlanInput,
  opened: { mcp?: McpTools },
): Promise<{ refused: PlanRefusal } | { plan: RunPlan }> {
  const { userId, conversation: owned, send } = input;
  const model = await resolveModel(deps, userId, input.model);
  if (!model) return refusal(400, "error.modelNotAvailable", { model: input.model });
  const call = await resolveModelCall(deps, userId, model.id);
  if (!call) {
    const unusable = unusableModelCode(model.provider, deps.byok);
    return refusal(400, unusable.code, unusable.params);
  }
  // A Run on Host credentials is refused once its Quota's window has spent the budget (ADR 0007).
  // The Quota banner explains it, so the body carries only the code and the reset time.
  const quota = await call.meter.mayRun();
  if (!quota.ok) {
    return refusal(402, quotaExceededCode, { resetsAt: quota.resetsAt.toISOString() });
  }

  const history = await loadPath(deps, owned.id, input.leafId);
  if (input.leafId && history.length === 0) return refusal(400, "error.parentNotFound");
  if (send) {
    // A regenerate (no text) answers its parent again, so the parent must be the user's Message.
    if (send.text === undefined && history.at(-1)?.role !== "user") {
      return refusal(400, "error.regenerateNeedsMessage");
    }
    // A reply waiting for Approval can't be continued past its call; an edit or regenerate beside it
    // starts a new Branch and stays allowed (ADR 0008). A hidden reply lost its call, so it waits for nothing (#268).
    const last = history.at(-1);
    if (last?.status === "awaiting_approval" && last.hiddenAt === null) {
      return refusal(409, "error.approveFirst");
    }
  }
  const attachments = await attachmentsForSend(deps, {
    userId,
    model,
    attachmentIds: send?.attachmentIds ?? [],
    history,
  });
  if (attachments.error) {
    return refusal(attachments.error.status, attachments.error.code, attachments.error.params);
  }

  const offered = await offeredFor(deps, input, model, opened, {
    pathMessageIds: history.map((row) => row.id),
    pathAttachments: [
      ...history.flatMap((row) => attachments.ofHistory(row)),
      ...attachments.added,
    ],
  });

  const addedParts =
    send?.text === undefined ? undefined : storedParts([{ type: "text", text: send.text }]);
  // Each stored Message with the model messages it sends, so a cut maps back to its Message (#122).
  const replay = replayFlagsOf(offered);
  const sent = [
    ...history.map((row) => ({
      id: row.id,
      stored: {
        role: row.role,
        parts: parseStoredParts(row.parts),
        model: row.model,
        attachments: attachments.ofHistory(row),
      },
    })),
    ...(addedParts && send
      ? [
          {
            id: send.userMessageId,
            stored: { role: "user" as const, parts: addedParts, attachments: attachments.added },
          },
        ]
      : []),
  ].map(({ id, stored }) => ({
    id,
    messages: toModelMessages([stored], {
      provider: model.provider,
      ...replay,
      reads: { images: model.images, pdfs: model.pdfs },
    }),
  }));
  const budget = contextBudgetOf({
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
  });
  // A new Message too big for the window on its own can't be sent, so it is refused before anything is written.
  const newMessages = addedParts ? (sent.at(-1)?.messages ?? []) : [];
  if (
    budget !== null &&
    newMessages.reduce((total, message) => total + estimateModelMessageTokens(message), 0) > budget
  ) {
    return refusal(400, "error.messageTooLong");
  }

  // Read now, so a Run keeps the Instructions it started with; a regenerate or edit reads them anew.
  const { instructions } = await loadSettings(deps, userId);
  const effort = effortFor(model, input.reasoningEffort);
  const owners = sent.flatMap((entry) => entry.messages.map(() => entry.id));
  const plan: RunPlan = {
    replyId: input.replyId,
    model,
    context: { userId, conversationId: owned.id },
    effort,
    offered,
    adapter: deps.adapterFor(model.id, call.credentials, {
      maxOutputTokens: call.maxOutputTokens,
    }),
    messages: sent.flatMap((entry) => entry.messages),
    systemPrompts: [
      ...systemPromptsFor({
        web: offered.fetchUrl,
        instructions,
        // The Project's Instructions are read from the Conversation's Project at the same moment (spec 5).
        projectInstructions: await projectInstructionsOf(deps, owned.projectId),
        knowledgeFiles: offered.knowledge?.fileNames ?? null,
        // The Memories recalled for this Run, found by the Message it answers (ADR 0013).
        memories: await recalledMemoriesPrompt(deps, {
          userId,
          projectId: owned.projectId,
          temporary: owned.temporary,
          latestText:
            send?.text ?? history.filter((row) => row.role === "user").at(-1)?.searchText ?? null,
        }),
      }),
      // The latest version of each Artifact on the path comes after the system prompts (ADR 0016).
      ...(offered.artifacts ? await artifactContextPrompts(deps, owned.id, input.leafId) : []),
    ],
    modelOptions: generationOptionsFor(model.id, {
      maxOutputTokens: model.maxOutputTokens,
      effort,
    }),
    // Only a Model with a known window is compacted; the others send every Message, as before.
    ...(budget !== null && {
      compaction: compactionFor({ budget, owners, reply: input.replyId }),
    }),
    meter: call.meter,
    added: { parts: addedParts, attachments: attachments.added },
    tools: (state) => toolsOf(deps, plan, state),
  };
  return { plan };
}

/** Decides which tools the Run offers. Every tool needs a Model with tools. */
async function offeredFor(
  deps: AppDeps,
  { userId, conversation: owned, web: webAsked, toolSettings }: RunPlanInput,
  model: CuratedModel,
  opened: { mcp?: McpTools },
  path: { pathMessageIds: string[]; pathAttachments: StoredAttachment[] },
): Promise<Offered> {
  if (!model.tools) {
    return {
      webSearch: null,
      fetchUrl: false,
      pastChats: null,
      knowledge: null,
      image: null,
      artifacts: false,
      hostTools: [],
      mcp: undefined,
    };
  }
  // The Web tools are offered only when asked for. `web_search` also needs a usable Tavily key: the
  // user's own, else the Host's (ADR 0007). `fetch_url` needs none.
  const webSearch = webAsked ? await resolveToolCall(deps, userId, tavilyService) : null;
  // The past-chats search is offered while Memory is on for the Host and the user and the
  // Conversation is not Temporary (spec #263).
  const pastChats = (await pastChatsOffered(deps, userId, owned.temporary))
    ? { projectId: owned.projectId }
    : null;
  // The Knowledge search is offered in a Project with ready Knowledge files and a working credential
  // for its embedding Model (spec #357). A Temporary Conversation has no Project.
  const knowledgeFound =
    owned.projectId && !owned.temporary
      ? await knowledgeSearchFor(deps, userId, owned.projectId)
      : null;
  const knowledge =
    knowledgeFound && owned.projectId ? { projectId: owned.projectId, ...knowledgeFound } : null;
  // The MCP tools are opened before the history is built: a finished call of a tool not offered is
  // sent as text (spec #91). The plan closes them unless the Run takes them.
  opened.mcp = await mcpToolsFor(deps, userId, toolSettings);
  return {
    webSearch,
    fetchUrl: webAsked,
    pastChats,
    knowledge,
    image: await imageToolFor(deps, userId, path),
    // The Artifact tools are offered only when the Host turned them on (ADR 0016).
    artifacts: deps.artifacts,
    // The Host's tools (`createBotSdk({ tools })`). A tool the Conversation allows runs without Approval (#159).
    hostTools: allowTools(deps.tools, toolSettings.allowedTools),
    mcp: opened.mcp,
  };
}

/**
 * The image tool, when the user has a usable Image Model (their pick, else the Host's default) and
 * an adapter serves it (spec #278). A Provider with no image adapter throws from the factory; that
 * Run chats with no image tool rather than failing.
 */
async function imageToolFor(
  deps: AppDeps,
  userId: string,
  {
    pathMessageIds,
    pathAttachments,
  }: { pathMessageIds: string[]; pathAttachments: StoredAttachment[] },
): Promise<ImageTool | null> {
  const image = await resolveImageModelFor(deps, userId);
  if (!image) return null;
  let adapter: ReturnType<AppDeps["imageAdapterFor"]>;
  try {
    adapter = deps.imageAdapterFor(image.id, image.credentials);
  } catch {
    adapter = undefined;
  }
  if (!adapter) return null;
  return {
    adapter,
    request: (aspectRatio) => imageRequestFor(image.id, aspectRatio, image.hostModel),
    // The images an edit may name: the image Attachments and Generated images on this Branch.
    edit: {
      maxInputImages: image.maxInputImages,
      sources: editSourcesOf(deps, { userId, pathMessageIds, attachments: pathAttachments }),
    },
    meter: image.meter,
    model: image.id,
  };
}

/** Which stored calls replay as calls rather than placeholders: those whose tool the Run offers. */
function replayFlagsOf(offered: Offered) {
  return {
    webSearch: offered.webSearch !== null,
    fetchUrl: offered.fetchUrl,
    generateImage: offered.image !== null,
    knowledgeSearch: offered.knowledge !== null,
    hostTools: offered.hostTools.length > 0,
    mcpTools: (offered.mcp?.tools.length ?? 0) > 0,
    artifacts: offered.artifacts,
  };
}

/**
 * The tools of one Run of the plan, each writing its calls to the Run's parts (ADR 0008). This is
 * the one place a Run's tools are built.
 */
function toolsOf(deps: AppDeps, plan: RunPlan, run: RunToolState): AnyServerTool[] {
  const { offered, context, replyId: messageId } = plan;
  return [
    ...(offered.webSearch
      ? [
          createWebSearchTool({
            searchClient: deps.searchClient,
            credentials: offered.webSearch.credentials,
            meter: offered.webSearch.meter,
            ...run,
          }),
        ]
      : []),
    ...(offered.pastChats
      ? [
          createSearchPastChatsTool({
            deps,
            userId: context.userId,
            conversationId: context.conversationId,
            projectId: offered.pastChats.projectId,
            ...run,
          }),
        ]
      : []),
    ...(offered.fetchUrl
      ? [
          createFetchUrlTool({
            fetch: deps.fetch,
            timeoutMs: deps.limits.fetchTimeoutMs,
            ...run,
          }),
        ]
      : []),
    ...(offered.knowledge
      ? [
          createKnowledgeSearchTool({
            deps,
            projectId: offered.knowledge.projectId,
            model: offered.knowledge.model,
            ...run,
          }),
        ]
      : []),
    ...(offered.image
      ? [
          createGenerateImageTool({
            adapter: offered.image.adapter,
            meter: offered.image.meter,
            userId: context.userId,
            model: offered.image.model,
            request: offered.image.request,
            edit: offered.image.edit,
            messageId,
            deps,
            fetch: deps.fetch,
            timeoutMs: deps.limits.imageTimeoutMs,
            ...run,
          }),
        ]
      : []),
    ...(offered.artifacts
      ? [
          createArtifactTool({
            deps,
            messageId,
            conversationId: context.conversationId,
            ...run,
          }),
          updateArtifactTool({
            deps,
            messageId,
            conversationId: context.conversationId,
            ...run,
          }),
        ]
      : []),
    ...trackTools(offered.hostTools, { source: "host", ...run }),
    ...trackTools(offered.mcp?.tools ?? [], { source: "mcp", ...run }),
  ];
}

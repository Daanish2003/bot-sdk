import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import type { AppDeps } from "../deps";
import { searchPassages } from "../knowledge/search";
import type { createPartsBuilder } from "../../shared/chat/parts";
import {
  type KnowledgeSearchOutput,
  knowledgeErrorCodes,
  knowledgeOutput,
  knowledgeUnavailableError,
  maxExcerptsPerSearch,
  searchKnowledgeToolName,
} from "../../shared/chat/knowledge-search";
import type { ResolvedEmbeddingModel } from "./embedding-models";
import { type ToolBudget, toolCallLimitError } from "./host-tools";

const knowledgeDefinition = toolDefinition({
  name: searchKnowledgeToolName,
  description:
    "Search the Project's Knowledge files for passages about a question. Finds passages by meaning " +
    "and by exact words (names, codes, numbers). Returns up to " +
    `${maxExcerptsPerSearch} passages, best first, each with its file name and an id (excerpt:<n>). ` +
    "Use it when the question may be answered from those files.",
  inputSchema: z.object({
    query: z.string().min(1).meta({ description: "What to look for in the Knowledge files" }),
  }),
});

/**
 * The `search_knowledge` server tool for one Run (spec #357, ticket #206). Each call searches the
 * Project's ready Knowledge files and records the call in the reply's `parts` as a
 * `knowledge_search`, calling `onChange` when they change. It takes a call from the reply's shared
 * budget. The embedding Model's meter checks the Quota before the query is embedded: when it refuses
 * (on Host credentials), the search is stored as failed and not run. A failure is the call's error
 * state and a result of "Knowledge unavailable", so the reply continues. A call cut off by the run
 * ending (its signal aborts) stays running; the run closes it as cancelled.
 */
export function createKnowledgeSearchTool({
  deps,
  projectId,
  model,
  parts,
  onChange,
  budget,
}: {
  deps: Pick<AppDeps, "db" | "embeddingAdapterFor">;
  projectId: string;
  model: ResolvedEmbeddingModel;
  parts: ReturnType<typeof createPartsBuilder>;
  onChange: () => void;
  budget: ToolBudget;
}) {
  return knowledgeDefinition.server(async ({ query }, context): Promise<KnowledgeSearchOutput> => {
    // TanStack AI passes the call's id to every server tool; the stored part is keyed by it.
    const toolCallId = context?.toolCallId;
    if (!toolCallId) throw new Error("search_knowledge was called without a tool call id");
    parts.startKnowledgeSearch(toolCallId, query);
    // The labels continue from the reply's earlier Excerpts (the running search has none yet).
    const excerptOffset = parts.excerptCount();
    onChange();
    try {
      if (!budget.take()) {
        parts.finishKnowledgeSearch(toolCallId, { error: { code: "chat.toolError.limit" } });
        return { error: toolCallLimitError };
      }
      if (!(await model.meter.mayRun()).ok) {
        parts.finishKnowledgeSearch(toolCallId, {
          error: { code: knowledgeErrorCodes.quota_exceeded },
        });
        return { error: knowledgeUnavailableError };
      }
      const excerpts = await searchPassages(deps, { projectId, model, query });
      parts.finishKnowledgeSearch(toolCallId, { excerpts });
      return knowledgeOutput(excerpts, excerptOffset);
    } catch (caught) {
      if (context?.abortSignal?.aborted) throw caught;
      parts.finishKnowledgeSearch(toolCallId, { error: { code: knowledgeErrorCodes.failed } });
      return { error: knowledgeUnavailableError };
    } finally {
      onChange();
    }
  });
}

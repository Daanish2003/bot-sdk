import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import type { AppDeps } from "../deps";
import { searchPassages } from "../knowledge/search";
import {
  type KnowledgeSearchOutput,
  knowledgeErrorCodes,
  knowledgeOutput,
  knowledgeUnavailableError,
  maxExcerptsPerSearch,
  searchKnowledgeToolName,
} from "../../shared/chat/knowledge-search";
import type { ResolvedEmbeddingModel } from "../../../plugins/models/server/embedding-models";
import { type RunToolState, toolCallLimitError, trackedTool } from "./tracked-tool";

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
 * `knowledge_search` (`trackedTool`). It takes a call from the reply's shared budget. The embedding
 * Model's meter checks the Quota before the query is embedded: when it refuses (on Host
 * credentials), the search is stored as failed and not run. A failure is the call's error state and
 * a result of "Knowledge unavailable", so the reply continues.
 */
export function createKnowledgeSearchTool({
  deps,
  projectId,
  model,
  ...run
}: RunToolState & {
  deps: Pick<AppDeps, "db" | "plugin">;
  projectId: string;
  model: ResolvedEmbeddingModel;
}) {
  const { parts } = run;
  return knowledgeDefinition.server(
    trackedTool(
      searchKnowledgeToolName,
      run,
      {
        meter: model.meter,
        part: {
          start: (toolCallId, { query }: { query: string }) => {
            parts.startKnowledgeSearch(toolCallId, query);
            // The labels continue from the reply's earlier Excerpts (the running search has none yet).
            return parts.excerptCount();
          },
          refused: (toolCallId, why): KnowledgeSearchOutput => {
            if (why === "limit") {
              parts.finishKnowledgeSearch(toolCallId, { error: { code: "chat.toolError.limit" } });
              return { error: toolCallLimitError };
            }
            parts.finishKnowledgeSearch(toolCallId, {
              error: { code: knowledgeErrorCodes.quota_exceeded },
            });
            return { error: knowledgeUnavailableError };
          },
          failed: (toolCallId): KnowledgeSearchOutput => {
            parts.finishKnowledgeSearch(toolCallId, {
              error: { code: knowledgeErrorCodes.failed },
            });
            return { error: knowledgeUnavailableError };
          },
        },
      },
      async ({ query }, { toolCallId, started: excerptOffset }): Promise<KnowledgeSearchOutput> => {
        const excerpts = await searchPassages(deps, { projectId, model, query });
        parts.finishKnowledgeSearch(toolCallId, { excerpts });
        return knowledgeOutput(excerpts, excerptOffset);
      },
    ),
  );
}

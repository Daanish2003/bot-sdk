import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import {
  artifactKinds,
  createArtifactToolName,
  maxArtifactContent,
} from "../../shared/chat/artifact";
import type { createPartsBuilder } from "../../shared/chat/parts";
import { createArtifact, deleteArtifact } from "../artifact/store";
import type { AppDeps } from "../deps";
import { toolCallLimitError, type ToolBudget } from "./host-tools";

const createArtifactDefinition = toolDefinition({
  name: createArtifactToolName,
  description:
    "Create an Artifact: a substantial piece of content the user will keep working on, such as a " +
    "page, a script, a document, an SVG or a diagram. Use it instead of a long code block in the " +
    "reply. Returns the artifactId and version 1.",
  inputSchema: z.object({
    kind: z.enum(artifactKinds).meta({
      description:
        "code for source code, markdown for documents, html for a web page, svg for a graphic, " +
        "mermaid for a diagram",
    }),
    title: z.string().min(1).max(200).meta({ description: "A short title for the Artifact" }),
    language: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .meta({ description: "The programming language, for a code Artifact (e.g. python)" }),
    content: z
      .string()
      .max(maxArtifactContent)
      .meta({ description: "The full content of the Artifact" }),
  }),
});

/**
 * The `create_artifact` tool for one Run. A saved Artifact is stored with its version 1 in one
 * transaction (ADR 0016) and recorded in the reply's `parts` as a slim `artifact` part. It counts
 * against the reply's tool budget. A call the Run's signal cuts off, or whose write fails, saves
 * nothing: the Run ends (or the call gets the failure as its error result), and the reply continues.
 * An argument the schema refuses (an unknown kind, content over the cap) is an error result from
 * TanStack AI itself, before this runs.
 */
export function createArtifactTool({
  deps,
  messageId,
  conversationId,
  parts,
  onChange,
  budget,
}: {
  deps: Pick<AppDeps, "db">;
  messageId: string;
  conversationId: string;
  parts: ReturnType<typeof createPartsBuilder>;
  onChange: () => void;
  budget: ToolBudget;
}) {
  return createArtifactDefinition.server(async (input, context) => {
    if (!budget.take()) return { error: toolCallLimitError };
    const signal = context?.abortSignal;
    try {
      if (signal?.aborted) throw new Error("The reply was stopped");
      const language = input.kind === "code" ? (input.language ?? null) : null;
      const artifactId = await createArtifact(deps, {
        conversationId,
        messageId,
        kind: input.kind,
        title: input.title,
        language,
        content: input.content,
        createdAt: new Date(),
      });
      if (signal?.aborted) {
        // A Stop that landed while the version was written takes it back: a cut call saves nothing.
        await deleteArtifact(deps, artifactId);
        throw new Error("The reply was stopped");
      }
      parts.addArtifact({ artifactId, version: 1, title: input.title, kind: input.kind });
      onChange();
      return { artifactId, version: 1 };
    } catch (caught) {
      if (signal?.aborted) throw caught;
      return { error: caught instanceof Error ? caught.message : String(caught) };
    }
  });
}

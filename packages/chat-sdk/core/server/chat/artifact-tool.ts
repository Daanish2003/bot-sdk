import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import {
  artifactKinds,
  createArtifactToolName,
  maxArtifactContent,
} from "../../shared/chat/artifact";
import type { createPartsBuilder } from "../../shared/chat/parts";
import { createArtifact } from "../artifact/store";
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
 * The `create_artifact` tool for one Run. Like `fetch_url`, it records its call in the reply's
 * `parts` as a `builtin` tool call, with the title and kind but never the content, and calls
 * `onChange` as it changes. A saved Artifact is stored with its version 1 in one transaction
 * (ADR 0016), and the reply also keeps a slim `artifact` part for it. The call counts against the
 * reply's tool budget. A call the Run's signal cuts off stays running (the Run closes it as
 * cancelled) and saves nothing. A write that fails is an error result, and the reply continues.
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
    // TanStack AI passes the call's id to every server tool; the stored part is keyed by it.
    const toolCallId = context?.toolCallId;
    if (!toolCallId) throw new Error("create_artifact was called without a tool call id");
    const { kind, title, content } = input;
    const language = kind === "code" ? (input.language ?? null) : null;
    parts.startToolCall({
      toolCallId,
      name: createArtifactToolName,
      source: "builtin",
      args: { kind, title, ...(language !== null && { language }) },
    });
    onChange();
    const signal = context?.abortSignal;
    try {
      if (!budget.take()) {
        const error = { error: toolCallLimitError };
        parts.finishToolCall(toolCallId, { state: "error", result: error });
        return error;
      }
      if (signal?.aborted) throw new Error("The reply was stopped");
      const artifactId = await createArtifact(
        deps,
        {
          conversationId,
          messageId,
          kind,
          title,
          language,
          content,
          createdAt: new Date(),
        },
        signal,
      );
      const output = { artifactId, version: 1 };
      parts.addArtifact({ artifactId, version: 1, title, kind });
      parts.finishToolCall(toolCallId, { state: "done", result: output });
      return output;
    } catch (caught) {
      if (signal?.aborted) throw caught;
      const error = { error: caught instanceof Error ? caught.message : String(caught) };
      parts.finishToolCall(toolCallId, { state: "error", result: error });
      return error;
    } finally {
      onChange();
    }
  });
}

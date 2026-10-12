import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import {
  artifactKinds,
  createArtifactToolName,
  maxArtifactContent,
  updateArtifactToolName,
} from "../../shared/chat/artifact";
import type { createPartsBuilder } from "../../shared/chat/parts";
import { applyEdits } from "../artifact/edits";
import { createArtifact, updateArtifact } from "../artifact/store";
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

const updateArtifactDefinition = toolDefinition({
  name: updateArtifactToolName,
  description:
    "Change an Artifact made earlier on this Branch of the conversation. Give exactly one of: " +
    "edits (targeted replacements, applied in order: each old text must occur exactly once in the " +
    "text the earlier edits left), " +
    "content (a full rewrite), or restoreVersion (an earlier version of this Artifact, saved again " +
    "as the newest). Each change saves a new version. Returns the artifactId and the new version.",
  inputSchema: z.object({
    artifactId: z.string().min(1).max(64).meta({
      description: "The artifactId that create_artifact returned",
    }),
    title: z.string().min(1).max(200).optional().meta({ description: "A new title, if renamed" }),
    edits: z
      .array(
        z.object({
          old: z.string().min(1).meta({ description: "Text to replace; must occur exactly once" }),
          new: z.string().meta({ description: "The replacement text" }),
        }),
      )
      .min(1)
      .optional()
      .meta({ description: "Targeted replacements, applied in order" }),
    content: z
      .string()
      .max(maxArtifactContent)
      .optional()
      .meta({ description: "The full new content, for a rewrite" }),
    restoreVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .meta({ description: "The number of an earlier version to copy as the new one" }),
  }),
});

/**
 * The `update_artifact` tool for one Run (ADR 0016). It changes the latest version of an Artifact
 * on the Branch the reply sits on, and saves the result as the next version, written by this reply.
 * It is tracked like `create_artifact`: a `builtin` tool call, the slim `artifact` part, the budget,
 * and a cut call saves nothing. A change that doesn't apply (an edit with no or several matches,
 * no or several of edits, content and restoreVersion, an Artifact not on this Branch) is an error
 * result that names the problem and saves nothing.
 */
export function updateArtifactTool({
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
  return updateArtifactDefinition.server(async (input, context) => {
    const toolCallId = context?.toolCallId;
    if (!toolCallId) throw new Error("update_artifact was called without a tool call id");
    const { artifactId, title } = input;
    parts.startToolCall({
      toolCallId,
      name: updateArtifactToolName,
      source: "builtin",
      args: { artifactId, ...(title !== undefined && { title }) },
    });
    onChange();
    const signal = context?.abortSignal;
    try {
      if (!budget.take()) {
        const error = { error: toolCallLimitError };
        parts.finishToolCall(toolCallId, { state: "error", result: error });
        return error;
      }
      const given = [input.edits, input.content, input.restoreVersion].filter(
        (value) => value !== undefined,
      ).length;
      if (given !== 1) {
        const error = { error: "Give exactly one of edits, content or restoreVersion" };
        parts.finishToolCall(toolCallId, { state: "error", result: error });
        return error;
      }
      if (signal?.aborted) throw new Error("The reply was stopped");
      const outcome = await updateArtifact(
        deps,
        {
          conversationId,
          messageId,
          artifactId,
          createdAt: new Date(),
          change: async (latest, versionAt) => {
            let content = latest.content;
            let language = latest.language;
            if (input.edits) {
              const applied = applyEdits(latest.content, input.edits);
              if ("error" in applied) return applied;
              content = applied.content;
            } else if (input.content !== undefined) {
              content = input.content;
            } else {
              const restored = await versionAt(input.restoreVersion!);
              if (!restored) {
                return { error: `Version ${input.restoreVersion} isn't on this Branch` };
              }
              content = restored.content;
              language = restored.language;
            }
            if (content.length > maxArtifactContent) {
              return { error: `The Artifact would be over ${maxArtifactContent / 1024} KB` };
            }
            return { title: title ?? latest.title, language, content };
          },
        },
        signal,
      );
      if (!outcome.saved) {
        const error = { error: outcome.error };
        parts.finishToolCall(toolCallId, { state: "error", result: error });
        return error;
      }
      const output = { artifactId, version: outcome.number };
      parts.addArtifact({
        artifactId,
        version: outcome.number,
        title: outcome.title,
        kind: outcome.kind,
      });
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

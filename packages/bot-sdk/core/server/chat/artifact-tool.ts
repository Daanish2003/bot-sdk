import { type ChatMiddleware, type ModelMessage, toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import {
  artifactKinds,
  createArtifactToolName,
  maxArtifactContent,
  updateArtifactToolName,
} from "../../shared/chat/artifact";
import { applyEdits } from "../artifact/edits";
import { createArtifact, updateArtifact } from "../artifact/store";
import type { AppDeps } from "../deps";
import {
  type CallPart,
  endToolCall,
  type RunToolState,
  toolCallLimitError,
  trackedTool,
} from "./tracked-tool";

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
 * `parts` as a `builtin` tool call (`trackedTool`), with the title and kind but never the
 * content. A saved Artifact is stored with its version 1 in one transaction (ADR 0016), and the
 * reply also keeps a slim `artifact` part for it. The call counts against the
 * reply's tool budget. A call the Run's signal cuts off stays running (the Run closes it as
 * cancelled) and saves nothing. A write that fails is an error result, and the reply continues.
 * An argument the schema refuses (an unknown kind, content over the cap) is an error result from
 * TanStack AI itself, before this runs.
 */
export function createArtifactTool({
  deps,
  messageId,
  conversationId,
  ...run
}: RunToolState & {
  deps: Pick<AppDeps, "db">;
  messageId: string;
  conversationId: string;
}) {
  const { parts } = run;
  type Input = z.infer<typeof createArtifactDefinition.inputSchema>;
  const languageOf = ({ kind, language }: Input) => (kind === "code" ? (language ?? null) : null);
  return createArtifactDefinition.server(
    trackedTool(
      createArtifactToolName,
      run,
      {
        part: artifactCallPart(parts, createArtifactToolName, (input: Input) => {
          const language = languageOf(input);
          return { kind: input.kind, title: input.title, ...(language !== null && { language }) };
        }),
      },
      async (input, { toolCallId, signal }): Promise<ArtifactOutput> => {
        const { kind, title, content } = input;
        if (signal?.aborted) throw new Error("The reply was stopped");
        const artifactId = await createArtifact(
          deps,
          {
            conversationId,
            messageId,
            kind,
            title,
            language: languageOf(input),
            content,
            createdAt: new Date(),
          },
          signal,
        );
        parts.addArtifact({ artifactId, version: 1, title, kind });
        return endToolCall(parts, toolCallId, "done", { artifactId, version: 1 });
      },
    ),
  );
}

/** What the Model reads back for an Artifact call: the version it saved, or why it saved none. */
type ArtifactOutput = { artifactId: string; version: number } | { error: string };

/**
 * The `tool_call` part of an Artifact call: `builtin`, with the arguments `argsOf` keeps (never the
 * content). A call refused or failed ends as an error result the Model reads.
 */
function artifactCallPart<Input>(
  parts: RunToolState["parts"],
  name: string,
  argsOf: (input: Input) => Record<string, unknown>,
): CallPart<Input, ArtifactOutput, void> {
  return {
    start: (toolCallId, input) =>
      parts.startToolCall({ toolCallId, name, source: "builtin", args: argsOf(input) }),
    refused: (toolCallId) => endToolCall(parts, toolCallId, "error", { error: toolCallLimitError }),
    failed: (toolCallId, caught) =>
      endToolCall(parts, toolCallId, "error", {
        error: caught instanceof Error ? caught.message : String(caught),
      }),
  };
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
  ...run
}: RunToolState & {
  deps: Pick<AppDeps, "db">;
  messageId: string;
  conversationId: string;
}) {
  const { parts } = run;
  type Input = z.infer<typeof updateArtifactDefinition.inputSchema>;
  return updateArtifactDefinition.server(
    trackedTool(
      updateArtifactToolName,
      run,
      {
        part: artifactCallPart(parts, updateArtifactToolName, ({ artifactId, title }: Input) => ({
          artifactId,
          ...(title !== undefined && { title }),
        })),
      },
      async (input, { toolCallId, signal }): Promise<ArtifactOutput> => {
        const { artifactId, title } = input;
        const given = [input.edits, input.content, input.restoreVersion].filter(
          (value) => value !== undefined,
        ).length;
        if (given !== 1) {
          return endToolCall(parts, toolCallId, "error", {
            error: "Give exactly one of edits, content or restoreVersion",
          });
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
          return endToolCall(parts, toolCallId, "error", { error: outcome.error });
        }
        parts.addArtifact({
          artifactId,
          version: outcome.number,
          title: outcome.title,
          kind: outcome.kind,
        });
        return endToolCall(parts, toolCallId, "done", { artifactId, version: outcome.number });
      },
    ),
  );
}

/** What the Model reads back for an Artifact call whose arguments were cut off or not valid JSON. */
export const cutOffArtifactResult = {
  error:
    "The arguments were cut off or not valid JSON, so nothing was saved. Call again with the complete arguments.",
};

const artifactToolNames: ReadonlySet<string> = new Set([
  createArtifactToolName,
  updateArtifactToolName,
]);

/** Whether a call's arguments parse the way TanStack AI reads them (an empty string is `{}`). */
function parses(json: string): boolean {
  try {
    JSON.parse(json.trim() || "{}");
    return true;
  } catch {
    return false;
  }
}

/**
 * TanStack AI answers an Artifact call whose arguments don't parse with an error that repeats the
 * raw arguments, which is the partial content of a write cut off at max tokens (ADR 0016). Before
 * each model call, this middleware makes the Model's messages carry the short `cutOffArtifactResult`
 * instead, and empties the call's arguments, so the partial content never reaches the Model.
 */
export const artifactCutOff: ChatMiddleware = {
  name: "artifact-cut-off",
  onConfig(_ctx, config) {
    const cut = new Set<string>();
    for (const message of config.messages) {
      for (const call of message.role === "assistant" ? (message.toolCalls ?? []) : []) {
        if (artifactToolNames.has(call.function.name) && !parses(call.function.arguments)) {
          cut.add(call.id);
        }
      }
    }
    if (cut.size === 0) return;
    const messages = config.messages.map((message): ModelMessage => {
      if (message.role === "assistant" && message.toolCalls?.some((call) => cut.has(call.id))) {
        const toolCalls = message.toolCalls.map((call) =>
          cut.has(call.id) ? { ...call, function: { ...call.function, arguments: "{}" } } : call,
        );
        return { ...message, toolCalls };
      }
      if (
        message.role === "tool" &&
        message.toolCallId !== undefined &&
        cut.has(message.toolCallId)
      ) {
        // TanStack AI also keeps the raw parse failure on the message's `error`, so it is dropped.
        return {
          role: "tool",
          toolCallId: message.toolCallId,
          content: JSON.stringify(cutOffArtifactResult),
        };
      }
      return message;
    });
    return { messages };
  },
};

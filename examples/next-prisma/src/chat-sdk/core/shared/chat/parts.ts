import {
  type ArtifactPart,
  type StoredPart,
  type StoredParts,
  storedParts,
  storedPartsSchema,
  type ToolCallPart,
  type WebSearchPart,
} from "../message-parts";
import {
  type ContentPart,
  EventType,
  type MessagePart,
  type ModelMessage,
  type StreamChunk,
  type ToolCall,
} from "@tanstack/ai";

import { attachmentKind, kindLabel, kindLabelPlural } from "../attachments/kinds";
import { createArtifactToolName, updateArtifactToolName } from "./artifact";
import { fetchUrlToolName } from "./fetch-url";
import { providerOf } from "./models";
import {
  searchErrorMessages,
  type SearchErrorReason,
  type SearchResult,
  type WebSearchOutput,
  webSearchToolName,
} from "./web-search";

/**
 * The one boundary between stored Message parts (our versioned zod shape, ADR 0001) and
 * TanStack AI. A TanStack AI upgrade only needs this module checked.
 */

export type StoredMessage = {
  role: "user" | "assistant";
  parts: StoredParts;
  /** `"provider:model"` of the Model that wrote an assistant Message. */
  model?: string | null;
  /** The files a user Message carries, in order (attachments are never parts, ADR 0001). */
  attachments?: StoredAttachment[];
};

export type StoredAttachment = { filename: string; mediaType: string; bytes: Uint8Array };

/** What the Model reads besides text. */
export type ModelReads = { images: boolean; pdfs: boolean };

/** Validates parts read from the database. Throws on an unknown schema version or part. */
export function parseStoredParts(json: unknown): StoredParts {
  return storedPartsSchema.parse(json);
}

type ThinkingPart = Extract<StoredPart, { type: "thinking" }>;

/**
 * TanStack AI marks a redacted thinking block (Anthropic `redacted_thinking`) by this reasoning
 * message id prefix; it doesn't export the check.
 */
const redactedThinkingIdPrefix = "redacted_thinking-";

/** How a search ended: its results, or why it failed. */
export type SearchOutcome = { results: SearchResult[] } | { errorReason: SearchErrorReason };

/**
 * Collects a run's stream chunks into stored parts. The `web_search` tool records its searches
 * here as it runs them, so they land between the text before and after them. A resumed Run starts
 * from the parts its Message already holds (`initial`), so its reply continues them.
 */
export function createPartsBuilder(initial: StoredPart[] = []) {
  const parts: StoredPart[] = initial.map((part) => ({ ...part }));
  let textMessageId: string | undefined;
  // Tool calls as the model streams them, by id: a call that needs Approval is stored from these.
  const streamedCalls = new Map<string, { name: string; json: string }>();
  // Thinking by reasoning message id: its signature arrives after its text.
  const thinking = new Map<string, ThinkingPart>();
  const thinkingPart = (messageId: string) => {
    let part = thinking.get(messageId);
    if (!part) {
      part = { type: "thinking", text: "" };
      if (messageId.startsWith(redactedThinkingIdPrefix)) part.redacted = true;
      thinking.set(messageId, part);
      parts.push(part);
    }
    return part;
  };
  const runningSearch = (toolCallId: string) =>
    parts.find(
      (part): part is WebSearchPart =>
        part.type === "web_search" && part.toolCallId === toolCallId && part.state === "running",
    );
  const runningCall = (toolCallId: string) =>
    parts.find(
      (part): part is ToolCallPart =>
        part.type === "tool_call" && part.toolCallId === toolCallId && part.state === "running",
    );

  return {
    add(chunk: StreamChunk) {
      if (chunk.type === EventType.TOOL_CALL_START) {
        streamedCalls.set(chunk.toolCallId, { name: chunk.toolCallName, json: "" });
        return;
      }
      if (chunk.type === EventType.TOOL_CALL_ARGS) {
        const call = streamedCalls.get(chunk.toolCallId);
        if (call) call.json += chunk.delta;
        return;
      }
      if (chunk.type === EventType.REASONING_MESSAGE_CONTENT && chunk.delta) {
        thinkingPart(chunk.messageId).text += chunk.delta;
        return;
      }
      if (
        chunk.type === EventType.REASONING_ENCRYPTED_VALUE &&
        chunk.subtype === "message" &&
        chunk.encryptedValue
      ) {
        thinkingPart(chunk.entityId).signature = chunk.encryptedValue;
        return;
      }
      if (chunk.type !== EventType.TEXT_MESSAGE_CONTENT || !chunk.delta) return;
      const last = parts.at(-1);
      if (last?.type === "text" && chunk.messageId === textMessageId) {
        last.text += chunk.delta;
      } else {
        parts.push({ type: "text", text: chunk.delta });
        textMessageId = chunk.messageId;
      }
    },
    startSearch(toolCallId: string, query: string) {
      parts.push({ type: "web_search", toolCallId, query, state: "running", results: [] });
    },
    /** Ends a running search. A search that was cancelled meanwhile stays cancelled. */
    finishSearch(toolCallId: string, outcome: SearchOutcome) {
      const part = runningSearch(toolCallId);
      if (!part) return;
      if ("results" in outcome) {
        part.state = "done";
        part.results = outcome.results;
      } else {
        part.state = "error";
        part.errorReason = outcome.errorReason;
      }
    },
    /**
     * Starts a tool call other than `web_search`, as the tool is about to run. A call a resumed Run
     * already holds (waiting for Approval, now approved) is updated in place.
     */
    startToolCall({ toolCallId, name, source, args }: StartToolCall) {
      const held = parts.find(
        (part): part is ToolCallPart => part.type === "tool_call" && part.toolCallId === toolCallId,
      );
      if (held) Object.assign(held, { name, source, args, state: "running", result: undefined });
      else parts.push({ type: "tool_call", toolCallId, name, source, args, state: "running" });
    },
    /**
     * Stores a call the model asked for that waits for Approval: its name and full arguments, as
     * the model streamed them, with no result. `mcpNames` are the names of the MCP tools offered,
     * which makes the call an `mcp` one; any other is a Host tool.
     */
    awaitApproval(toolCallId: string, mcpNames: ReadonlySet<string> = new Set()) {
      const streamed = streamedCalls.get(toolCallId);
      const args = parseArgs(streamed?.json ?? "");
      const name = streamed?.name ?? "";
      parts.push({
        type: "tool_call",
        toolCallId,
        name,
        source: mcpNames.has(name) ? "mcp" : "host",
        args,
        state: "awaiting_approval",
      });
    },
    /** Records a version a `create_artifact` call saved (ADR 0016). Only saved versions are parts. */
    addArtifact({ artifactId, version, title, kind }: Omit<ArtifactPart, "type" | "state">) {
      parts.push({ type: "artifact", artifactId, version, title, kind, state: "done" });
    },
    /** Ends a running tool call with its result. A call cancelled meanwhile stays cancelled. */
    finishToolCall(toolCallId: string, { state, result }: FinishToolCall) {
      const part = runningCall(toolCallId);
      if (!part) return;
      part.state = state;
      part.result = result;
    },
    cancelRunningCalls() {
      for (const part of parts) {
        if ((part.type === "web_search" || part.type === "tool_call") && part.state === "running") {
          part.state = "cancelled";
        }
      }
    },
    /** A copy of the parts so far. */
    parts(): StoredParts {
      return storedParts(parts.map((part) => ({ ...part })));
    },
  };
}

/** A tool call as it starts: what the Model asked for, before the tool has run. */
export type StartToolCall = Pick<ToolCallPart, "name" | "source" | "args"> & { toolCallId: string };
/** How a tool call ended: `done` with its result, or `error` with `{ error }`. */
export type FinishToolCall = { state: "done" | "error"; result: unknown };

/** The parts with every `running` search and tool call closed as `cancelled`, for a run that ended. */
export function cancelRunningCalls(parts: StoredParts): StoredParts {
  return storedParts(
    parts.parts.map((part) =>
      (part.type === "web_search" || part.type === "tool_call") && part.state === "running"
        ? { ...part, state: "cancelled" }
        : part,
    ),
  );
}

function textOf(parts: StoredParts, separator: string) {
  return parts.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(separator);
}

const finished = (part: WebSearchPart | ToolCallPart) =>
  part.state === "done" || part.state === "error" || part.state === "denied";

/**
 * A `create_artifact` or `update_artifact` call. It is stored as a tool call (for the budget and a
 * failed card) and, once saved, as an `artifact` part. Its stored arguments hold no content or
 * edits, so the Model replays it as a stub (ADR 0016); the content comes with the latest version.
 */
const isArtifactCall = (part: StoredPart) =>
  part.type === "tool_call" &&
  (part.name === createArtifactToolName || part.name === updateArtifactToolName);

/** A finished search or tool call the Model may replay. */
const replayable = (part: StoredPart): part is WebSearchPart | ToolCallPart =>
  (part.type === "web_search" || part.type === "tool_call") && finished(part);

/**
 * What the Model reads back for a finished call. An Artifact call that saved a version reads as a
 * short stub ("saved as v3"); any other call reads its search output or stored result.
 */
function resultOf(part: WebSearchPart | ToolCallPart): unknown {
  if (part.type === "web_search") return searchOutput(part);
  if (isArtifactCall(part) && part.state === "done") {
    const saved = part.result as { version?: unknown } | null;
    return `saved as v${String(saved?.version)}`;
  }
  return part.result ?? null;
}

/** A call's arguments as the model streamed them; an unreadable stream reads as no arguments. */
function parseArgs(json: string): unknown {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}

/** What the Model read as the result of a finished search. */
function searchOutput(part: WebSearchPart): WebSearchOutput {
  if (part.state !== "error") return { results: part.results };
  const reason = part.errorReason ?? "failed";
  return { error: searchErrorMessages[reason], reason };
}

/** A finished search as text, for a request that doesn't offer the `web_search` tool. */
function searchPlaceholder(part: WebSearchPart) {
  const found =
    part.state === "error"
      ? "the search failed"
      : part.results.length === 0
        ? "no results"
        : part.results.map((result) => `${result.title} (${result.url})`).join(", ");
  return `[Searched the web for "${part.query}": ${found}]`;
}

/** A finished tool call as text, for a request that doesn't offer its tool. */
function toolCallPlaceholder(part: ToolCallPart) {
  return `[Called "${part.name}" with ${JSON.stringify(part.args)}: ${JSON.stringify(part.result ?? null)}]`;
}

/** A finished search or tool call as text, for a request that doesn't offer its tool. */
function placeholderOf(part: WebSearchPart | ToolCallPart) {
  return part.type === "web_search" ? searchPlaceholder(part) : toolCallPlaceholder(part);
}

/** The tools a request offers: a finished search or tool call of a kind not offered is text. */
type OfferedTools = {
  webSearch: boolean;
  fetchUrl: boolean;
  hostTools: boolean;
  mcpTools: boolean;
  /** Whether the request offers the Artifact tools (ADR 0016). */
  artifacts: boolean;
};

/** A call a request offers its tool for, as the Model replays it: a Host or an MCP tool, by its source. */
const offeredCall = (part: WebSearchPart | ToolCallPart, offered: OfferedTools) => {
  if (part.type === "web_search") return offered.webSearch;
  if (isArtifactCall(part)) return offered.artifacts;
  if (part.name === fetchUrlToolName) return offered.fetchUrl;
  return part.source === "mcp" ? offered.mcpTools : offered.hostTools;
};

/**
 * A Message as the Model sees it when some tools are offered: finished searches and tool calls
 * of an offered tool as tool calls, the rest as text placeholders. A call without a result
 * (running, cancelled) is an unmatched tool call, and is left out.
 */
function withToolCalls({ role, parts }: StoredMessage, offered: OfferedTools): ModelMessage[] {
  const messages: ModelMessage[] = [];
  let content = "";
  // A placeholder is followed by a paragraph break before any text that comes after it.
  let breakBeforeText = false;
  let calls: (WebSearchPart | ToolCallPart)[] = [];
  const flush = () => {
    if (calls.length > 0) {
      const toolCalls: ToolCall[] = calls.map((call) => ({
        id: call.toolCallId,
        type: "function",
        function:
          call.type === "web_search"
            ? { name: webSearchToolName, arguments: JSON.stringify({ query: call.query }) }
            : { name: call.name, arguments: JSON.stringify(call.args) },
      }));
      messages.push({ role, content: content || null, toolCalls });
      // A call waiting for Approval has no result yet: the resumed Run supplies it (ADR 0008).
      for (const call of calls.filter(finished)) {
        messages.push({
          role: "tool",
          toolCallId: call.toolCallId,
          content: JSON.stringify(resultOf(call)),
        });
      }
    } else if (content) {
      messages.push({ role, content });
    }
    content = "";
    breakBeforeText = false;
    calls = [];
  };

  for (const part of parts.parts) {
    if (part.type === "text") {
      if (calls.length > 0) flush();
      if (breakBeforeText) content += "\n\n";
      breakBeforeText = false;
      content += part.text;
    } else if (part.type === "tool_call" && part.state === "awaiting_approval") {
      // Sent without a result, so the resumed Run can answer it (the Model's call is still open).
      if (offeredCall(part, offered)) calls.push(part);
    } else if (replayable(part)) {
      if (offeredCall(part, offered)) {
        calls.push(part);
      } else if (!isArtifactCall(part)) {
        // An Artifact call whose tools aren't offered is left out, not written as text.
        if (calls.length > 0) flush();
        if (content) content += "\n\n";
        content += placeholderOf(part);
        breakBeforeText = true;
      }
    }
  }
  flush();
  return messages;
}

/** A Message as the Model sees it when no tool is offered: searches and tool calls as text placeholders. */
function withPlaceholders({ role, parts }: StoredMessage): ModelMessage[] {
  const pieces: string[] = [];
  let lastWasText = false;
  for (const part of parts.parts) {
    if (part.type === "text") {
      if (lastWasText) pieces[pieces.length - 1] += part.text;
      else pieces.push(part.text);
      lastWasText = true;
    } else if (replayable(part) && !isArtifactCall(part)) {
      pieces.push(placeholderOf(part));
      lastWasText = false;
    }
  }
  const content = pieces.filter(Boolean).join("\n\n");
  return content ? [{ role, content }] : [];
}

/**
 * Provider history for `provider`, oldest first. Messages without any text are left out.
 * Thinking goes back only to the Provider that wrote it (on the Message's first turn); another
 * Provider can't read it. Stored searches and tool calls replay as tool calls when this request
 * offers their tool (`webSearch`, `fetchUrl`, `hostTools`), else as short text placeholders. Stored
 * history is never rewritten.
 */
export function toModelMessages(
  history: StoredMessage[],
  {
    provider,
    webSearch = false,
    fetchUrl = false,
    hostTools = false,
    mcpTools = false,
    artifacts = false,
    reads = { images: false, pdfs: false },
  }: {
    provider?: string;
    webSearch?: boolean;
    /** Whether this request offers the `fetch_url` tool. */
    fetchUrl?: boolean;
    /** Whether this request offers the Host's tools. */
    hostTools?: boolean;
    /** Whether this request offers any MCP tools (spec #91). */
    mcpTools?: boolean;
    /** Whether this request offers the Artifact tools; their calls then replay as stubs (ADR 0016). */
    artifacts?: boolean;
    /** Attachments the Model can't read become text placeholders. */
    reads?: ModelReads;
  } = {},
): ModelMessage[] {
  return history.flatMap((stored) => {
    const messages =
      webSearch || fetchUrl || hostTools || mcpTools || artifacts
        ? withToolCalls(stored, { webSearch, fetchUrl, hostTools, mcpTools, artifacts })
        : withPlaceholders(stored);
    const [first] = messages;
    if (!first) return [];
    const { parts, model, attachments = [] } = stored;
    // Attachments go before the user's text, in the Message's first (only) model message.
    if (attachments.length > 0 && typeof first.content === "string") {
      messages[0] = {
        ...first,
        content: [
          ...attachments.map((file) => attachmentPart(file, reads)),
          { type: "text", content: first.content },
        ],
      };
    }
    const sameProvider = provider !== undefined && model && providerOf(model) === provider;
    const thinking = sameProvider
      ? parts.parts
          .filter((part) => part.type === "thinking")
          .map(({ text, signature, redacted }) => ({ content: text, signature, redacted }))
      : [];
    if (thinking.length > 0) messages[0] = { ...messages[0]!, thinking };
    return messages;
  });
}

/**
 * An attachment as the Provider gets it: images and PDFs as inline base64 when the Model reads
 * them, text files as fenced text, anything else as a short placeholder.
 */
function attachmentPart(
  { filename, mediaType, bytes }: StoredAttachment,
  reads: ModelReads,
): ContentPart {
  const kind = attachmentKind(mediaType, filename);
  const source = { type: "data" as const, value: toBase64(bytes), mimeType: mediaType };
  if (kind === "image" && reads.images) return { type: "image", source };
  if (kind === "pdf" && reads.pdfs) return { type: "document", source, metadata: { filename } };
  if (kind === "text") {
    const fileText = new TextDecoder().decode(bytes);
    const longestRun = Math.max(0, ...(fileText.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    return { type: "text", content: `${filename}\n${fence}\n${fileText}\n${fence}` };
  }
  const [label, plural] = kind ? [kindLabel(kind), kindLabelPlural(kind)] : ["file", "files"];
  return {
    type: "text",
    content: `[Attached ${label} "${filename}" left out: this Model can't read ${plural}]`,
  };
}

function toBase64(bytes: Uint8Array) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** `UIMessage` parts for `useChat`. A search is a `web_search` tool call, as it streams. */
export function toUIParts(parts: StoredParts): MessagePart[] {
  // A saved Artifact shows as its `artifact` part, so its finished call is not a second card.
  const shown = parts.parts.filter(
    (part) => !(part.type === "tool_call" && isArtifactCall(part) && part.state === "done"),
  );
  return shown.map((part): MessagePart => {
    if (part.type === "text") return { type: "text", content: part.text };
    // The signature is only for the Provider; the client never needs it.
    if (part.type === "thinking") return { type: "thinking", content: part.text };
    if (part.type === "tool_call") return toolCallUIPart(part);
    if (part.type === "artifact") return artifactUIPart(part);
    const input = { query: part.query };
    return {
      type: "tool-call",
      id: part.toolCallId,
      name: webSearchToolName,
      arguments: JSON.stringify(input),
      input,
      // A cancelled search ended without a result.
      state:
        part.state === "running"
          ? "input-complete"
          : part.state === "cancelled"
            ? "error"
            : "complete",
      ...(finished(part) && { output: searchOutput(part) }),
    };
  });
}

/**
 * A stored tool call other than `web_search`, as `useChat` shows it. Its source and stored status
 * ride in `metadata`, so a Shared link can tell which calls to redact and the row can show a cancel.
 */
function toolCallUIPart(part: ToolCallPart): MessagePart {
  return {
    type: "tool-call",
    id: part.toolCallId,
    name: part.name,
    arguments: JSON.stringify(part.args),
    input: part.args,
    state:
      part.state === "running" || part.state === "awaiting_approval"
        ? "input-complete"
        : part.state === "done"
          ? "complete"
          : "error",
    ...(finished(part) && { output: part.result }),
    metadata: { source: part.source, status: part.state },
  };
}

/**
 * A saved Artifact version as `useChat` shows it: a `create_artifact` call with its title and kind
 * (as the call's input) and the version it saved (as its output). The content is never in it.
 */
function artifactUIPart(part: ArtifactPart): MessagePart {
  const input = { kind: part.kind, title: part.title };
  return {
    type: "tool-call",
    id: `artifact-${part.artifactId}-${part.version}`,
    name: createArtifactToolName,
    arguments: JSON.stringify(input),
    input,
    state: "complete",
    output: { artifactId: part.artifactId, version: part.version },
    metadata: { source: "builtin", status: "done" },
  };
}

/** The plain text `message.searchText` holds: the text parts only. */
export function searchTextOf(parts: StoredParts): string {
  return textOf(parts, "\n");
}

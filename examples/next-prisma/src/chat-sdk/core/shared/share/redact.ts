import type { MessagePart } from "@tanstack/ai";

import type { AttachmentInfo } from "../attachments/kinds";
import { toolCallOf } from "../chat/tool-call";
import { webSearchToolName } from "../chat/web-search";

/** The parts a Shared link viewer may see. Anything else (thinking, file contents) is left out. */
const sharedPartTypes = new Set<MessagePart["type"]>(["text", "tool-call", "tool-result"]);

/**
 * A Message's parts as a Shared link shows them (ADR 0004): an allowlist, so a part type added
 * later stays private until it is listed here. Attachments aren't parts; see
 * `redactAttachmentsForShare`. A tool call keeps its arguments and result only for the search and
 * the SDK's own tools (`builtin`); a Host or MCP call shows only that it was used.
 */
export function redactForShare(parts: MessagePart[]): MessagePart[] {
  return parts.filter((part) => sharedPartTypes.has(part.type)).map(redactToolCall);
}

function redactToolCall(part: MessagePart): MessagePart {
  if (part.type !== "tool-call" || part.name === webSearchToolName) return part;
  const call = toolCallOf(part);
  if (!call || call.source === "builtin") return part;
  return {
    type: "tool-call",
    id: part.id,
    name: part.name,
    arguments: "",
    state: part.state,
    metadata: { source: call.source, status: call.status, redacted: true },
  };
}

/**
 * A Message's attachments as a Shared link shows them: filename-and-type chips only. Their bytes
 * are never served publicly (ADR 0004), and the id and size stay private too.
 */
export function redactAttachmentsForShare(attachments: AttachmentInfo[]) {
  return attachments.map(({ filename, mediaType }) => ({ filename, mediaType }));
}

import type { MessagePart } from "@tanstack/ai";

import { attachmentKind } from "../shared/attachments/kinds";
import { type ClientMessage } from "../shared/chat/client-message";
import { findModel, parseModelId } from "../shared/chat/models";
import { citationFor, excerptFor } from "../shared/chat/citations";
import { toolCallOf } from "../shared/chat/tool-call";
import { type Citation, type Source, sourcesOf, webSourcesOf } from "../shared/chat/sources";
import { webSearchOf } from "../shared/chat/web-search";

/**
 * A Conversation's Active Branch as Markdown (spec #248, ticket #252). Pure: the procedure
 * `conversation.exportMarkdown` loads the Branch and this renders it, so the rules live in one place.
 */

/** The parts of a Message the export reads: what `conversation.get` returns for it. */
export type ExportMessage = Pick<
  ClientMessage,
  "role" | "parts" | "attachments" | "model" | "status" | "error" | "errorReason"
>;

const maxFileNameLength = 80;

/** A Markdown document and the file name it downloads as. */
export function renderConversationMarkdown({
  title,
  messages,
  exportedAt,
}: {
  title: string | null;
  messages: ExportMessage[];
  exportedAt: Date;
}): { fileName: string; markdown: string } {
  const heading = title?.trim() || "Untitled Conversation";
  const blocks = [
    `# ${heading}\n\nExported ${exportedAt.toISOString().slice(0, 10)}`,
    ...messages.map(renderMessage),
  ];
  return {
    fileName: exportFileName(title),
    markdown: `${blocks.join("\n\n---\n\n")}\n`,
  };
}

/** The title made filesystem-safe (letters, digits, spaces and `-`), plus `.md`. */
function exportFileName(title: string | null): string {
  const safe = (title ?? "").replace(/[^\p{L}\p{N} -]+/gu, "").trim();
  const base = Array.from(safe).slice(0, maxFileNameLength).join("").trim();
  return `${base || "conversation"}.md`;
}

function renderMessage(message: ExportMessage): string {
  const sources = message.role === "assistant" ? sourcesOf(message.parts) : [];
  const webSources = webSourcesOf(sources);
  const body: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.content) body.push(citeLinks(part.content, sources));
    } else if (part.type === "tool-call") {
      const line = toolLine(part);
      if (line) body.push(line);
    }
  }
  if (message.attachments.length > 0) body.push(attachmentsLine(message.attachments));
  const marker = statusMarker(message);
  if (marker) body.push(marker);

  const sections = [`## ${headingOf(message)}`];
  if (body.length > 0) sections.push(body.join("\n\n"));
  if (webSources.length > 0) sections.push(webSources.map(referenceDefinition).join("\n"));
  return sections.join("\n\n");
}

function headingOf(message: ExportMessage): string {
  if (message.role === "user") return "You";
  const label = modelLabel(message.model);
  return label ? `Assistant · ${label}` : "Assistant";
}

/** The Model's display name, or its bare Model id when it is not curated. */
function modelLabel(id: string | null): string | undefined {
  if (!id) return undefined;
  return findModel(id)?.label ?? parseModelId(id)?.modelId ?? id;
}

/** One line per tool call; a search that never ran (over the limit) has none. */
function toolLine(part: MessagePart): string | undefined {
  if (part.type !== "tool-call") return undefined;
  if (webSearchOf(part)) return `> Used ${part.name}`;
  const call = toolCallOf(part);
  if (!call) return undefined;
  if (call.status === "awaiting_approval") return `> Waiting for Approval: ${call.name}`;
  if (call.status === "denied") return `> Used ${call.name} (denied)`;
  return `> Used ${call.name}`;
}

const attachmentTypeLabels = { image: "image", pdf: "PDF", text: "text" } as const;

function attachmentsLine(attachments: ExportMessage["attachments"]): string {
  const files = attachments.map(({ filename, mediaType }) => {
    const kind = attachmentKind(mediaType, filename);
    return `${filename} (${kind ? attachmentTypeLabels[kind] : mediaType})`;
  });
  return `Attachments: ${files.join(", ")}`;
}

function statusMarker({ status, error, errorReason }: ExportMessage): string | undefined {
  if (status === "stopped") return "_(Stopped)_";
  if (status === "error") return `_(Failed: ${error ?? errorReason ?? "unknown error"})_`;
  if (status === "streaming") return "_(Still writing when exported)_";
  return undefined;
}

/** A reference-style definition for one Source, numbered as the reply cites it. */
function referenceDefinition(source: Source): string {
  const title = source.title.replace(/\s+/g, " ").replace(/"/g, '\\"').trim();
  return `[${source.number}]: ${source.url}${title ? ` "${title}"` : ""}`;
}

/** An inline link: `[text](url)`, optionally with a title. Images (`![…]`) are not links here. */
const inlineLink = /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * Rewrites each link that cites one of the Message's Sources as `[text][n]`. Links outside the
 * text's fenced code blocks only; any other link stays as the Model wrote it.
 */
function citeLinks(content: string, sources: Citation[]): string {
  if (sources.length === 0) return content;
  let fenced = false;
  return content
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line.replace(inlineLink, (link, label: string, href: string) => {
        // An Excerpt has no URL to list, so its citation is its file name.
        if (excerptFor(href, sources)) return `[${label}]`;
        const source = citationFor(href, sources);
        return source ? `[${label}][${source.number}]` : link;
      });
    })
    .join("\n");
}

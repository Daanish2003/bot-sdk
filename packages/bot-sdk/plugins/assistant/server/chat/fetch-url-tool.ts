// Every Host compiles this file, not only the SDK's own tsconfig, so it carries the declaration:
// `html-to-text` ships no types, and an ambient declaration can't be imported.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="../../../../core/types/html-to-text.d.ts" />
import { toolDefinition } from "@tanstack/ai";
import { convert } from "html-to-text";
import { z } from "zod";

import type { ToolError } from "../../shared/message-parts";
import {
  type FetchedPage,
  type FetchErrorReason,
  fetchLimitError,
  fetchUrlToolName,
  type FetchUrlOutput,
  maxFetchedCharacters,
  maxFetchesPerReply,
} from "../../shared/chat/fetch-url";
import { BlockedAddressError } from "../../../../core/server/lib/guarded-fetch";
import { endToolCall, limitReached, type RunToolState, trackedTool } from "./tracked-tool";

/** The largest download a page may be; a larger one is refused. */
export const maxDownloadBytes = 2 * 1024 * 1024;

const fetchUrlDefinition = toolDefinition({
  name: fetchUrlToolName,
  description:
    "Read the text of one web page at an http or https URL the user gave you or a search returned. " +
    "Works on HTML, plain text, Markdown and JSON; PDFs and other files can't be read. Returns the " +
    `page's url, title and text (cut after ${maxFetchedCharacters} characters). At most ${maxFetchesPerReply} fetches per reply.`,
  inputSchema: z.object({
    url: z.string().min(1).meta({ description: "The http or https URL of the page to read" }),
  }),
});

/**
 * The `fetch_url` server tool for one reply: it reads a page through `fetch` (the guarded fetch,
 * which refuses non-public addresses) and records the call in the reply's `parts` as a `builtin`
 * `tool_call` (`trackedTool`). A page that can't be read is an error result with its reason, and
 * the reply continues. After `maxFetchesPerReply` fetches, a call gets `fetchLimitError` and fetches
 * nothing; the calls don't count against the reply's shared budget.
 */
export function createFetchUrlTool({
  fetch,
  timeoutMs,
  ...run
}: RunToolState & {
  fetch: typeof globalThis.fetch;
  /** How long one page may take (`Limits.fetchTimeoutMs`). */
  timeoutMs: number;
}) {
  const { parts } = run;
  let fetches = 0;
  return fetchUrlDefinition.server(
    trackedTool(
      fetchUrlToolName,
      run,
      {
        part: {
          start: (toolCallId, { url }: { url: string }) =>
            parts.startToolCall({
              toolCallId,
              name: fetchUrlToolName,
              source: "builtin",
              args: { url },
            }),
          refused: (toolCallId): FetchUrlOutput => limitReached(parts, toolCallId),
          failed: (toolCallId, caught) => {
            const failure =
              caught instanceof PageError
                ? { error: caught.message, reason: caught.reason }
                : { error: pageErrors.failed, reason: "failed" as const };
            return endToolCall(parts, toolCallId, "error", failure, pageErrorOf(failure.reason));
          },
        },
      },
      async ({ url }, { toolCallId, signal }): Promise<FetchUrlOutput> => {
        if (fetches >= maxFetchesPerReply) {
          return endToolCall(
            parts,
            toolCallId,
            "error",
            { error: fetchLimitError },
            { code: "chat.toolError.fetchLimit" },
          );
        }
        fetches++;
        const page = await readPage(url, { fetch, timeoutMs, signal });
        return endToolCall(parts, toolCallId, "done", page);
      },
    ),
  );
}

const pageErrors: Record<FetchErrorReason, string> = {
  timed_out: "The page took too long to load",
  too_large: `The page is larger than ${maxDownloadBytes / (1024 * 1024)} MB`,
  unsupported: "Only HTML, plain text, Markdown and JSON pages can be read",
  blocked: "The address is not a public address",
  http_error: "The page couldn't be fetched",
  failed: "The page couldn't be fetched",
};

/** The code a page's failure is stored under, with its params (spec #256): the Model reads `pageErrors`. */
function pageErrorOf(reason: FetchErrorReason): ToolError {
  const codes: Record<FetchErrorReason, string> = {
    timed_out: "chat.pageError.timedOut",
    too_large: "chat.pageError.tooLarge",
    unsupported: "chat.pageError.unsupported",
    blocked: "chat.pageError.blocked",
    http_error: "chat.pageError.httpError",
    failed: "chat.pageError.failed",
  };
  return reason === "too_large"
    ? { code: codes[reason], params: { megabytes: maxDownloadBytes / (1024 * 1024) } }
    : { code: codes[reason] };
}

/** Why one page couldn't be read, with the message the Model reads. */
class PageError extends Error {
  readonly reason: FetchErrorReason;

  constructor(reason: FetchErrorReason, message: string = pageErrors[reason]) {
    super(message);
    this.name = "PageError";
    this.reason = reason;
  }
}

/** The page at `url`, as text for the Model. Throws a `PageError`, or the caller's abort reason. */
async function readPage(
  url: string,
  {
    fetch,
    timeoutMs,
    signal,
  }: { fetch: typeof globalThis.fetch; timeoutMs: number; signal?: AbortSignal },
): Promise<FetchedPage> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetch(url, {
      headers: {
        accept: "text/html, text/plain, text/markdown, application/json;q=0.9, */*;q=0.1",
      },
      signal: requestSignal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new PageError("http_error", `The page answered HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type");
    const kind = kindOf(contentType);
    if (kind === undefined) {
      await response.body?.cancel();
      throw new PageError("unsupported");
    }
    const declared = Number(response.headers.get("content-length"));
    if (declared > maxDownloadBytes) {
      await response.body?.cancel();
      throw new PageError("too_large");
    }
    const source = decode(await readBounded(response, maxDownloadBytes), contentType);
    const finalUrl = response.url || url;
    if (kind === "html") return pageOf(finalUrl, titleOf(source), htmlToText(source));
    return pageOf(finalUrl, new URL(finalUrl).hostname, source.trim());
  } catch (caught) {
    if (signal?.aborted) throw caught;
    if (timeout.aborted) throw new PageError("timed_out");
    if (caught instanceof PageError) throw caught;
    if (blockedCause(caught)) throw new PageError("blocked");
    throw caught;
  }
}

/** The kind of page a content type is, or `undefined` for a type this tool can't read. */
function kindOf(contentType: string | null): "html" | "text" | undefined {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "text/plain" || mime === "text/markdown" || mime === "application/json")
    return "text";
  if (mime.endsWith("+json")) return "text";
  return undefined;
}

/** The body, read to its end; more than `limit` bytes is refused before the rest is read. */
async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new PageError("too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The body as text, in the charset its content type names (UTF-8 otherwise). */
function decode(bytes: Uint8Array, contentType: string | null): string {
  const charset = /charset=["']?([^";'\s]+)/i.exec(contentType ?? "")?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** The page's readable text: no scripts, styles or link targets. */
function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
    ],
  }).trim();
}

/** The `<title>` of an HTML page, or a placeholder when it has none. */
function titleOf(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1] ? convert(match[1], { wordwrap: false }).trim() : "";
  return title || "Untitled page";
}

/** A page for the Model: its text cut to the character cap. */
function pageOf(url: string, title: string, text: string): FetchedPage {
  const truncated = text.length > maxFetchedCharacters;
  return {
    url,
    title,
    content: truncated ? text.slice(0, maxFetchedCharacters) : text,
    ...(truncated && { truncated: true }),
  };
}

/** Whether the guard refused a non-public address somewhere in the error's causes. */
function blockedCause(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current instanceof BlockedAddressError) return true;
    current = current.cause;
  }
  return false;
}

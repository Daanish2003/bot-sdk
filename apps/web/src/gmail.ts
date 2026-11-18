import type { HostTool } from "@botsdk/mcp";
import { z } from "zod";

import { googleApi } from "./google-api";

// The Gmail Connection's tools (ADR 0037), over the Gmail REST API v1. A thread is archived, never
// deleted. Reads need no approval; the writes are Auto-reviewed (`connectionsOf`).
const api = "https://gmail.googleapis.com/gmail/v1/users/me";

const threadId = z.string().meta({ description: "A thread's id, from search_threads." });

const message = z.object({
  id: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  cc: z.string().optional(),
  subject: z.string().optional(),
  date: z.string().optional(),
  labels: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  body: z.string().meta({ description: "The message's text, any quoted history included." }),
});

type GooglePart = {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: GooglePart[];
};
type GoogleMessage = {
  id: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GooglePart;
};
type GoogleThread = { id: string; messages?: GoogleMessage[] };

const headerOf = (part: GooglePart | undefined, name: string) =>
  part?.headers?.find((each) => each.name.toLowerCase() === name.toLowerCase())?.value;

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

/** The first part of a type, searching the MIME tree depth first. */
function findPart(part: GooglePart | undefined, mimeType: string): GooglePart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

const htmlEntities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  nbsp: " ",
};

/** A message's text: its plain-text part, else its HTML part with the tags dropped. */
function bodyOf(payload: GooglePart | undefined): string {
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) return decode(plain.body.data);
  const html = findPart(payload, "text/html");
  if (html?.body?.data) {
    return decode(html.body.data)
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>|<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => htmlEntities[name] ?? "")
      .trim();
  }
  return "";
}

function messageOf(google: GoogleMessage): z.infer<typeof message> {
  return {
    id: google.id,
    from: headerOf(google.payload, "From"),
    to: headerOf(google.payload, "To"),
    cc: headerOf(google.payload, "Cc"),
    subject: headerOf(google.payload, "Subject"),
    date: headerOf(google.payload, "Date"),
    labels: google.labelIds,
    snippet: google.snippet,
    body: bodyOf(google.payload),
  };
}

/** A header value in MIME's encoded-word form when it holds more than ASCII. */
const encodedWord = (value: string) =>
  [...value].every((char) => char.charCodeAt(0) < 128)
    ? value
    : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;

/** A header value from the Bot: a line break in it would add headers of its own, a Bcc included. */
function headerValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("A recipient or a subject can't hold a line break.");
  return value;
}

/** An RFC 2822 plain-text message, base64url encoded as Gmail's `raw` field wants it. */
function rawMessage(fields: {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const headers = [
    `To: ${fields.to.map(headerValue).join(", ")}`,
    ...(fields.cc?.length ? [`Cc: ${fields.cc.map(headerValue).join(", ")}`] : []),
    `Subject: ${encodedWord(headerValue(fields.subject))}`,
    ...(fields.inReplyTo ? [`In-Reply-To: ${fields.inReplyTo}`] : []),
    ...(fields.references ? [`References: ${fields.references}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(fields.body)
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`).toString("base64url");
}

/** The five Gmail tools, calling Google through `fetch`. */
export function gmailTools(fetch: typeof globalThis.fetch = globalThis.fetch): HostTool[] {
  const call = (
    accessToken: string,
    url: string,
    init?: { method?: string; body?: unknown; signal?: AbortSignal },
  ) => googleApi(fetch, "Gmail", accessToken, url, init);

  return [
    {
      name: "search_threads",
      description:
        "Search the user's threads with Gmail's search syntax (from:, to:, subject:, is:unread, " +
        "newer_than:7d, label:), newest first. Answers each thread's id and snippet.",
      inputSchema: z.object({
        query: z.string().meta({ description: 'A Gmail search, such as "from:ann is:unread".' }),
        maxResults: z.number().int().min(1).max(100).default(20),
      }),
      outputSchema: z.object({
        threads: z.array(z.object({ id: z.string(), snippet: z.string().optional() })),
      }),
      execute: async (input, { accessToken, signal }) => {
        const url = new URL(`${api}/threads`);
        url.searchParams.set("q", input.query);
        url.searchParams.set("maxResults", String(input.maxResults));
        const list = (await call(accessToken, url.toString(), { signal })) as {
          threads?: { id: string; snippet?: string }[];
        };
        return {
          threads: (list.threads ?? []).map(({ id, snippet }) => ({ id, snippet })),
        };
      },
    },
    {
      name: "get_thread",
      description: "Read a thread: each of its messages, oldest first, with its text.",
      inputSchema: z.object({ threadId }),
      outputSchema: z.object({ id: z.string(), messages: z.array(message) }),
      execute: async (input, { accessToken, signal }) => {
        const thread = (await call(
          accessToken,
          `${api}/threads/${encodeURIComponent(input.threadId)}?format=full`,
          { signal },
        )) as GoogleThread;
        return { id: thread.id, messages: (thread.messages ?? []).map(messageOf) };
      },
    },
    {
      name: "create_draft",
      description:
        "Create a draft, which sends nothing until send_draft. With threadId it is a reply to " +
        "the thread's last message, addressed to its sender unless `to` is given; without, it " +
        "is a new message and needs `to` and `subject`.",
      inputSchema: z.object({
        threadId: threadId.optional().meta({ description: "The thread to reply in." }),
        to: z.array(z.string()).optional().meta({ description: "Email addresses." }),
        cc: z.array(z.string()).optional(),
        subject: z.string().optional(),
        body: z.string().meta({ description: "The message's text." }),
      }),
      outputSchema: z.object({ draftId: z.string(), threadId: z.string().optional() }),
      execute: async (input, { accessToken, signal }) => {
        let fields: Parameters<typeof rawMessage>[0];
        if (input.threadId) {
          const thread = (await call(
            accessToken,
            `${api}/threads/${encodeURIComponent(input.threadId)}?format=metadata`,
            { signal },
          )) as GoogleThread;
          const lastMessage = thread.messages?.at(-1);
          const last = lastMessage?.payload;
          if (!last) throw new Error("The thread has no message to reply to.");
          const subject = headerOf(last, "Subject") ?? "";
          const messageId = headerOf(last, "Message-ID") ?? headerOf(last, "Message-Id");
          const references = headerOf(last, "References");
          // A message the user sent is answered again to whom it went, not to the user.
          const sender = lastMessage?.labelIds?.includes("SENT")
            ? headerOf(last, "To")
            : (headerOf(last, "Reply-To") ?? headerOf(last, "From"));
          const to = input.to ?? (sender ? [sender] : []);
          if (to.length === 0) throw new Error("The reply has no one to go to: give `to`.");
          fields = {
            to,
            cc: input.cc,
            subject: input.subject ?? (/^re:/i.test(subject) ? subject : `Re: ${subject}`),
            body: input.body,
            ...(messageId
              ? {
                  inReplyTo: messageId,
                  references: [references, messageId].filter(Boolean).join(" "),
                }
              : {}),
          };
        } else {
          if (!input.to?.length || input.subject === undefined) {
            throw new Error("A new draft needs `to` and `subject`.");
          }
          fields = { to: input.to, cc: input.cc, subject: input.subject, body: input.body };
        }
        const draft = (await call(accessToken, `${api}/drafts`, {
          method: "POST",
          body: {
            message: {
              raw: rawMessage(fields),
              ...(input.threadId ? { threadId: input.threadId } : {}),
            },
          },
          signal,
        })) as { id: string; message?: { threadId?: string } };
        return { draftId: draft.id, threadId: draft.message?.threadId };
      },
    },
    {
      name: "send_draft",
      description: "Send a draft made with create_draft, as it stands.",
      inputSchema: z.object({ draftId: z.string() }),
      outputSchema: z.object({ messageId: z.string(), threadId: z.string().optional() }),
      execute: async (input, { accessToken, signal }) => {
        const sent = (await call(accessToken, `${api}/drafts/send`, {
          method: "POST",
          body: { id: input.draftId },
          signal,
        })) as { id: string; threadId?: string };
        return { messageId: sent.id, threadId: sent.threadId };
      },
    },
    {
      name: "archive_thread",
      description: "Archive a thread: take it out of the inbox. Nothing is deleted.",
      inputSchema: z.object({ threadId }),
      outputSchema: z.object({ threadId: z.string() }),
      execute: async (input, { accessToken, signal }) => {
        await call(accessToken, `${api}/threads/${encodeURIComponent(input.threadId)}/modify`, {
          method: "POST",
          body: { removeLabelIds: ["INBOX"] },
          signal,
        });
        return { threadId: input.threadId };
      },
    },
  ];
}

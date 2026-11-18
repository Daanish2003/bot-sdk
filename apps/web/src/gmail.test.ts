import { ConnectionBrokenError, type HostTool } from "@botsdk/mcp";
import { describe, expect, it } from "vitest";

import { gmailTools } from "./gmail";

const api = "https://gmail.googleapis.com/gmail/v1/users/me";
const token = "ya29.gmail-token";

type Sent = { method: string; url: string; body: unknown; authorization: string | null };

/** A fake Google HTTP API: records each request and answers it with `answer`. */
function fakeGoogle(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    const one: Sent = {
      method: request.method,
      url: request.url,
      body: text ? JSON.parse(text) : undefined,
      authorization: request.headers.get("authorization"),
    };
    sent.push(one);
    return answer(one);
  }) as typeof globalThis.fetch;
  const tools = Object.fromEntries(gmailTools(fetch).map((tool) => [tool.name, tool]));
  return { sent, tools };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const b64 = (text: string) => Buffer.from(text).toString("base64url");
const unb64 = (data: string) => Buffer.from(data, "base64url").toString("utf8");

const header = (name: string, value: string) => ({ name, value });

const googleThread = {
  id: "t1",
  historyId: "99",
  messages: [
    {
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "Are we on for Friday?",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          header("From", "Ann <ann@example.com>"),
          header("To", "me@example.com"),
          header("Subject", "Friday"),
          header("Date", "Tue, 17 Nov 2026 10:00:00 +0000"),
          header("Message-ID", "<m1@example.com>"),
        ],
        parts: [
          { mimeType: "text/plain", body: { data: b64("Are we on for Friday?") } },
          { mimeType: "text/html", body: { data: b64("<p>Are we on for Friday?</p>") } },
        ],
      },
    },
    {
      id: "m2",
      threadId: "t1",
      labelIds: ["INBOX"],
      snippet: "Yes",
      payload: {
        mimeType: "text/plain",
        headers: [
          header("From", "Bob <bob@example.com>"),
          header("Reply-To", "bob.reply@example.com"),
          header("To", "me@example.com, ann@example.com"),
          header("Subject", "Re: Friday"),
          header("Message-ID", "<m2@example.com>"),
          header("References", "<m1@example.com>"),
        ],
        body: { data: b64("Yes") },
      },
    },
  ],
};

/** Runs `tool` with `input` and the Connection's token, its input and result checked by its schemas. */
async function run(tool: HostTool | undefined, input: unknown) {
  if (!tool) throw new Error("No such tool");
  const parsedInput = await parse(tool.inputSchema, input);
  const result = await tool.execute(parsedInput, { accessToken: token });
  return parse(tool.outputSchema, result);
}

async function parse(schema: unknown, value: unknown) {
  const standard = (schema as { "~standard": { validate: (value: unknown) => unknown } })[
    "~standard"
  ];
  const result = (await standard.validate(value)) as { value?: unknown; issues?: unknown[] };
  if (result.issues) throw new Error(`Schema issues: ${JSON.stringify(result.issues)}`);
  return result.value;
}

/** The raw RFC 2822 message a draft was sent with, split into its headers and its body. */
function rawOf(body: unknown) {
  const { message } = body as { message: { raw: string; threadId?: string } };
  const text = unb64(message.raw);
  const [head = "", ...rest] = text.split("\r\n\r\n");
  const headers = Object.fromEntries(
    head
      .split("\r\n")
      .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]),
  );
  const decoded = Buffer.from(rest.join("").replace(/\r\n/g, ""), "base64").toString("utf8");
  return { headers, body: decoded, threadId: message.threadId };
}

describe("the Gmail tools", () => {
  it("are the five Gmail tools", () => {
    expect(gmailTools().map((tool) => tool.name)).toEqual([
      "search_threads",
      "get_thread",
      "create_draft",
      "send_draft",
      "archive_thread",
    ]);
  });

  it("search_threads searches with Gmail's query syntax", async () => {
    const { sent, tools } = fakeGoogle(() =>
      json({ threads: [{ id: "t1", snippet: "Are we on for Friday?", historyId: "99" }] }),
    );

    const result = await run(tools.search_threads, { query: "from:ann is:unread", maxResults: 5 });

    expect(sent).toHaveLength(1);
    const url = new URL(sent[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${api}/threads`);
    expect(url.searchParams.get("q")).toBe("from:ann is:unread");
    expect(url.searchParams.get("maxResults")).toBe("5");
    expect(sent[0]).toMatchObject({ method: "GET", authorization: `Bearer ${token}` });
    expect(result).toEqual({ threads: [{ id: "t1", snippet: "Are we on for Friday?" }] });
  });

  it("search_threads answers no threads when Google has none", async () => {
    const { tools } = fakeGoogle(() => json({ resultSizeEstimate: 0 }));

    expect(await run(tools.search_threads, { query: "nothing" })).toEqual({ threads: [] });
  });

  it("get_thread reads a thread's messages, with their plain-text bodies", async () => {
    const { sent, tools } = fakeGoogle(() => json(googleThread));

    const result = await run(tools.get_thread, { threadId: "t1" });

    expect(sent.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: `${api}/threads/t1?format=full` },
    ]);
    expect(result).toEqual({
      id: "t1",
      messages: [
        {
          id: "m1",
          from: "Ann <ann@example.com>",
          to: "me@example.com",
          subject: "Friday",
          date: "Tue, 17 Nov 2026 10:00:00 +0000",
          labels: ["INBOX", "UNREAD"],
          snippet: "Are we on for Friday?",
          body: "Are we on for Friday?",
        },
        {
          id: "m2",
          from: "Bob <bob@example.com>",
          to: "me@example.com, ann@example.com",
          subject: "Re: Friday",
          labels: ["INBOX"],
          snippet: "Yes",
          body: "Yes",
        },
      ],
    });
  });

  it("create_draft makes a new draft from its recipients, subject and body", async () => {
    const { sent, tools } = fakeGoogle(() =>
      json({ id: "d1", message: { id: "m9", threadId: "t9" } }),
    );

    const result = await run(tools.create_draft, {
      to: ["ann@example.com", "bob@example.com"],
      cc: ["cy@example.com"],
      subject: "Lunch",
      body: "Noon?",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST", url: `${api}/drafts` });
    const raw = rawOf(sent[0]!.body);
    expect(raw.headers).toMatchObject({
      To: "ann@example.com, bob@example.com",
      Cc: "cy@example.com",
      Subject: "Lunch",
    });
    expect(raw.body).toBe("Noon?");
    expect(raw.threadId).toBeUndefined();
    expect(result).toEqual({ draftId: "d1", threadId: "t9" });
  });

  it("create_draft with a threadId is a reply: it answers the last message, in its thread", async () => {
    const { sent, tools } = fakeGoogle((request) =>
      request.method === "GET"
        ? json(googleThread)
        : json({ id: "d2", message: { id: "m10", threadId: "t1" } }),
    );

    const result = await run(tools.create_draft, { threadId: "t1", body: "Friday works." });

    expect(sent.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: `${api}/threads/t1?format=metadata` },
      { method: "POST", url: `${api}/drafts` },
    ]);
    const raw = rawOf(sent[1]!.body);
    expect(raw.threadId).toBe("t1");
    expect(raw.headers).toMatchObject({
      To: "bob.reply@example.com",
      Subject: "Re: Friday",
      "In-Reply-To": "<m2@example.com>",
      References: "<m1@example.com> <m2@example.com>",
    });
    expect(raw.body).toBe("Friday works.");
    expect(result).toEqual({ draftId: "d2", threadId: "t1" });
  });

  it("create_draft without a threadId needs recipients and a subject", async () => {
    const { tools } = fakeGoogle(() => json({}));

    await expect(run(tools.create_draft, { body: "Hi" })).rejects.toThrow(
      "A new draft needs `to` and `subject`",
    );
  });

  it("create_draft keeps a non-ASCII subject and body intact", async () => {
    const { sent, tools } = fakeGoogle(() =>
      json({ id: "d3", message: { id: "m11", threadId: "t11" } }),
    );

    await run(tools.create_draft, { to: ["ann@example.com"], subject: "Café ☕", body: "Grüße" });

    const raw = rawOf(sent[0]!.body);
    expect(raw.headers.Subject).toBe(`=?UTF-8?B?${Buffer.from("Café ☕").toString("base64")}?=`);
    expect(raw.headers["Content-Type"]).toBe('text/plain; charset="UTF-8"');
    expect(raw.headers["Content-Transfer-Encoding"]).toBe("base64");
    expect(raw.body).toBe("Grüße");
  });

  it("send_draft sends the draft by its id", async () => {
    const { sent, tools } = fakeGoogle(() =>
      json({ id: "m12", threadId: "t1", labelIds: ["SENT"] }),
    );

    const result = await run(tools.send_draft, { draftId: "d2" });

    expect(sent.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: "POST", url: `${api}/drafts/send`, body: { id: "d2" } },
    ]);
    expect(result).toEqual({ messageId: "m12", threadId: "t1" });
  });

  it("archive_thread takes the thread out of the inbox", async () => {
    const { sent, tools } = fakeGoogle(() => json({ id: "t1", messages: [] }));

    const result = await run(tools.archive_thread, { threadId: "t1" });

    expect(sent.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: "POST", url: `${api}/threads/t1/modify`, body: { removeLabelIds: ["INBOX"] } },
    ]);
    expect(result).toEqual({ threadId: "t1" });
  });

  it.each([
    ["HTTP 401", () => new Response("Unauthorized", { status: 401 })],
    [
      // What Google answers a token whose grant the user revoked.
      "a revoked grant",
      () =>
        json(
          {
            error: {
              code: 401,
              message: "Request had invalid authentication credentials.",
              status: "UNAUTHENTICATED",
            },
          },
          401,
        ),
    ],
    [
      // A link the user unticked the Gmail scope on: linking again asks for it.
      "a token without the Gmail scope",
      () =>
        json(
          {
            error: {
              code: 403,
              message: "Request had insufficient authentication scopes.",
              status: "PERMISSION_DENIED",
              details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
            },
          },
          403,
        ),
    ],
  ])("reports %s as a broken Connection", async (_case, answer) => {
    const { tools } = fakeGoogle(answer);

    await expect(run(tools.search_threads, { query: "x" })).rejects.toBeInstanceOf(
      ConnectionBrokenError,
    );
  });

  it("answers any other error with Google's message", async () => {
    const { tools } = fakeGoogle(() =>
      json(
        { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } },
        404,
      ),
    );

    const failure = run(tools.get_thread, { threadId: "gone" });

    await expect(failure).rejects.toThrow(
      "Gmail answered HTTP 404: Requested entity was not found.",
    );
    await expect(failure).rejects.not.toBeInstanceOf(ConnectionBrokenError);
  });
});

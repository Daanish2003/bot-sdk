import { describe, expect, it } from "vitest";

import { mailpitEmailProvider } from "../../../plugins/channel/mailpit/index";

const api = "http://mailpit.test:8025";

// Recorded from Mailpit v1.31.6 (#773): the webhook body, GET /api/v1/message/<ID>, and
// GET /api/v1/message/<ID>/headers.
const webhook = {
  ID: "0w8flfwFnAYZktR9xd09T1",
  MessageID: "m1@test.local",
  From: { Name: "Ada Owner", Address: "ada.owner@example.com" },
  To: [{ Name: "", Address: "ada-lovelace-x@bots.localhost" }],
  Subject: "Hi",
  Size: 345,
  Attachments: 0,
  Snippet: "hello bot",
};
const message = {
  ID: webhook.ID,
  MessageID: "m1@test.local",
  From: webhook.From,
  To: [
    { Name: "", Address: "ada-lovelace-x@bots.localhost" },
    { Name: "Grace", Address: "grace@example.com" },
  ],
  Subject: "Hi",
  Text: "hello bot",
  Attachments: [{ PartID: "2", FileName: "notes.pdf", ContentType: "application/pdf", Size: 3 }],
};
const headers = {
  "In-Reply-To": ["<p0@test.local>"],
  "Message-Id": ["<m1@test.local>"],
  References: ["<p0@test.local> <p1@test.local>"],
  Subject: ["Hi"],
};

function mailpit(held: Record<string, unknown> = { [webhook.ID]: message }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    if (path === "/api/v1/send") return Response.json({ ID: "sent" });
    const [, , , , id, tail] = path.split("/");
    if (!id || !(id in held)) return new Response("not found", { status: 404 });
    if (tail === "part") return new Response(new Uint8Array([1, 2, 3]));
    return Response.json(tail === "headers" ? headers : held[id]);
  }) as unknown as typeof fetch;
  return { calls, provider: mailpitEmailProvider({ apiUrl: api, fetch: fetcher }) };
}

const post = (body: unknown) =>
  new Request("http://localhost/api/channels/email", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("mailpitEmailProvider.parseInbound", () => {
  it("fetches the mail the webhook names, and vouches with an aligned DMARC pass", async () => {
    const { provider } = mailpit();
    expect(await provider.parseInbound(post(webhook))).toEqual({
      from: "Ada Owner <ada.owner@example.com>",
      to: ["ada-lovelace-x@bots.localhost", "Grace <grace@example.com>"],
      messageId: "m1@test.local",
      subject: "Hi",
      text: "hello bot",
      headers: {
        "in-reply-to": "<p0@test.local>",
        "message-id": "<m1@test.local>",
        references: "<p0@test.local> <p1@test.local>",
        subject: "Hi",
      },
      attachments: ["notes.pdf"],
      files: [
        { name: "notes.pdf", contentType: "application/pdf", size: 3, read: expect.any(Function) },
      ],
      authentication: { spf: "none", dkim: "none", dmarc: "pass" },
    });
  });

  it("reads an attachment's bytes from its part only when asked", async () => {
    const { provider, calls } = mailpit();
    const mail = await provider.parseInbound(post(webhook));
    if ("rejected" in mail) throw new Error(mail.rejected);
    expect(calls.some((call) => call.url.includes("/part/"))).toBe(false);

    expect([...(await mail.files![0]!.read())]).toEqual([1, 2, 3]);
    expect(calls.at(-1)!.url).toBe(`${api}/api/v1/message/${webhook.ID}/part/2`);
  });

  it("refuses a webhook that doesn't name a message Mailpit holds", async () => {
    const { provider } = mailpit();
    expect(await provider.parseInbound(post({ ...webhook, ID: "forged" }))).toEqual({
      rejected: expect.any(String),
    });
  });

  it("refuses a body that isn't a webhook, without calling Mailpit", async () => {
    const { provider, calls } = mailpit();
    for (const body of ["not json", {}, { ID: 7 }, { ID: "../send" }]) {
      expect(await provider.parseInbound(post(body))).toEqual({ rejected: expect.any(String) });
    }
    expect(calls).toEqual([]);
  });

  it("refuses when Mailpit can't be reached", async () => {
    const provider = mailpitEmailProvider({
      apiUrl: api,
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(await provider.parseInbound(post(webhook))).toEqual({ rejected: expect.any(String) });
  });
});

describe("mailpitEmailProvider.send", () => {
  it("posts the mail to the send API with its threading headers", async () => {
    const { provider, calls } = mailpit();
    await provider.send({
      from: "Ada Lovelace <ada-lovelace-x@bots.localhost>",
      to: "ada.owner@example.com",
      subject: "Re: Hi",
      text: "hello owner",
      html: "<p>hello owner</p>",
      messageId: "<r1@bots.localhost>",
      inReplyTo: "<m1@test.local>",
      references: ["<p0@test.local>", "<m1@test.local>"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${api}/api/v1/send`);
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      From: { Email: "ada-lovelace-x@bots.localhost", Name: "Ada Lovelace" },
      To: [{ Email: "ada.owner@example.com" }],
      Subject: "Re: Hi",
      Text: "hello owner",
      HTML: "<p>hello owner</p>",
      Headers: {
        "Message-ID": "<r1@bots.localhost>",
        "In-Reply-To": "<m1@test.local>",
        References: "<p0@test.local> <m1@test.local>",
      },
    });
  });

  it("sends attachments as base64", async () => {
    const { provider, calls } = mailpit();
    await provider.send({
      from: "a@b.c",
      to: "d@e.f",
      subject: "",
      text: "",
      messageId: "<x>",
      attachments: [
        { name: "h.txt", contentType: "text/plain", content: new TextEncoder().encode("hello") },
      ],
    });
    expect(JSON.parse(calls[0]!.init!.body as string).Attachments).toEqual([
      { Filename: "h.txt", ContentType: "text/plain", Content: "aGVsbG8=" },
    ]);
  });

  it("leaves out the threading headers a first mail doesn't have, and throws on a refusal", async () => {
    const { provider, calls } = mailpit();
    await provider.send({
      from: "ada@bots.localhost",
      to: "ada.owner@example.com",
      subject: "Hi",
      text: "hi",
      messageId: "<r2@bots.localhost>",
    });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      From: { Email: "ada@bots.localhost" },
      To: [{ Email: "ada.owner@example.com" }],
      Subject: "Hi",
      Text: "hi",
      Headers: { "Message-ID": "<r2@bots.localhost>" },
    });
    const refusing = mailpitEmailProvider({
      apiUrl: api,
      fetch: (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch,
    });
    await expect(
      refusing.send({ from: "a@b.c", to: "d@e.f", subject: "", text: "", messageId: "<x>" }),
    ).rejects.toThrow(/400/);
  });
});

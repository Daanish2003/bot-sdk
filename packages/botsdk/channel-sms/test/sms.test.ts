import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CredentialsRejectedError } from "@botsdk/bot/channel";

import { cutMarker, fitSegments, measure, sms, TelnyxApiError } from "../src";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

type Recorded = { method: string; url: string; auth: string | undefined; body: unknown };
let server: Server;
let url = "";
let requests: Recorded[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(async () => {
  requests = [];
  reply = { status: 200, body: {} };
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        auth: request.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      });
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

const call = { fetch };
const credentials = { apiKey: "KEY", publicKey: rawKey, number: "+15550001111" };
const account = { id: "acc", botId: "bot", platformBotId: "x", handle: "x", credentials };
const adapter = () => sms({ apiBase: url });

describe("check", () => {
  it("looks the number up with the API key", async () => {
    reply = { status: 200, body: { data: [{ phone_number: "+15550001111" }] } };
    expect(await adapter().check(credentials, call)).toEqual({
      platformBotId: "+15550001111",
      handle: "+15550001111",
    });
    expect(requests[0]?.auth).toBe("Bearer KEY");
    expect(requests[0]?.url).toContain("filter[phone_number]=%2B15550001111");
  });

  it("rejects a key the API refuses", async () => {
    reply = { status: 401, body: { errors: [{ title: "Authentication failed" }] } };
    expect(await adapter().check(credentials, call)).toEqual({ rejected: "Authentication failed" });
  });

  it("rejects a number that isn't on the account, and a public key that isn't a key", async () => {
    reply = { status: 200, body: { data: [] } };
    expect(await adapter().check(credentials, call)).toEqual({
      rejected: "The number isn't on the account",
    });
    expect(await adapter().check({ ...credentials, publicKey: "abc" }, call)).toMatchObject({
      rejected: expect.stringContaining("public key"),
    });
  });

  it("throws on an error that is not about the credentials", async () => {
    reply = { status: 500, body: { errors: [{ detail: "boom" }] } };
    await expect(adapter().check(credentials, call)).rejects.toThrow("boom");
  });
});

describe("webhook", () => {
  const event = (over: Record<string, unknown> = {}, type = "message.received") =>
    JSON.stringify({
      data: {
        event_type: type,
        payload: {
          id: "msg-1",
          text: "hello",
          from: { phone_number: "+15559998888" },
          media: [],
          ...over,
        },
      },
    });
  const request = (
    body: string,
    { timestamp = String(Math.floor(Date.now() / 1000)), key = privateKey } = {},
  ) => ({
    body,
    headers: new Headers({
      "telnyx-timestamp": timestamp,
      "telnyx-signature-ed25519": sign(null, Buffer.from(`${timestamp}|${body}`), key).toString(
        "base64",
      ),
    }),
  });

  it("turns a signed message.received into an update from the sender's number", async () => {
    const result = await adapter().webhook!(account, request(event()), call);
    expect(result).toEqual({
      updates: [
        {
          sourceId: "msg-1",
          sender: { id: "+15559998888", handle: "+15559998888" },
          chat: { id: "+15559998888", private: true },
          text: "hello",
          files: [],
        },
      ],
    });
  });

  it("refuses a bad signature", async () => {
    const other = generateKeyPairSync("ed25519").privateKey;
    expect(await adapter().webhook!(account, request(event(), { key: other }), call)).toEqual({
      rejected: "Bad signature",
    });
    const signed = request(event());
    expect(
      await adapter().webhook!(account, { ...signed, body: event({ text: "x" }) }, call),
    ).toEqual({ rejected: "Bad signature" });
  });

  it("refuses a missing signature and a stale timestamp", async () => {
    expect(
      await adapter().webhook!(account, { body: event(), headers: new Headers() }, call),
    ).toEqual({ rejected: "Missing signature" });
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(await adapter().webhook!(account, request(event(), { timestamp: old }), call)).toEqual({
      rejected: "Stale timestamp",
    });
  });

  it("gives a duplicate the same sourceId, for the core to drop", async () => {
    const first = await adapter().webhook!(account, request(event()), call);
    const second = await adapter().webhook!(account, request(event()), call);
    expect(first).toEqual(second);
  });

  it("ignores a message sent to another number", async () => {
    const to = [{ phone_number: "+15557776666" }];
    expect(await adapter().webhook!(account, request(event({ to })), call)).toEqual({
      updates: [],
    });
    const mine = [{ phone_number: "+15550001111" }];
    expect(await adapter().webhook!(account, request(event({ to: mine })), call)).toMatchObject({
      updates: [{ sourceId: "msg-1" }],
    });
  });

  it("ignores media, a media-only message and other events", async () => {
    const media = [{ url: "https://x/y.jpg" }];
    expect(await adapter().webhook!(account, request(event({ media })), call)).toMatchObject({
      updates: [{ text: "hello", files: [] }],
    });
    expect(await adapter().webhook!(account, request(event({ media, text: "" })), call)).toEqual({
      updates: [],
    });
    expect(
      await adapter().webhook!(account, request(event({}, "message.finalized")), call),
    ).toEqual({ updates: [] });
  });
});

describe("send", () => {
  it("posts from, to and text to /v2/messages and returns the message id", async () => {
    reply = { status: 200, body: { data: { id: "out-1", parts: 2 } } };
    const sent = await adapter().send(
      account,
      { chatId: "+15559998888", text: "Hi **there**" },
      call,
    );
    expect(sent).toEqual({ messageIds: ["out-1"] });
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/v2/messages",
      auth: "Bearer KEY",
      body: { from: "+15550001111", to: "+15559998888", text: "Hi there" },
    });
  });

  it("maps a 401 to a credentials rejection and any other failure to a retried error", async () => {
    reply = { status: 401, body: { errors: [{ title: "Unauthorized" }] } };
    await expect(
      adapter().send(account, { chatId: "+1555", text: "x" }, call),
    ).rejects.toBeInstanceOf(CredentialsRejectedError);
    reply = { status: 400, body: { errors: [{ detail: "bad number" }] } };
    await expect(adapter().send(account, { chatId: "+1555", text: "x" }, call)).rejects.toThrow(
      TelnyxApiError,
    );
  });

  it("cuts a long reply and says so", async () => {
    reply = { status: 200, body: { data: { id: "o" } } };
    await adapter().send(account, { chatId: "+1555", text: "word ".repeat(200) }, call);
    const text = (requests[0]!.body as { text: string }).text;
    expect(text.endsWith(cutMarker)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(459);
  });
});

describe("segments", () => {
  it("counts GSM-7 text, with extension characters as two", () => {
    expect(measure("hello")).toEqual({ encoding: "gsm7", units: 5 });
    expect(measure("a{b}")).toEqual({ encoding: "gsm7", units: 6 });
  });

  it("counts any other character as UCS-2 for the whole text", () => {
    expect(measure("hi 😀")).toEqual({ encoding: "ucs2", units: 5 });
  });

  it("keeps a reply of exactly three segments whole", () => {
    const gsm = "a".repeat(3 * 153);
    expect(fitSegments(gsm)).toEqual({ text: gsm, cut: false });
    const ucs = "ж".repeat(3 * 67);
    expect(fitSegments(ucs)).toEqual({ text: ucs, cut: false });
  });

  it("cuts a longer GSM-7 reply on a word boundary within three segments", () => {
    const result = fitSegments("word ".repeat(120));
    expect(result.cut).toBe(true);
    expect(result.text.endsWith(`word${cutMarker}`)).toBe(true);
    expect(measure(result.text).units).toBeLessThanOrEqual(459);
  });

  it("hard-cuts text with no usable word break", () => {
    const result = fitSegments(`See ${"x".repeat(600)}`);
    expect(result.text.length).toBeGreaterThan(400);
    expect(result.text.endsWith(cutMarker)).toBe(true);
  });

  it("cuts a longer UCS-2 reply within 3 x 67 units, never inside a surrogate pair", () => {
    const result = fitSegments("привет 😀 ".repeat(40));
    expect(result.cut).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(201);
    expect(result.text.endsWith(cutMarker)).toBe(true);
    expect(result.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

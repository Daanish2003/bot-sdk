import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MessagingUpdate } from "@botsdk/bot/channel";

import { startLabPhone } from "../lab-phone/lab-phone";
import type { LabPhone } from "../lab-phone/lab-phone";
import { sms } from "../src";

let phone: LabPhone;
let app: Server;
let appUrl = "";
let appKey = "";
let rejected: string[] = [];
let updates: MessagingUpdate[] = [];

const number = "+15550001111";
const customer = "+15550002222";
const call = { fetch };
const credentials = (publicKey: string) => ({ apiKey: "ANY", publicKey, number });
const account = (publicKey: string) => ({
  id: "acc",
  botId: "bot",
  platformBotId: number,
  handle: number,
  credentials: credentials(publicKey),
});

beforeEach(async () => {
  appKey = "";
  rejected = [];
  updates = [];
  phone = await startLabPhone();
  // Stands in for the app's webhook route: it hands the request to the adapter, as the core does.
  app = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const headers = new Headers(request.headers as Record<string, string>);
      void sms({ apiBase: phone.url }).webhook!(
        account(appKey || phone.publicKey),
        { headers, body },
        call,
      ).then((result) => {
        if ("rejected" in result) rejected.push(result.rejected);
        else updates.push(...result.updates);
        response.writeHead("rejected" in result ? 401 : 200).end();
      });
    });
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}/channels/sms/acc`;
});
afterEach(async () => {
  await phone.close();
  await new Promise<void>((resolve) => app.close(() => resolve()));
});

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields),
  redirect: "manual" as const,
});

describe("the lab phone through the Telnyx adapter", () => {
  it("accepts the number check and shows a sent text per phone number", async () => {
    const adapter = sms({ apiBase: phone.url });
    expect(await adapter.check(credentials(phone.publicKey), call)).toEqual({
      platformBotId: number,
      handle: number,
    });
    const sent = await adapter.send(
      account(phone.publicKey),
      { chatId: customer, text: "Hi <b>" },
      call,
    );
    expect(sent.messageIds).toHaveLength(1);
    const page = await (await fetch(phone.url)).text();
    expect(page).toContain(`<h2>${customer}</h2>`);
    expect(page).toContain("Hi &#60;b&#62;");
    expect(page).toContain(phone.publicKey);
  });

  it("sends one long text in a single request", async () => {
    const long = "word ".repeat(80).trim();
    await sms({ apiBase: phone.url }).send(
      account(phone.publicKey),
      { chatId: customer, text: long },
      call,
    );
    expect(phone.texts).toHaveLength(1);
  });

  it("delivers a typed text to the webhook, signature check included", async () => {
    await fetch(`${phone.url}/webhook-url`, form({ url: appUrl }));
    const response = await fetch(
      `${phone.url}/receive`,
      form({ from: customer, to: number, text: "hello bot" }),
    );
    expect(response.status).toBe(303);
    expect(rejected).toEqual([]);
    expect(updates).toMatchObject([
      { sender: { id: customer }, chat: { id: customer }, text: "hello bot" },
    ]);
    expect(await (await fetch(phone.url)).text()).toContain("hello bot");
  });

  it("is refused when the account holds another public key", async () => {
    const other = await startLabPhone({ seed: "another" });
    appKey = other.publicKey;
    await other.close();
    await fetch(`${phone.url}/webhook-url`, form({ url: appUrl }));
    await fetch(`${phone.url}/receive`, form({ from: customer, to: number, text: "hello bot" }));
    expect(updates).toEqual([]);
    expect(rejected).toEqual(["Bad signature"]);
  });

  it("refuses a post from another origin", async () => {
    const response = await fetch(`${phone.url}/webhook-url`, {
      ...form({ url: appUrl }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://evil.example",
      },
    });
    expect(response.status).toBe(403);
  });
});

describe("the lab phone's server, run directly", () => {
  // It accepts any key and posts signed requests anywhere, so off Docker it stays on this machine
  // (#1174 review); docker compose sets HOST=0.0.0.0 inside its container.
  it("listens on 127.0.0.1 unless HOST says otherwise", async () => {
    const env = { ...process.env, PORT: "0" };
    delete env.HOST;
    const server = spawn(process.execPath, ["server.ts"], {
      cwd: fileURLToPath(new URL("../lab-phone/", import.meta.url)),
      env,
    });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        server.stdout.on("data", (data: Buffer) => resolve(data.toString()));
        server.on("exit", (code) => reject(new Error(`The server exited with ${code}`)));
      });
      expect(line).toMatch(/^Lab phone on http:\/\/127\.0\.0\.1:\d+;/);
    } finally {
      server.kill();
    }
  });
});

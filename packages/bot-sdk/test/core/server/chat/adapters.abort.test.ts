import { createServer, type Server } from "node:http";
import {
  createServer as createHttp2Server,
  type Http2Server,
  type ServerHttp2Session,
} from "node:http2";
import type { AddressInfo } from "node:net";

import { type AnyTextAdapter, chat } from "@tanstack/ai";
import { createMistralText } from "@tanstack/ai-mistral";
import { createOllamaChat } from "@tanstack/ai-ollama";
import { afterEach, describe, expect, it } from "vitest";

import { createAbortableBedrockText } from "../../../../core/server/chat/adapters";

/**
 * A Provider that takes a request and never answers it. `connectionClosed` settles when the
 * client drops the request, which is what aborting the run must do (issue #54). Bedrock's client
 * speaks HTTP/2, the others HTTP/1.1.
 */
async function hangingProvider(protocol: "http1" | "http2" = "http1") {
  let received!: () => void;
  let closed!: () => void;
  const requestReceived = new Promise<void>((resolve) => (received = resolve));
  const connectionClosed = new Promise<void>((resolve) => (closed = resolve));
  let server: Server | Http2Server;
  let shutdown: () => void;
  if (protocol === "http2") {
    const sessions = new Set<ServerHttp2Session>();
    const http2Server = createHttp2Server();
    http2Server.on("session", (session) => sessions.add(session));
    http2Server.on("stream", (stream) => {
      stream.on("close", closed);
      received();
    });
    server = http2Server;
    shutdown = () => {
      sessions.forEach((session) => session.destroy());
      http2Server.close();
    };
  } else {
    const http1Server = createServer((request, response) => {
      request.on("close", closed);
      response.on("close", closed);
      received();
    });
    server = http1Server;
    shutdown = () => {
      http1Server.closeAllConnections();
      http1Server.close();
    };
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requestReceived, connectionClosed, close: shutdown };
}

let provider: Awaited<ReturnType<typeof hangingProvider>> | undefined;
afterEach(() => provider?.close());

const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise.then(() => "settled" as const),
    new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), ms)),
  ]);

/** Starts a run on the adapter, aborts it once the Provider has the request, and reports whether the connection closed. */
async function abortMidRequest(adapter: AnyTextAdapter, hanging: typeof provider & {}) {
  const abortController = new AbortController();
  const stream = chat({
    adapter,
    messages: [{ role: "user", content: "Hello" }],
    abortController,
  });
  void (async () => {
    for await (const _chunk of stream);
  })().catch(() => {});
  await hanging.requestReceived;
  abortController.abort();
  return within(hanging.connectionClosed, 2_000);
}

describe("aborting a run cancels the request to the Provider", () => {
  it("for Bedrock", async () => {
    provider = await hangingProvider("http2");
    const adapter = createAbortableBedrockText("us.anthropic.claude-sonnet-4-5-20250929-v1:0", {
      apiKey: "ABSK-test",
      region: "us-east-1",
      baseURL: provider.url,
    });

    expect(await abortMidRequest(adapter, provider)).toBe("settled");
  });

  it("for Mistral", async () => {
    provider = await hangingProvider();
    const adapter = createMistralText("mistral-medium-latest", "key-test", {
      baseURL: provider.url,
    });

    expect(await abortMidRequest(adapter, provider)).toBe("settled");
  });

  it("for Ollama", async () => {
    provider = await hangingProvider();
    const adapter = createOllamaChat("llama3.2:latest", provider.url);

    expect(await abortMidRequest(adapter, provider)).toBe("settled");
  });
});

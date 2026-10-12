import type { Server } from "node:http";

import { startFakeMcp } from "../../../packages/chat-sdk/test/e2e/fake-mcp";
import { startFakeOllama } from "../../../packages/chat-sdk/test/e2e/fake-ollama";

import {
  fakeMcpClientId,
  fakeMcpClientSecret,
  fakeMcpPort,
  fakeOllamaPort,
  mcpBaseURL,
} from "./env";

/** Waits until the MCP server (`start-server.ts` starts it) answers, so tests don't race it. */
async function untilServing(url: string) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`${url} never answered`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/**
 * Starts the fake Ollama host every test's Ollama credentials point at, and the fake MCP server
 * the MCP server offers; stops both after.
 */
export default async function globalSetup() {
  const ollama = await startFakeOllama(fakeOllamaPort);
  const mcp = await startFakeMcp({
    port: fakeMcpPort,
    clientId: fakeMcpClientId,
    clientSecret: fakeMcpClientSecret,
  });
  await untilServing(`${mcpBaseURL}/login`);
  return async () => {
    await Promise.all([close(ollama), close(mcp)]);
  };
}

import type { Server } from "node:http";

import { startFakeOllama } from "./support/fake-ollama";

import { fakeOllamaPort } from "./env";

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/** Starts the fake Ollama host every test's Ollama credentials point at; stops it after. */
export default async function globalSetup() {
  const ollama = await startFakeOllama(fakeOllamaPort);
  return async () => {
    await close(ollama);
  };
}

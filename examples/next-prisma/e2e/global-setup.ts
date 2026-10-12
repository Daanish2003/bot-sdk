import { startFakeOllama } from "../../../packages/chat-sdk/test/e2e/fake-ollama";

import { fakeOllamaPort } from "./env";

/** Starts the fake Ollama host every test's Ollama credentials point at; stops it after. */
export default async function globalSetup() {
  const server = await startFakeOllama(fakeOllamaPort);
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

import type { Page } from "@e2e-types/playwright-test";

/** A verified user with a password, as a Host's fixture seeds one. */
export type SeededUser = { id: string; name: string; email: string; password: string };

/**
 * What the shared end-to-end scenarios need from a Host. A Host writes one of these next to its own
 * tests and passes it to `registerSharedScenarios` (`scenarios.ts`). The scenarios import nothing
 * Host-specific, and they stay in this canonical repo: they are never copied (ADR 0005).
 */
export type HostFixture = {
  /** Writes a signed-in user straight into the Host's database, with no sign-up through the UI. */
  signIn(page: Page): Promise<SeededUser>;
  /** Where the fake Ollama host (`fake-ollama.ts`) listens, as the Host's Ollama credentials reach it. */
  fakeOllamaHost: string;
  paths: {
    /** The page for a new Conversation. */
    newConversation: string;
    /** The page for a saved Conversation. */
    conversation: RegExp;
    /** The Key settings page, where a Provider credential is added. */
    keys: string;
    /** A Shared link's address, as the share dialog shows it. */
    sharedLink: RegExp;
    /** The public page for a Shared link token. */
    shared(token: string): string;
    /** Where the chat handler is mounted, so a scenario can call its RPC (`<chatApi>/rpc/...`). */
    chatApi: string;
  };
};

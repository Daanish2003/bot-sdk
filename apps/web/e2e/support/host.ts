import type { Page } from "@playwright/test";

/** A verified user with a password, as a Host's fixture seeds one. */
export type SeededUser = { id: string; name: string; email: string; password: string };

/**
 * What the shared end-to-end page helpers (`chat-page.ts`) need from a Host. A Host writes one of
 * these next to its own tests. The helpers import nothing Host-specific, and they stay in this
 * canonical repo: they are never copied (ADR 0005).
 */
export type HostFixture = {
  /** Writes a signed-in user straight into the Host's database, with no sign-up through the UI. */
  signIn(page: Page): Promise<SeededUser>;
  /** Where the fake Ollama host (`fake-ollama.ts`) listens, as the Host's Ollama credentials reach it. */
  fakeOllamaHost: string;
  paths: {
    /** The Key settings page, where a Provider credential is added. */
    keys: string;
  };
};

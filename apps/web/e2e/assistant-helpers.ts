import { expect, type Page } from "@playwright/test";

import { chatPage } from "../../../packages/bot-sdk/test/e2e/chat-page";

import { appWebHost } from "./host";
import { type SeededUser } from "./seed-user";

// The helpers of the assistant-only specs (`/c`). They go with those specs in the deletion ticket
// (spec #813); no kept spec imports them.

const chat = chatPage(expect, appWebHost);

export const { messageRows, send } = chat;

/** Signs in as a new seeded, verified user on the new Conversation page. */
export async function signInAsSeededUser(page: Page): Promise<SeededUser> {
  const seeded = await appWebHost.signIn(page);
  await page.goto("/c");
  await expect(page).toHaveURL(/\/c$/);
  return seeded;
}

/** A seeded user with the fake Ollama, on the new Conversation page. */
export const signInAsSeededUserWithModel = chat.signInWithModel;

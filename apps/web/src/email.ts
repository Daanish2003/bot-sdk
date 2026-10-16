import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCaptureMailbox,
  createConsoleSender,
  createResendSender,
  type EmailSender,
} from "@ai-chat/email";

import { redisStore } from "@ai-chat/bot-sdk/core/server";

import { ENV } from "./env.server";

const transport = ENV.EMAIL_TRANSPORT ?? (ENV.NODE_ENV === "production" ? "resend" : "console");

export const appName = ENV.APP_NAME ?? "AI Chat";
const from = ENV.EMAIL_FROM ?? "AI Chat <no-reply@example.com>";

// Kept in memory, or in Redis when REDIS_URL is set so every process reads the same mailbox. Only the
// test-only mailbox route reads it, and only when the transport is capture.
export const mailbox = createCaptureMailbox({
  from,
  store: ENV.REDIS_URL ? redisStore({ url: ENV.REDIS_URL, prefix: "mail:" }) : undefined,
});

export const sender: EmailSender = (() => {
  if (transport === "capture") return mailbox.sender;
  if (transport === "resend") {
    if (!ENV.RESEND_API_KEY) throw new Error("EMAIL_TRANSPORT=resend needs RESEND_API_KEY");
    return createResendSender({ apiKey: ENV.RESEND_API_KEY, from });
  }
  return createConsoleSender({ from, outDir: join(tmpdir(), "ai-chat-email-preview") });
})();

export const captureEnabled = transport === "capture";

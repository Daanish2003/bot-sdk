import type { MessagingAdapter } from "@botsdk/bot/channel";

/**
 * A number as E.164: a plus and 8 to 15 digits, the first not 0. An owner may type it with spaces,
 * dashes, dots or brackets, which are dropped. Null for anything else.
 */
export function voiceNumber(typed: string): string | null {
  const number = typed.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(number) ? number : null;
}

/** The `voice` platform: its Channel accounts' `platform`, and the adapter's id. */
export const voicePlatform = "voice";

type Field = "number" | "greeting" | "secret";

/**
 * The `voice` messaging adapter (ticket #1381, ADR 0036): it exists so a voice account can be a Channel
 * account, which can't exist without a registered adapter. A Call runs on a Voice agent outside the
 * product, so the adapter neither sends nor receives messages: it has no listener or webhook, and a
 * send is an error. It checks the number is E.164 and is its platform id. Its credentials are the
 * number, the greeting and the secret the Voice agent's hooks authenticate with; the Representative
 * feature makes the secret, so no form asks for it, and no LiveKit or Telnyx key is kept. A Host adds
 * it to its `channels` beside the SMS adapter.
 */
export function voice(): MessagingAdapter<Field> {
  return {
    kind: "messaging",
    id: voicePlatform,
    credentialFields: ["number", "greeting", "secret"],
    plainCredentialFields: ["number", "greeting"],
    limits: { download: 0, upload: 0 },
    canStartConversation: false,

    async check({ number }) {
      const checked = voiceNumber(number);
      if (!checked) return { rejected: "The number isn't in E.164 format, such as +15551234567" };
      return { platformBotId: checked, handle: checked };
    },

    async send() {
      throw new Error("A voice account sends no messages");
    },

    async editButtons() {},

    async download() {
      throw new Error("A voice account carries no files");
    },

    deepLink: () => null,
  };
}

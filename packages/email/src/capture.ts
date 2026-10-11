import { createHash } from "node:crypto";

import { checkHeaders, type EmailMessage, type EmailSender } from "./sender";
import type { TemplateName } from "./templates";

// End-to-end sender: keeps each message for ten minutes so a test can read the
// link back through the test-only mailbox route. Messages are kept per
// recipient under a hash of the lowercased address, so no raw address is a key.
export const CAPTURE_TTL_MS = 10 * 60 * 1000;

export type CapturedMessage = {
  template: TemplateName;
  subject: string;
  text: string;
  sentAt: number;
};

export type CaptureMailbox = {
  sender: EmailSender;
  read(address: string): Promise<CapturedMessage[]>;
};

/**
 * Where the mailbox keeps each recipient's messages. Redis serves every app instance (the mailbox
 * must be readable through any of them); the memory store serves one process.
 */
export type CaptureStore = {
  get(key: string): Promise<string | null>;
  /** Stores a value that expires after `ttlSeconds`. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
};

/** One process's store: values are kept in memory until they expire. `keys()` is for tests. */
export function createMemoryCaptureStore(now: () => number = Date.now): CaptureStore & {
  keys(): string[];
} {
  const values = new Map<string, { value: string; expiresAt: number }>();

  function live(key: string) {
    const entry = values.get(key);
    if (!entry) return undefined;
    if (now() >= entry.expiresAt) {
      values.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ttlSeconds) {
      values.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
    },
    keys() {
      return [...values.keys()].filter((key) => live(key) !== undefined);
    },
  };
}

function keyOf(address: string): string {
  return createHash("sha256").update(address.trim().toLowerCase()).digest("hex");
}

export function createCaptureMailbox({
  from,
  store = createMemoryCaptureStore(),
  now = Date.now,
}: {
  from: string;
  store?: CaptureStore;
  now?: () => number;
}): CaptureMailbox {
  // The messages of one recipient still inside the ten minutes; the store expires the box itself too.
  async function liveMessagesOf(address: string): Promise<CapturedMessage[]> {
    const raw = await store.get(keyOf(address));
    if (!raw) return [];
    const cutoff = now() - CAPTURE_TTL_MS;
    return (JSON.parse(raw) as CapturedMessage[]).filter((message) => message.sentAt > cutoff);
  }

  return {
    sender: {
      async send(message: EmailMessage) {
        checkHeaders(message, from);
        const captured: CapturedMessage = {
          template: message.template,
          subject: message.subject,
          text: message.text,
          sentAt: now(),
        };
        const messages = [...(await liveMessagesOf(message.to)), captured];
        await store.set(keyOf(message.to), JSON.stringify(messages), CAPTURE_TTL_MS / 1000);
      },
    },
    read: liveMessagesOf,
  };
}

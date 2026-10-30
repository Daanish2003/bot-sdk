import { z } from "zod";

import {
  CredentialsRejectedError,
  type EmailProvider,
  type InboundMail,
  type MessagingAccount,
  type MessagingAdapter,
  type MessagingFile,
  MessagingFileTooLargeError,
  type MessagingUpdate,
  type OutboundMail,
  type OutboundMessage,
  type PushNotification,
  type PushProvider,
  type PushSubscriptionKeys,
} from "@botsdk/bot/channel/internal";

const verdict = z.enum(["pass", "fail", "none"]);

/** A mail as the fake takes it: `from` and `to` are needed, every other field has a default. */
const fakeMailSchema = z.object({
  from: z.string(),
  to: z.array(z.string()),
  messageId: z.string().default(""),
  subject: z.string().default(""),
  text: z.string().default(""),
  headers: z.record(z.string(), z.string()).default({}),
  attachments: z.array(z.string()).default([]),
  files: z
    .array(z.object({ name: z.string(), contentType: z.string(), base64: z.string() }))
    .optional()
    .transform((files) =>
      files?.map((file) => {
        const content = Uint8Array.from(Buffer.from(file.base64, "base64"));
        return {
          name: file.name,
          contentType: file.contentType,
          size: content.byteLength,
          read: async () => content,
        };
      }),
    ),
  authentication: z
    .object({ spf: verdict, dkim: verdict, dmarc: verdict })
    .default({ spf: "none", dkim: "none", dmarc: "none" }),
}) satisfies z.ZodType<InboundMail, unknown>;

/**
 * A fake email provider (spec #761), for tests and for a Host with no mail service: an inbound
 * request's body is the mail as JSON (`request` builds one), and each sent mail is kept in `sent`.
 * It takes the body's `authentication` as it is, so it vouches for whatever it is sent: a Host
 * mounts it only where nobody else can reach the inbound route.
 */
export function fakeEmailProvider(): {
  provider: EmailProvider;
  sent: OutboundMail[];
  /**
   * A request to the inbound route carrying `mail`, its fields defaulted, and `files` as its
   * attachments (named in `attachments` too).
   */
  request: (
    mail?: Partial<Omit<InboundMail, "files">>,
    files?: { name: string; contentType: string; content: string | Uint8Array }[],
  ) => Request;
} {
  const sent: OutboundMail[] = [];
  const provider: EmailProvider = {
    parseInbound: async (request) => {
      const body: unknown = await request.json().catch(() => undefined);
      const mail = fakeMailSchema.safeParse(body);
      return mail.success ? mail.data : { rejected: "The body isn't a JSON mail" };
    },
    send: async (mail) => {
      sent.push(mail);
    },
  };
  const request = (
    mail: Partial<Omit<InboundMail, "files">> = {},
    files?: { name: string; contentType: string; content: string | Uint8Array }[],
  ) =>
    new Request("http://localhost/api/chat/channels/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "",
        to: [],
        ...mail,
        ...(files && {
          attachments: files.map((file) => file.name),
          files: files.map((file) => ({
            name: file.name,
            contentType: file.contentType,
            base64: Buffer.from(file.content).toString("base64"),
          })),
        }),
      }),
    });
  return { provider, sent, request };
}

/**
 * A fake web push provider (spec #1024), for tests: each push is kept in `sent`. A push to an
 * endpoint in `gone` answers as a dead subscription (404 or 410), and one in `failing` throws, as
 * a push service that refused it.
 */
export function fakePushProvider(): {
  provider: PushProvider;
  sent: { subscription: PushSubscriptionKeys; notification: PushNotification }[];
  gone: Set<string>;
  failing: Set<string>;
} {
  const sent: { subscription: PushSubscriptionKeys; notification: PushNotification }[] = [];
  const gone = new Set<string>();
  const failing = new Set<string>();
  const provider: PushProvider = {
    publicKey: "BFakeVapidPublicKey",
    send: async (subscription, notification) => {
      if (failing.has(subscription.endpoint)) throw new Error("The push service refused the push");
      if (gone.has(subscription.endpoint)) return "gone";
      sent.push({ subscription, notification });
      return "sent";
    },
  };
  return { provider, sent, gone, failing };
}

/** One listener the fake messaging adapter runs: its account, until its signal aborts. */
type FakeListener = {
  account: MessagingAccount<"token">;
  receive: (update: MessagingUpdate) => Promise<void>;
  /** Ends the listener as the platform would on revoked credentials. */
  reject: (reason: string) => void;
};

/**
 * A fake messaging adapter (spec #1044), for tests: a platform whose bot tokens are `<id>:<secret>`
 * (`platformBotId` is the part before the colon, the handle `@bot_<id>`). Its listeners are kept in
 * `listening`, by handle, and `deliver` hands an update to one as the platform would. It records
 * every send, edit and download. A token in `rejected` is refused by `check` and by `listen`;
 * `revoke` also ends a running listener that way. `failures` makes the next listens throw a
 * network error.
 */
export function fakeMessagingAdapter({ id = "fake" }: { id?: string } = {}) {
  const listening = new Map<string, FakeListener>();
  const sends: { account: MessagingAccount<"token">; message: OutboundMessage }[] = [];
  const edits: {
    account: MessagingAccount<"token">;
    target: { chatId: string; messageId: string; chosen: string | null };
  }[] = [];
  const downloads: { account: MessagingAccount<"token">; file: MessagingFile }[] = [];
  /** The bytes `download` returns, by file id. */
  const files = new Map<string, Uint8Array>();
  const rejected = new Set<string>();
  /** How many listens started, and how many network failures the next listens (`failures`) and sends (`sendFailures`) throw. */
  const counts = { listens: 0, failures: 0, sendFailures: 0 };
  let nextMessageId = 1;

  const botOf = (token: string) => {
    const platformBotId = token.split(":")[0] ?? token;
    return { platformBotId, handle: `@bot_${platformBotId}` };
  };

  const adapter: MessagingAdapter<"token"> = {
    kind: "messaging",
    id,
    credentialFields: ["token"],
    limits: { download: 20 * 1024 * 1024, upload: 50 * 1024 * 1024 },
    check: async ({ token }) =>
      rejected.has(token) || !token.includes(":") ? { rejected: "Unauthorized" } : botOf(token),
    listen: (account, { signal, receive }) => {
      counts.listens += 1;
      if (counts.failures > 0) {
        counts.failures -= 1;
        return Promise.reject(new Error("fetch failed: ECONNRESET"));
      }
      if (rejected.has(account.credentials.token)) {
        return Promise.reject(new CredentialsRejectedError("Unauthorized"));
      }
      return new Promise<void>((resolve, reject) => {
        const listener: FakeListener = {
          account,
          receive,
          reject: (reason) => {
            listening.delete(account.handle);
            reject(new CredentialsRejectedError(reason));
          },
        };
        listening.set(account.handle, listener);
        signal.addEventListener("abort", () => {
          if (listening.get(account.handle) === listener) listening.delete(account.handle);
          resolve();
        });
      });
    },
    send: async (account, message) => {
      if (rejected.has(account.credentials.token))
        throw new CredentialsRejectedError("Unauthorized");
      if (counts.sendFailures > 0) {
        counts.sendFailures -= 1;
        throw new Error("fetch failed: ECONNRESET");
      }
      sends.push({ account, message });
      const messageId = String(nextMessageId++);
      return {
        messageIds: [messageId],
        ...(message.buttons && { buttonsMessageId: messageId }),
      };
    },
    editButtons: async (account, target) => {
      edits.push({ account, target });
    },
    download: async (account, file, { maxBytes }) => {
      downloads.push({ account, file });
      const content = files.get(file.id) ?? new Uint8Array();
      if (content.byteLength > maxBytes) throw new MessagingFileTooLargeError(maxBytes);
      return content;
    },
    deepLink: ({ handle }, code) => `https://fake.example/${handle.slice(1)}?start=${code}`,
  };

  return {
    adapter,
    listening,
    sends,
    edits,
    downloads,
    files,
    rejected,
    counts,
    /** Revokes `token`: `check` refuses it, and a listener on it ends with a rejection. */
    revoke: (token: string) => {
      rejected.add(token);
      for (const listener of listening.values()) {
        if (listener.account.credentials.token === token) listener.reject("Unauthorized");
      }
    },
    /**
     * Hands an update to the listener of the account `handle`, as the platform would, its fields
     * defaulted to a private text message; resolves once the core's `receive` does.
     */
    deliver: async (handle: string, update: Partial<MessagingUpdate> = {}) => {
      const listener = listening.get(handle);
      if (!listener) throw new Error(`Nothing listens to ${handle}`);
      await listener.receive({
        sourceId: String(nextMessageId++),
        sender: { id: "1001", handle: "@ada" },
        chat: { id: "1001", private: true },
        text: "",
        files: [],
        ...update,
      });
    },
  };
}

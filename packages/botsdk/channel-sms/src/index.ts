import { createPublicKey, verify } from "node:crypto";

import { PermanentJobError } from "@botsdk/bot";
import { CredentialsRejectedError } from "@botsdk/bot/channel";
import type {
  MessagingAccount,
  MessagingAdapter,
  MessagingCall,
  MessagingUpdate,
  OutboundMessage,
  SentMessage,
} from "@botsdk/bot/channel";
import { blocksText, plainText } from "@botsdk/client/message-format";

import { fitWithTail, gsmLimit } from "./segments";

export { cutMarker, fitSegments, measure } from "./segments";

/** Telnyx's API host. A Host may point the adapter elsewhere, such as the lab phone. */
export const defaultApiBase = "https://api.telnyx.com";

/** How old a webhook's timestamp may be, in seconds, before the request is refused as a replay. */
const toleranceSeconds = 5 * 60;

/** The DER prefix of an Ed25519 public key (SPKI), before its 32 raw bytes. */
const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");

/**
 * A failed Telnyx call that isn't about the credentials: the core retries it. A send Telnyx refuses
 * for good is a `PermanentJobError` instead (`isRefusal`).
 */
export class TelnyxApiError extends Error {
  readonly status: number;

  constructor(path: string, status: number, detail: string) {
    super(`Telnyx ${path} failed (${status}): ${detail}`);
    this.name = "TelnyxApiError";
    this.status = status;
  }
}

/**
 * Whether Telnyx refused a request for good: a 4xx other than a timeout (408) or a rate limit (429),
 * such as an invalid `to` or a number that texted STOP. Retrying it would fail the same way.
 */
const isRefusal = (status: number) =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;

type Account = MessagingAccount<"apiKey" | "publicKey" | "number">;

type Envelope<Data> = { data?: Data; errors?: { title?: string; detail?: string }[] };

async function callApi<Data>(
  apiBase: string,
  apiKey: string,
  path: string,
  body: Record<string, unknown> | null,
  { fetch: fetcher, signal }: MessagingCall,
  rejectsOn: readonly number[],
): Promise<Data | undefined> {
  const response = await fetcher(`${apiBase}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body && { "content-type": "application/json" }),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const envelope = (await response.json().catch(() => ({}))) as Envelope<Data>;
  const error = envelope.errors?.[0];
  const detail = error?.detail ?? error?.title ?? response.statusText ?? "no description";
  if (rejectsOn.includes(response.status)) {
    throw new CredentialsRejectedError(error?.title || response.statusText || "Rejected");
  }
  if (!response.ok) throw new TelnyxApiError(path, response.status, detail);
  return envelope.data;
}

/** The webhook public key (base64 of 32 raw bytes) as a key object, or null when it isn't one. */
function publicKey(base64: string) {
  const raw = Buffer.from(base64.trim(), "base64");
  if (raw.length !== 32) return null;
  return createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: "der", type: "spki" });
}

type InboundEvent = {
  data?: {
    event_type?: string;
    payload?: {
      id?: string;
      text?: string;
      from?: { phone_number?: string };
      to?: { phone_number?: string }[];
    };
  };
};

/** A number as Telnyx writes it, E.164: an owner may type it with spaces, dashes, dots or brackets. */
const e164 = (number: string) => number.replace(/[\s().-]/g, "").replace(/^00/, "+");

/**
 * The Telnyx SMS messaging adapter (spec #1174) over Telnyx's v2 API with plain `fetch` and
 * `node:crypto`: `check` looks the number up, the webhook takes `message.received` events, and
 * `send` posts to `/v2/messages`. Its Channel id is `sms`, which the Outbound gate's opt-out words
 * are keyed by.
 */
export function sms({
  apiBase = defaultApiBase,
}: {
  /** The API's base URL, such as the lab phone's. */
  apiBase?: string;
} = {}): MessagingAdapter<"apiKey" | "publicKey" | "number"> {
  const base = apiBase.replace(/\/+$/, "");

  return {
    kind: "messaging",
    id: "sms",
    // Numbers can be spoofed, so `verifiesSender` is left out.
    credentialFields: ["apiKey", "publicKey", "number"],
    // The number is no secret, so the owner sees what they type (an E.164 typo is easy to make).
    plainCredentialFields: ["number"],
    // No files: MMS for Customers is out of scope.
    limits: { download: 0, upload: 0 },
    // In the lab a business has to be registered to start a conversation; there is no reply window.
    canStartConversation: false,
    maxLength: gsmLimit,
    // The send below cuts a longer reply itself, so the Outbound gate must pass it.
    cutsLongMessages: true,

    async check({ apiKey, publicKey: key, number: typed }, call) {
      const number = e164(typed);
      if (!publicKey(key)) return { rejected: "The webhook public key isn't a base64 Ed25519 key" };
      try {
        const found = await callApi<unknown[]>(
          base,
          apiKey,
          `/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(number)}&page[size]=1`,
          null,
          call,
          [401, 403],
        );
        if (!found || found.length === 0) return { rejected: "The number isn't on the account" };
        return { platformBotId: number, handle: number };
      } catch (error) {
        if (error instanceof CredentialsRejectedError) return { rejected: error.reason };
        throw error;
      }
    },

    async webhook(account, { headers, body }) {
      const key = publicKey(account.credentials.publicKey);
      const signature = headers.get("telnyx-signature-ed25519");
      const timestamp = headers.get("telnyx-timestamp");
      if (!key || !signature || !timestamp) return { rejected: "Missing signature" };
      const age = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (!/^\d+$/.test(timestamp) || age > toleranceSeconds)
        return { rejected: "Stale timestamp" };
      const signed = verify(
        null,
        Buffer.from(`${timestamp}|${body}`),
        key,
        Buffer.from(signature, "base64"),
      );
      if (!signed) return { rejected: "Bad signature" };
      let event: InboundEvent;
      try {
        event = JSON.parse(body) as InboundEvent;
      } catch {
        return { rejected: "Unreadable body" };
      }
      const payload = event.data?.payload;
      const from = payload?.from?.phone_number;
      // Media is ignored (MMS is out of scope), so a media-only message has no text and is dropped.
      if (event.data?.event_type !== "message.received" || !payload?.id || !from) {
        return { updates: [] };
      }
      // The profile may serve several numbers: a message to another one is not this account's.
      const to = payload.to ?? [];
      if (to.length > 0 && !to.some((t) => t.phone_number === e164(account.credentials.number))) {
        return { updates: [] };
      }
      const text = payload.text ?? "";
      if (!text.trim()) return { updates: [] };
      const update: MessagingUpdate = {
        sourceId: payload.id,
        sender: { id: from, handle: from },
        chat: { id: from, private: true },
        text,
        files: [],
      };
      return { updates: [update] };
    },

    async send(account: Account, message: OutboundMessage, call): Promise<SentMessage> {
      const text = fitWithTail(
        plainText(message.text),
        message.control ? blocksText(message.control) : "",
      );
      // Nothing to say (a Message of only a file): Telnyx refuses empty text, and a retry would too.
      if (!text.trim()) return { messageIds: [] };
      // Telnyx joins a long text into one multipart SMS itself, so one request is one reply and a
      // failure leaves nothing half-sent: no MessagingSendError, the core simply retries, unless
      // Telnyx refused it for good.
      const sent = await callApi<{ id: string }>(
        base,
        account.credentials.apiKey,
        "/v2/messages",
        { from: e164(account.credentials.number), to: message.chatId, text },
        call,
        [401],
      ).catch((error: unknown) => {
        if (error instanceof TelnyxApiError && isRefusal(error.status)) {
          throw new PermanentJobError(error.message);
        }
        throw error;
      });
      return { messageIds: sent?.id ? [sent.id] : [] };
    },

    // SMS has no buttons: a control's options are written into the text.
    async editButtons() {},

    async download() {
      throw new Error("SMS carries no files");
    },

    deepLink: () => null,
  };
}

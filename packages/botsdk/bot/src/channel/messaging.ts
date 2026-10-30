/**
 * What a messaging adapter's call throws when the platform rejects the Channel account's
 * credentials (a revoked or wrong token: Telegram's 401 or 403). The listener stops, and the account
 * needs attention until the user saves new credentials; nothing retries it.
 */
export class CredentialsRejectedError extends Error {
  /** A short reason the user is shown, such as "Unauthorized". */
  readonly reason: string;

  constructor(reason: string) {
    super(`The platform rejected the Channel account's credentials: ${reason}`);
    this.name = "CredentialsRejectedError";
    this.reason = reason;
  }
}

/**
 * What a messaging adapter's `send` throws when a part of a Message fails after others were sent
 * (a long text split into numbered parts, or text and files): what it sent so far. The core keeps
 * it, and the retry passes it back as the Message's `resume`, so the user gets each part once.
 */
export class MessagingSendError extends Error {
  readonly progress: SendProgress;

  constructor(progress: SendProgress, cause: unknown) {
    super(
      `Sending a Message failed after ${progress.parts} of its parts: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "MessagingSendError";
    this.progress = progress;
  }
}

/** What a messaging adapter's `download` throws past its `maxBytes`: the file is left out. */
export class MessagingFileTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`The file is larger than ${maxBytes} bytes`);
    this.name = "MessagingFileTooLargeError";
  }
}

/** A Channel account as its adapter gets it: the platform bot and its decrypted credentials. */
export type MessagingAccount<Field extends string = string> = {
  /** The Channel account's id. */
  id: string;
  /** The Bot it belongs to. */
  botId: string;
  /** The platform's id of the platform bot. */
  platformBotId: string;
  /** The platform bot's display handle, such as `@ada_bot`. */
  handle: string;
  /** The credentials the user saved, one value per field of `credentialFields`. */
  credentials: Record<Field, string>;
};

/** One file of an inbound update. Its bytes are downloaded only once the sender is known. */
export type MessagingFile = {
  /** The platform's reference to the file, which `download` takes. */
  id: string;
  name: string;
  contentType: string;
  /** Its size in bytes, or `null` when the platform doesn't say. */
  size: number | null;
  kind: "photo" | "document" | "voice" | "audio";
};

/**
 * One inbound update for a Channel account, normalised by its adapter (spec #1044): a message the
 * sender wrote, or a press of one of the Bot's buttons.
 */
export type MessagingUpdate = {
  /**
   * The update's id on the platform, unique within the Channel account (Telegram's message id, or
   * its callback query id for a press): a resent update has the same one.
   */
  sourceId: string;
  /** Who sent it: the platform's user id and a display handle, such as `@ada`. */
  sender: { id: string; handle: string; workspace?: string };
  /** The chat it came in, and whether it is a private chat with the platform bot. */
  chat: { id: string; private: boolean };
  /** The text or caption, as the sender wrote it; empty for a file alone or a press. */
  text: string;
  files: MessagingFile[];
  /**
   * A press of a button the Bot sent: the control's reference, the option pressed and the platform's
   * id of the message that carries the button, which `editButtons` takes.
   */
  press?: { control: string; option: string; messageId: string };
};

/** A row of buttons under a Message: a control's options, each pressed to answer it. */
export type MessagingButtons = {
  /** The control's reference, which a press carries back. */
  control: string;
  options: { option: string; label: string }[];
};

/** One Bot Message as the core hands it to the adapter to send. */
export type OutboundMessage = {
  chatId: string;
  /** Markdown; converting it to the platform's markup and splitting it are the adapter's job. */
  text: string;
  buttons?: MessagingButtons;
  /** Files sent with it, each within the adapter's `limits.upload`. */
  files?: { name: string; contentType: string; content: Uint8Array }[];
  /**
   * What an earlier `send` of this Message sent before it failed (`MessagingSendError`): the adapter
   * sends only the parts after it, and reports them after its message ids.
   */
  resume?: SendProgress;
};

/** What the adapter sent for one Message: the platform's message ids, in order. */
export type SentMessage = {
  messageIds: string[];
  /** The id of the message that carries the buttons, when there were any. */
  buttonsMessageId?: string;
};

/**
 * How far a `send` got: how many of the Message's parts it sent (its text parts in order, then
 * its files), and their message ids. `pieces`: how many messages of the next part it sent, for an
 * adapter that sends a part as several (Telegram's plain resend of text it can't parse).
 */
export type SendProgress = { parts: number; pieces?: number; sent: SentMessage };

/** What every adapter call gets: the SDK's `fetch` and, when it can be stopped, a signal. */
export type MessagingCall = { fetch: typeof fetch; signal?: AbortSignal };

/**
 * A messaging adapter (spec #1044): the wire format of one messaging platform, such as Telegram,
 * as the `channels` slot takes it. It receives updates for one Channel account, sends one Message,
 * edits a sent Message's buttons, downloads one inbound file and checks credentials. The core keeps
 * the accounts, decides who an update is from and what a Message holds. A call the platform refuses
 * for the credentials throws `CredentialsRejectedError`; any other throw is retried, and a `send`
 * that fails after sending some parts throws `MessagingSendError` so the retry resumes after them.
 */
export type MessagingAdapter<Field extends string = string> = {
  kind: "messaging";
  /** The platform, such as `telegram`: a Trigger and a Message from it record it as their Channel. */
  id: string;
  /** The credentials a Channel account takes, by field name, such as `["token"]`. */
  credentialFields: readonly Field[];
  /** The platform's file limits, in bytes: what `download` can fetch, and what `send` can send. */
  limits: { download: number; upload: number };
  /**
   * Checks `credentials` with the platform: the platform bot's id and display handle, or why the
   * platform rejected them. Throws when the platform can't be reached.
   */
  check(
    credentials: Record<Field, string>,
    call: MessagingCall,
  ): Promise<{ platformBotId: string; handle: string } | { rejected: string }>;
  /**
   * Listens for the account's updates (Telegram: long polling) and hands each to `receive`, one at
   * a time, confirming it to the platform only once `receive` resolves. Resolves once `signal`
   * aborts. An adapter whose platform only posts to a webhook has none.
   */
  listen?(
    account: MessagingAccount<Field>,
    options: MessagingCall & {
      signal: AbortSignal;
      receive: (update: MessagingUpdate) => Promise<void>;
    },
  ): Promise<void>;
  /** Sends one Message, split and converted as the platform needs, and reports what it sent. */
  send(
    account: MessagingAccount<Field>,
    message: OutboundMessage,
    call: MessagingCall,
  ): Promise<SentMessage>;
  /**
   * Edits the buttons of a sent message: removes them, showing `chosen` when given (the option the
   * user picked).
   */
  editButtons(
    account: MessagingAccount<Field>,
    target: { chatId: string; messageId: string; chosen: string | null },
    call: MessagingCall,
  ): Promise<void>;
  /** Downloads an inbound file's bytes; throws `MessagingFileTooLargeError` past `maxBytes`. */
  download(
    account: MessagingAccount<Field>,
    file: MessagingFile,
    call: MessagingCall & { maxBytes: number },
  ): Promise<Uint8Array>;
  /**
   * A link that opens a chat with the platform bot carrying `code` (Telegram:
   * `https://t.me/<username>?start=<code>`), or `null` when the platform has none.
   */
  deepLink(
    account: Pick<MessagingAccount, "platformBotId" | "handle">,
    code: string,
  ): string | null;
};

/** Whether a `channels` slot adapter is a messaging adapter. */
export function isMessagingAdapter(adapter: { id: string }): adapter is MessagingAdapter {
  return "kind" in adapter && adapter.kind === "messaging";
}

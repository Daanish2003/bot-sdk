import type { Logger } from "../create-chat";

/** One `chat.usage` row, as the SDK wrote it (ADR 0007). */
export type UsageEvent = {
  id: string;
  userId: string;
  kind:
    | "run"
    | "title"
    | "web_search"
    | "transcription"
    | "image"
    | "embedding"
    | "memory"
    | "turn"
    | "helper"
    | "summary"
    | "warm";
  /** The `"provider:model"` id, `"tavily"` for a web search, or the transcription or image model's id. */
  model: string;
  /** Every input token, cache reads and writes included. */
  inputTokens: number;
  outputTokens: number;
  /** The input tokens read from the Provider's prompt cache. */
  cacheReadTokens: number;
  /** The input tokens written to the Provider's prompt cache. */
  cacheWriteTokens: number;
  /** The Bot Turn or Helper (or, for warming, the Bot) a Model call was made for, else `null`. */
  sourceId: string | null;
  /** The hash of each section of the prompt a Model call sent, else `null`. */
  promptHashes: { name: string; hash: string }[] | null;
  /** The cost in millionths of a US dollar. */
  costMicros: number;
  estimated: boolean;
  createdAt: Date;
};

/** How a Run ended. `awaiting_approval` is a Run that stopped waiting for a decision (ADR 0008). */
export type RunEnding = "complete" | "stopped" | "error" | "awaiting_approval";

/** A Run's ending, once it is written (#265). Never carries Message text. */
export type RunEndEvent = {
  userId: string;
  conversationId: string;
  messageId: string;
  /** `<messageId>` for a Message's first Run, `<messageId>:<n>` after an Approval (ADR 0006). */
  runId: string;
  ending: RunEnding;
  /** `timed_out`, `interrupted`, or a Provider's error reason. */
  reason?: string;
  /** The `"provider:model"` id the Run used. */
  model: string;
  onHostCredentials: boolean;
  /** Whether the output check hid the reply (#268): its text is gone and the Run's ending is as it was. */
  hidden: boolean;
};

/** A Conversation a user started, or continued from a Shared link (#266). */
export type ConversationCreatedEvent = {
  userId: string;
  conversationId: string;
  projectId?: string;
  fromSharedLink: boolean;
};

/** A Conversation a user deleted, or one of a deleted Project's (#266). */
export type ConversationDeletedEvent = {
  userId: string;
  conversationId: string;
  projectId?: string;
};

/** A Shared link created, moved to the current Branch, or removed (#266). */
export type SharedLinkChangedEvent = {
  userId: string;
  conversationId: string;
  change: "created" | "moved" | "removed";
};

/** An attachment the input check sees: image and text Attachments only (#267). */
export type ModerationAttachment = {
  name: string;
  mediaType: string;
  read: () => Promise<Uint8Array>;
};

/** The user's Message before it is saved (`phase: "input"`), checked before any Run starts (#267). */
export type ModerationInput = {
  phase: "input";
  userId: string;
  conversationId: string;
  onHostCredentials: boolean;
  text: string;
  attachments: ModerationAttachment[];
};

/** The text one Run produced, checked when it ends (`phase: "output"`) (#267). */
export type ModerationOutput = {
  phase: "output";
  userId: string;
  conversationId: string;
  messageId: string;
  runId: string;
  onHostCredentials: boolean;
  /** The reply text, without reasoning or tool-call arguments. */
  text: string;
};

/** The Host's answer to `moderate`: let the text through, or refuse it with the Host's reason. */
export type ModerationResult = { allow: true } | { allow: false; reason?: string };

/**
 * The Host's callbacks into the SDK (`createBotSdk({ hooks })`). Every one is optional. An event hook
 * is called after its change is written, never awaited, at most once, and never retried; one that
 * throws or rejects is logged through the Host's `logger`.
 *
 * `moderate` is typed now and wired by #267.
 */
export type EventHooks = {
  /** Fires after each usage row on Host credentials is written: a Run, a title, a web search, a transcription or a generated image. */
  onUsage?: (usage: UsageEvent) => unknown;
  /** Fires once for every Run, whichever way it ends, after the ending is written (#265). */
  onRunEnd?: (run: RunEndEvent) => unknown;
  /** Fires when a user starts a Conversation, or continues a Shared link into one (#266). */
  onConversationCreated?: (conversation: ConversationCreatedEvent) => unknown;
  /** Fires when a user deletes a Conversation, or once per Conversation of a deleted Project (#266). */
  onConversationDeleted?: (conversation: ConversationDeletedEvent) => unknown;
  /** Fires when a Shared link is created, moved or removed (#266). */
  onSharedLinkChanged?: (link: SharedLinkChangedEvent) => unknown;
  /**
   * Checks the user's Message before it is saved (`phase: "input"`) and each Run's text when it
   * ends (`phase: "output"`). `allow: false` refuses it (#267). It fails open: a throw, a rejection
   * or a 10-second timeout lets the text through and is logged.
   */
  moderate?: (
    check: ModerationInput | ModerationOutput,
  ) => ModerationResult | Promise<ModerationResult>;
};

type HookName = keyof EventHooks;
type HookPayload<K extends HookName> = Parameters<NonNullable<EventHooks[K]>>[0];

/** The optional `projectId` of an event: left out when the Conversation has no Project. */
export function withProjectId(projectId: string | null | undefined): { projectId?: string } {
  return projectId ? { projectId } : {};
}

/** How long the Host's `moderate` may take before the text goes through (#267). */
export const moderationTimeoutMs = 10_000;

/** Calls the Host's hooks. Used by the SDK after each change it writes. */
export type HookEmitter = {
  fire: <K extends HookName>(name: K, payload: HookPayload<K>) => void;
  /**
   * The Host's verdict on a text (`moderate`), raced against `moderationTimeoutMs`. A throw, a
   * rejection or a timeout lets the text through and is logged. With no `moderate`, nothing is called.
   */
  moderate: (check: ModerationInput | ModerationOutput) => Promise<ModerationResult>;
};

/** The emitter for a Host's hooks; a missing hook is a no-op. */
export function createHookEmitter(hooks: EventHooks | undefined, logger: Logger): HookEmitter {
  return {
    fire(name, payload) {
      if (!hooks?.[name]) return;
      // Started a microtask later, so a sync throw and an async rejection both land in `catch`.
      // Called as a method of `hooks`, so a hook that uses `this` keeps it.
      void Promise.resolve()
        .then(() => (hooks[name] as (payload: unknown) => unknown)(payload))
        .catch((error: unknown) => logger.error(`The Host's ${name} hook failed`, error));
    },
    moderate(check) {
      const allowed: ModerationResult = { allow: true };
      if (!hooks?.moderate) return Promise.resolve(allowed);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The Host's moderate hook took over ${moderationTimeoutMs} ms`)),
          moderationTimeoutMs,
        );
      });
      // Called as a method of `hooks`, like the event hooks.
      const verdict = Promise.resolve().then(() => hooks.moderate!.call(hooks, check));
      return Promise.race([verdict, deadline])
        .then((result) => (result?.allow === false ? result : allowed))
        .catch((error: unknown) => {
          logger.error("The Host's moderate hook failed; the text goes through", error);
          return allowed;
        })
        .finally(() => clearTimeout(timer));
    },
  };
}

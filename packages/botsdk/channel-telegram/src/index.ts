import { CredentialsRejectedError, MessagingFileTooLargeError } from "@botsdk/bot/channel";
import type {
  MessagingAccount,
  MessagingAdapter,
  MessagingButtons,
  OutboundMessage,
  SentMessage,
} from "@botsdk/bot/channel";

import { callApi, defaultApiBase, TelegramApiError } from "./api";

export { TelegramApiError };
import { splitParts } from "./markdown";
import { callbackSeparator, normalise, type TelegramUpdate } from "./normalise";

/** Telegram's limits for a bot: `getFile` downloads up to 20 MB, uploads go up to 50 MB. */
const limits = { download: 20 * 1024 * 1024, upload: 50 * 1024 * 1024 };

/** How long `getUpdates` waits for an update, in seconds. */
const pollTimeoutSeconds = 30;

/** A button's callback data may be at most 64 bytes. */
const callbackDataLimit = 64;

/** How many times in a row `receive` may fail on one update before the poll goes past it. */
const maxReceiveFailures = 3;

const sleep = (seconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, seconds * 1000);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

type Account = MessagingAccount<"token">;

function keyboard({ control, options }: MessagingButtons) {
  const row = options.map(({ option, label }) => {
    const data = `${control}${callbackSeparator}${option}`;
    if (new TextEncoder().encode(data).length > callbackDataLimit) {
      throw new Error(`The callback data of "${label}" is over ${callbackDataLimit} bytes`);
    }
    return { text: label, callback_data: data };
  });
  return { inline_keyboard: [row] };
}

/**
 * The Telegram messaging adapter (spec #1044) over the Bot API with plain `fetch`: `getMe` checks
 * the token, `getUpdates` long-polls (no tunnel, so it works from a laptop), `sendMessage` and
 * `sendDocument` send, and `getFile` downloads.
 */
export function telegram({
  apiBase = defaultApiBase,
}: {
  /** The Bot API's base URL, such as a local Bot API server's. */
  apiBase?: string;
} = {}): MessagingAdapter<"token"> {
  const base = apiBase.replace(/\/+$/, "");

  // Consecutive `receive` failures per Channel account. It outlives one `listen` call, since a
  // failure ends the call and the core starts it again.
  const failures = new Map<string, { updateId: number; count: number }>();

  return {
    kind: "messaging",
    id: "telegram",
    credentialFields: ["token"],
    limits,

    async check({ token }, call) {
      try {
        const me = await callApi<{ id: number; username?: string }>(base, token, "getMe", {}, call);
        return { platformBotId: String(me.id), handle: `@${me.username ?? ""}` };
      } catch (error) {
        if (error instanceof CredentialsRejectedError) return { rejected: error.reason };
        // Telegram answers a malformed or unknown token with 404.
        if (error instanceof TelegramApiError && error.status === 404)
          return { rejected: "Not Found" };
        throw error;
      }
    },

    async listen(account, { receive, signal, ...call }) {
      const { token } = account.credentials;
      const withSignal = { ...call, signal };
      // A webhook and long polling exclude each other.
      await callApi(base, token, "deleteWebhook", {}, withSignal);
      let offset: number | undefined;
      while (!signal.aborted) {
        let updates: TelegramUpdate[];
        try {
          updates = await callApi<TelegramUpdate[]>(
            base,
            token,
            "getUpdates",
            {
              offset,
              timeout: pollTimeoutSeconds,
              allowed_updates: ["message", "callback_query"],
            },
            withSignal,
          );
        } catch (error) {
          if (signal.aborted) return;
          // Telegram's flood control: wait as long as it asks, rather than the core's backoff.
          if (error instanceof TelegramApiError && error.retryAfter !== undefined) {
            await sleep(error.retryAfter, signal);
            continue;
          }
          throw error;
        }
        for (const update of updates) {
          const normalised = normalise(update);
          if (update.callback_query) {
            // Stops the spinner on the button right away; the answer carries no text.
            await callApi(
              base,
              token,
              "answerCallbackQuery",
              { callback_query_id: update.callback_query.id },
              withSignal,
            ).catch((error) => {
              if (error instanceof CredentialsRejectedError) throw error;
            });
          }
          if (normalised) {
            try {
              await receive(normalised);
            } catch (error) {
              // Left unconfirmed, so it is read again; a poison update must not stall the poll.
              const before = failures.get(account.id);
              const count = before?.updateId === update.update_id ? before.count + 1 : 1;
              if (count < maxReceiveFailures) {
                failures.set(account.id, { updateId: update.update_id, count });
                throw error;
              }
              console.warn(
                `Telegram update ${update.update_id} for Channel account ${account.id} failed ${count} times in a row and is skipped`,
                error,
              );
            }
          }
          failures.delete(account.id);
          // Confirmed only now: the next `getUpdates` carries it, so a restart re-reads the rest.
          offset = update.update_id + 1;
        }
      }
    },

    async send(account: Account, message: OutboundMessage, call): Promise<SentMessage> {
      const { token } = account.credentials;
      const replyMarkup = message.buttons ? keyboard(message.buttons) : undefined;
      const files = message.files ?? [];
      for (const file of files) {
        if (file.content.length > limits.upload) {
          throw new Error(`"${file.name}" is over ${limits.upload} bytes`);
        }
      }
      const parts = message.text.trim() === "" ? [] : splitParts(message.text);
      const calls = parts.length + files.length;
      const messageIds: string[] = [];
      let buttonsMessageId: string | undefined;
      const record = (sent: { message_id: number }, index: number) => {
        messageIds.push(String(sent.message_id));
        if (replyMarkup && index === calls - 1) buttonsMessageId = String(sent.message_id);
      };
      for (const [index, part] of parts.entries()) {
        const reply_markup = index === calls - 1 ? replyMarkup : undefined;
        const send = (body: Record<string, unknown>) =>
          callApi<{ message_id: number }>(
            base,
            token,
            "sendMessage",
            { chat_id: message.chatId, reply_markup, ...body },
            call,
          );
        const sent = await send({ text: part.markdownV2, parse_mode: "MarkdownV2" }).catch(
          (error) => {
            // The converter missed something Telegram refuses: say it plainly instead.
            if (
              error instanceof TelegramApiError &&
              error.description.includes("can't parse entities")
            ) {
              return send({ text: part.plain });
            }
            throw error;
          },
        );
        record(sent, index);
      }
      for (const [at, file] of files.entries()) {
        const form = new FormData();
        form.set("chat_id", message.chatId);
        form.set(
          "document",
          new Blob([file.content as Uint8Array<ArrayBuffer>], { type: file.contentType }),
          file.name,
        );
        const index = parts.length + at;
        if (replyMarkup && index === calls - 1) {
          form.set("reply_markup", JSON.stringify(replyMarkup));
        }
        record(
          await callApi<{ message_id: number }>(base, token, "sendDocument", form, call),
          index,
        );
      }
      return { messageIds, buttonsMessageId };
    },

    async editButtons(account: Account, { chatId, messageId, chosen }, call) {
      await callApi(
        base,
        account.credentials.token,
        "editMessageReplyMarkup",
        {
          chat_id: chatId,
          message_id: Number(messageId),
          // The chosen option stays as one button that answers nothing.
          reply_markup: {
            inline_keyboard:
              chosen === null ? [] : [[{ text: `✓ ${chosen}`, callback_data: "done" }]],
          },
        },
        call,
      );
    },

    async download(account: Account, file, { maxBytes, ...call }) {
      const { token } = account.credentials;
      if ((file.size ?? 0) > maxBytes) throw new MessagingFileTooLargeError(maxBytes);
      const info = await callApi<{ file_path?: string; file_size?: number }>(
        base,
        token,
        "getFile",
        { file_id: file.id },
        call,
      ).catch((error) => {
        if (error instanceof TelegramApiError && error.description.includes("file is too big")) {
          throw new MessagingFileTooLargeError(maxBytes);
        }
        throw error;
      });
      if (!info.file_path) throw new Error("Telegram gave no path for the file");
      if ((info.file_size ?? file.size ?? 0) > maxBytes) {
        throw new MessagingFileTooLargeError(maxBytes);
      }
      const response = await call.fetch(`${base}/file/bot${token}/${info.file_path}`, {
        signal: call.signal,
      });
      if (response.status === 401) {
        throw new CredentialsRejectedError(response.statusText);
      }
      if (!response.ok || !response.body) {
        throw new Error(`Downloading the file failed (${response.status})`);
      }
      // Counts as it reads, so a body past `maxBytes` stops there.
      const chunks: Uint8Array[] = [];
      let length = 0;
      const reader = response.body.getReader();
      for (let part = await reader.read(); !part.done; part = await reader.read()) {
        length += part.value.length;
        if (length > maxBytes) {
          await reader.cancel();
          throw new MessagingFileTooLargeError(maxBytes);
        }
        chunks.push(part.value);
      }
      return Buffer.concat(chunks);
    },

    deepLink: ({ handle }, code) =>
      `https://t.me/${handle.replace(/^@/, "")}?start=${encodeURIComponent(code)}`,
  };
}

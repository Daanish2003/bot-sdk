import { CredentialsRejectedError, MessagingFileTooLargeError } from "@botsdk/bot/channel";
import type {
  MessagingAccount,
  MessagingAdapter,
  MessagingButtons,
  OutboundMessage,
  SentMessage,
} from "@botsdk/bot/channel";

import { callApi, defaultApiBase } from "./api";
import { toParts } from "./markdown";
import { callbackSeparator, normalise, type TelegramUpdate } from "./normalise";

export { TelegramApiError } from "./api";

/** Telegram's limits for a bot: `getFile` downloads up to 20 MB, uploads go up to 50 MB. */
const limits = { download: 20 * 1024 * 1024, upload: 50 * 1024 * 1024 };

/** How long `getUpdates` waits for an update, in seconds. */
const pollTimeoutSeconds = 30;

/** A button's callback data may be at most 64 bytes. */
const callbackDataLimit = 64;

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
          throw error;
        }
        for (const update of updates) {
          const normalised = normalise(update);
          if (normalised) await receive(normalised);
          if (update.callback_query) {
            // Stops the spinner on the button; the answer carries no text.
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
      const parts = message.text.trim() === "" ? [] : toParts(message.text);
      const calls = parts.length + files.length;
      const messageIds: string[] = [];
      let buttonsMessageId: string | undefined;
      const record = (sent: { message_id: number }, index: number) => {
        messageIds.push(String(sent.message_id));
        if (replyMarkup && index === calls - 1) buttonsMessageId = String(sent.message_id);
      };
      for (const [index, text] of parts.entries()) {
        const sent = await callApi<{ message_id: number }>(
          base,
          token,
          "sendMessage",
          {
            chat_id: message.chatId,
            text,
            parse_mode: "MarkdownV2",
            reply_markup: index === calls - 1 ? replyMarkup : undefined,
          },
          call,
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
      const info = await callApi<{ file_path?: string; file_size?: number }>(
        base,
        token,
        "getFile",
        { file_id: file.id },
        call,
      );
      if (!info.file_path) throw new Error("Telegram gave no path for the file");
      if ((info.file_size ?? file.size ?? 0) > maxBytes) {
        throw new MessagingFileTooLargeError(maxBytes);
      }
      const response = await call.fetch(`${base}/file/bot${token}/${info.file_path}`, {
        signal: call.signal,
      });
      if (response.status === 401 || response.status === 403) {
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

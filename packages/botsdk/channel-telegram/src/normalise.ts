import type { MessagingFile, MessagingUpdate } from "@botsdk/bot/channel";

type User = { id: number; username?: string; first_name?: string };
type Chat = { id: number; type: string; title?: string };
type PhotoSize = { file_id: string; file_unique_id: string; file_size?: number };

type Message = {
  message_id: number;
  from?: User;
  chat: Chat;
  text?: string;
  caption?: string;
  photo?: PhotoSize[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; mime_type?: string; file_size?: number };
  audio?: {
    file_id: string;
    file_name?: string;
    title?: string;
    mime_type?: string;
    file_size?: number;
  };
};

/** One entry of `getUpdates`: a message, or a press of an inline button. */
export type TelegramUpdate = {
  update_id: number;
  message?: Message;
  callback_query?: { id: string; from: User; message?: Message; data?: string };
};

/** Separates a control from its option in a button's callback data (an ASCII unit separator). */
export const callbackSeparator = "\u001f";

const handleOf = (user: User) => (user.username ? `@${user.username}` : (user.first_name ?? ""));

function filesOf(message: Message): MessagingFile[] {
  const files: MessagingFile[] = [];
  const photo = message.photo?.at(-1);
  if (photo) {
    files.push({
      id: photo.file_id,
      name: `photo-${photo.file_unique_id}.jpg`,
      contentType: "image/jpeg",
      size: photo.file_size ?? null,
      kind: "photo",
    });
  }
  const { document, voice, audio } = message;
  if (document) {
    files.push({
      id: document.file_id,
      name: document.file_name ?? "document",
      contentType: document.mime_type ?? "application/octet-stream",
      size: document.file_size ?? null,
      kind: "document",
    });
  }
  if (voice) {
    files.push({
      id: voice.file_id,
      name: "voice.ogg",
      contentType: voice.mime_type ?? "audio/ogg",
      size: voice.file_size ?? null,
      kind: "voice",
    });
  }
  if (audio) {
    files.push({
      id: audio.file_id,
      name: audio.file_name ?? audio.title ?? "audio",
      contentType: audio.mime_type ?? "audio/mpeg",
      size: audio.file_size ?? null,
      kind: "audio",
    });
  }
  return files;
}

/**
 * Normalises one Telegram update. A message's `sourceId` is `<chat>:<message>`, since Telegram
 * numbers messages per chat; a press carries its callback query id. `null` for an update the
 * adapter has nothing to say about (a press of a button that carries no option).
 */
export function normalise(update: TelegramUpdate): MessagingUpdate | null {
  const { message, callback_query: query } = update;
  if (query) {
    const chat = query.message?.chat;
    const at = query.data?.indexOf(callbackSeparator) ?? -1;
    if (!chat || !query.message || !query.data || at < 0) return null;
    return {
      sourceId: query.id,
      sender: { id: String(query.from.id), handle: handleOf(query.from) },
      chat: { id: String(chat.id), private: chat.type === "private" },
      text: "",
      files: [],
      press: {
        control: query.data.slice(0, at),
        option: query.data.slice(at + 1),
        messageId: String(query.message.message_id),
      },
    };
  }
  if (!message) return null;
  return {
    sourceId: `${message.chat.id}:${message.message_id}`,
    // A message in a channel has no sender: it is the channel's own.
    sender: message.from
      ? { id: String(message.from.id), handle: handleOf(message.from) }
      : { id: String(message.chat.id), handle: message.chat.title ?? "" },
    chat: { id: String(message.chat.id), private: message.chat.type === "private" },
    text: message.text ?? message.caption ?? "",
    files: filesOf(message),
  };
}

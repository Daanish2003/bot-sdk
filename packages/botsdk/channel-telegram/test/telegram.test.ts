import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CredentialsRejectedError,
  MessagingFileTooLargeError,
  type MessagingUpdate,
} from "@botsdk/bot/channel";

import { telegram } from "../src";
import { toMarkdownV2, toParts } from "../src/markdown";
import { FakeBotApi } from "./fake-bot-api";

const token = "123:abc";
let api: FakeBotApi;

beforeEach(async () => {
  api = new FakeBotApi();
  await api.start();
});
afterEach(() => api.stop());

const adapter = () => telegram({ apiBase: api.url });
const call = { fetch };
const account = {
  id: "acc",
  botId: "bot",
  platformBotId: "123",
  handle: "@ada_bot",
  credentials: { token },
};
const ok = (result: unknown) => ({ body: { ok: true, result } });
const rejected = { status: 401, body: { ok: false, description: "Unauthorized" } };

describe("check", () => {
  it("returns the bot id and @username from getMe", async () => {
    api.replies.set("getMe", ok({ id: 123, is_bot: true, username: "ada_bot" }));
    expect(await adapter().check({ token }, call)).toEqual({
      platformBotId: "123",
      handle: "@ada_bot",
    });
    expect(api.of("getMe")[0]?.token).toBe(token);
  });

  it("reports a 401 as a credentials rejection", async () => {
    api.replies.set("getMe", rejected);
    expect(await adapter().check({ token }, call)).toEqual({ rejected: "Unauthorized" });
  });

  it("reports a 404 (a malformed token) as a rejection", async () => {
    api.replies.set("getMe", { status: 404, body: { ok: false, description: "Not Found" } });
    expect(await adapter().check({ token }, call)).toEqual({ rejected: "Not Found" });
  });

  it("throws on an error that is not about the credentials", async () => {
    api.replies.set("getMe", { status: 500, body: { ok: false, description: "boom" } });
    await expect(adapter().check({ token }, call)).rejects.toThrow("boom");
  });
});

/** Runs `listen` until `until` holds for the updates received, then aborts it. */
async function listenUntil(
  updates: unknown[][],
  options: { receive?: (update: MessagingUpdate) => Promise<void>; stopAfter?: number } = {},
) {
  const received: MessagingUpdate[] = [];
  const controller = new AbortController();
  let polls = 0;
  api.replies.set("getUpdates", () => {
    const batch = updates[polls++];
    if (!batch) controller.abort();
    return ok(batch ?? []);
  });
  await adapter().listen!(account, {
    ...call,
    signal: controller.signal,
    receive: async (update) => {
      received.push(update);
      await options.receive?.(update);
    },
  });
  return received;
}

const privateChat = { id: 7, type: "private" };
const from = { id: 7, username: "ada" };

describe("listen", () => {
  it("deletes the webhook, then polls with a timeout and allowed_updates", async () => {
    await listenUntil([[]]);
    expect(api.requests[0]?.method).toBe("deleteWebhook");
    expect(api.of("getUpdates")[0]?.body).toMatchObject({
      timeout: 30,
      allowed_updates: ["message", "callback_query"],
    });
  });

  it("advances the offset only once receive has returned", async () => {
    const seenOffsets: unknown[] = [];
    await listenUntil(
      [
        [
          { update_id: 10, message: { message_id: 1, from, chat: privateChat, text: "a" } },
          { update_id: 11, message: { message_id: 2, from, chat: privateChat, text: "b" } },
        ],
      ],
      { receive: async () => void seenOffsets.push(api.of("getUpdates").at(-1)?.body.offset) },
    );
    // While both updates were being received, the last poll had not confirmed either.
    expect(seenOffsets).toEqual([undefined, undefined]);
    expect(api.of("getUpdates")[1]?.body.offset).toBe(12);
  });

  it("re-reads an update whose receive threw: it is never confirmed", async () => {
    const controller = new AbortController();
    api.replies.set(
      "getUpdates",
      ok([{ update_id: 5, message: { message_id: 1, from, chat: privateChat, text: "x" } }]),
    );
    await expect(
      adapter().listen!(account, {
        ...call,
        signal: controller.signal,
        receive: async () => {
          throw new Error("core down");
        },
      }),
    ).rejects.toThrow("core down");
    expect(api.of("getUpdates")).toHaveLength(1);
    expect(api.of("getUpdates")[0]?.body.offset).toBeUndefined();
  });

  it("stops with a credentials rejection on a 401", async () => {
    api.replies.set("deleteWebhook", rejected);
    await expect(listenUntil([])).rejects.toBeInstanceOf(CredentialsRejectedError);
  });

  it("normalises private text, /start, photo, document, voice and audio", async () => {
    const received = await listenUntil([
      [
        { update_id: 1, message: { message_id: 1, from, chat: privateChat, text: "hello" } },
        {
          update_id: 2,
          message: { message_id: 2, from, chat: privateChat, text: "/start abc123" },
        },
        {
          update_id: 3,
          message: {
            message_id: 3,
            from,
            chat: privateChat,
            caption: "look",
            photo: [
              { file_id: "small", file_unique_id: "u1", file_size: 10 },
              { file_id: "big", file_unique_id: "u2", file_size: 99 },
            ],
          },
        },
        {
          update_id: 4,
          message: {
            message_id: 4,
            from,
            chat: privateChat,
            document: {
              file_id: "d",
              file_name: "a.pdf",
              mime_type: "application/pdf",
              file_size: 5,
            },
          },
        },
        {
          update_id: 5,
          message: {
            message_id: 5,
            from,
            chat: privateChat,
            voice: { file_id: "v", file_size: 3 },
          },
        },
        {
          update_id: 6,
          message: {
            message_id: 6,
            from,
            chat: privateChat,
            audio: { file_id: "au", title: "Song", mime_type: "audio/mpeg" },
          },
        },
      ],
    ]);
    expect(received.map((update) => update.text)).toEqual([
      "hello",
      "/start abc123",
      "look",
      "",
      "",
      "",
    ]);
    expect(received[0]).toMatchObject({
      sourceId: "7:1",
      sender: { id: "7", handle: "@ada" },
      chat: { id: "7", private: true },
      files: [],
    });
    expect(received[2]?.files).toEqual([
      { id: "big", name: "photo-u2.jpg", contentType: "image/jpeg", size: 99, kind: "photo" },
    ]);
    expect(received[3]?.files).toEqual([
      { id: "d", name: "a.pdf", contentType: "application/pdf", size: 5, kind: "document" },
    ]);
    expect(received[4]?.files[0]).toMatchObject({
      id: "v",
      kind: "voice",
      contentType: "audio/ogg",
    });
    expect(received[5]?.files[0]).toMatchObject({
      id: "au",
      name: "Song",
      kind: "audio",
      size: null,
    });
  });

  it("flags group and channel updates as not private", async () => {
    const received = await listenUntil([
      [
        {
          update_id: 1,
          message: { message_id: 1, from, chat: { id: -100, type: "supergroup" }, text: "hi" },
        },
        {
          update_id: 2,
          message: {
            message_id: 2,
            chat: { id: -200, type: "channel", title: "News" },
            text: "post",
          },
        },
      ],
    ]);
    expect(received.map((update) => update.chat.private)).toEqual([false, false]);
    expect(received[1]?.sender).toEqual({ id: "-200", handle: "News" });
  });

  it("normalises a callback_query to a press and answers it after receive", async () => {
    const received = await listenUntil([
      [
        {
          update_id: 1,
          callback_query: {
            id: "cq1",
            from,
            message: { message_id: 9, chat: privateChat },
            data: "approval-1\u001fapprove",
          },
        },
        {
          update_id: 2,
          callback_query: {
            id: "cq2",
            from,
            message: { message_id: 9, chat: privateChat },
            data: "done",
          },
        },
      ],
    ]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      sourceId: "cq1",
      press: { control: "approval-1", option: "approve" },
    });
    expect(api.of("answerCallbackQuery").map((request) => request.body.callback_query_id)).toEqual([
      "cq1",
      "cq2",
    ]);
  });
});

describe("markdown", () => {
  it("converts bold, italic, code, code blocks and links, escaping the rest", () => {
    expect(toMarkdownV2("**bold** and *it* and `a.b` (x)")).toBe(
      "*bold* and _it_ and `a.b` \\(x\\)",
    );
    expect(toMarkdownV2("see [docs](https://a.b/c_(d))")).toBe("see [docs](https://a.b/c_(d\\))");
    expect(toMarkdownV2("```ts\nconst a = 1.5;\n```")).toBe("```ts\nconst a = 1.5;\n```");
    expect(toMarkdownV2("snake_case 1-2 #1!")).toBe("snake\\_case 1\\-2 \\#1\\!");
  });

  it("keeps a * bullet list as text rather than italics", () => {
    expect(toMarkdownV2("* apples\n* pears")).toBe("\\* apples\n\\* pears");
  });

  it("splits a long text into numbered parts that each fit 4096 characters", () => {
    const text = Array.from({ length: 600 }, (_, i) => `line ${i}.`).join("\n");
    const parts = toParts(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const [index, part] of parts.entries()) {
      expect(part.length).toBeLessThanOrEqual(4096);
      expect(part.endsWith(`\\(${index + 1}/${parts.length}\\)`)).toBe(true);
    }
  });

  it("closes a code block a part cuts and reopens it in the next", () => {
    const parts = toParts("```py\n" + "x = 1\n".repeat(1500) + "```");
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.replace(/ \\\(\d+\/\d+\\\)$/, "").match(/```/g)?.length).toBe(2);
    }
  });
});

describe("send", () => {
  it("sends MarkdownV2 text and reports the message ids", async () => {
    api.replies.set("sendMessage", ok({ message_id: 41 }));
    const sent = await adapter().send(account, { chatId: "7", text: "**hi**." }, call);
    expect(sent).toEqual({ messageIds: ["41"], buttonsMessageId: undefined });
    expect(api.of("sendMessage")[0]?.body).toMatchObject({
      chat_id: "7",
      text: "*hi*\\.",
      parse_mode: "MarkdownV2",
    });
  });

  it("splits past 4096 characters into several messages, buttons on the last", async () => {
    let id = 100;
    api.replies.set("sendMessage", () => ok({ message_id: id++ }));
    const sent = await adapter().send(
      account,
      {
        chatId: "7",
        text: "word ".repeat(2000),
        buttons: { control: "c1", options: [{ option: "yes", label: "Yes" }] },
      },
      call,
    );
    const requests = api.of("sendMessage");
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.slice(0, -1).every((request) => request.body.reply_markup === undefined)).toBe(
      true,
    );
    expect(sent.messageIds).toHaveLength(requests.length);
    expect(sent.buttonsMessageId).toBe(sent.messageIds.at(-1));
  });

  it("sends an inline keyboard whose callback data carries the control and option", async () => {
    api.replies.set("sendMessage", ok({ message_id: 5 }));
    const sent = await adapter().send(
      account,
      {
        chatId: "7",
        text: "ok?",
        buttons: {
          control: "c1",
          options: [
            { option: "yes", label: "Yes" },
            { option: "no", label: "No" },
          ],
        },
      },
      call,
    );
    expect(sent.buttonsMessageId).toBe("5");
    expect(api.of("sendMessage")[0]?.body.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "Yes", callback_data: "c1\u001fyes" },
          { text: "No", callback_data: "c1\u001fno" },
        ],
      ],
    });
  });

  it("refuses callback data over 64 bytes before calling the API", async () => {
    await expect(
      adapter().send(
        account,
        {
          chatId: "7",
          text: "ok?",
          buttons: { control: "c".repeat(62), options: [{ option: "yes", label: "Yes" }] },
        },
        call,
      ),
    ).rejects.toThrow("64 bytes");
    expect(api.requests).toHaveLength(0);
  });

  it("sends files with sendDocument, and refuses one over 50 MB", async () => {
    api.replies.set("sendDocument", ok({ message_id: 8 }));
    const content = new TextEncoder().encode("hello");
    const sent = await adapter().send(
      account,
      { chatId: "7", text: "", files: [{ name: "a.txt", contentType: "text/plain", content }] },
      call,
    );
    expect(sent.messageIds).toEqual(["8"]);
    expect(api.of("sendMessage")).toHaveLength(0);
    expect(api.of("sendDocument")[0]?.body).toMatchObject({
      chat_id: "7",
      document: { name: "a.txt", size: 5 },
    });
    const big = { length: 50 * 1024 * 1024 + 1 } as unknown as Uint8Array;
    await expect(
      adapter().send(
        account,
        { chatId: "7", text: "", files: [{ name: "b", contentType: "x/y", content: big }] },
        call,
      ),
    ).rejects.toThrow("52428800");
  });
});

describe("editButtons", () => {
  it("removes the buttons, or leaves the chosen option", async () => {
    await adapter().editButtons(account, { chatId: "7", messageId: "5", chosen: null }, call);
    await adapter().editButtons(account, { chatId: "7", messageId: "5", chosen: "Yes" }, call);
    const [removed, chosen] = api.of("editMessageReplyMarkup");
    expect(removed?.body).toEqual({
      chat_id: "7",
      message_id: 5,
      reply_markup: { inline_keyboard: [] },
    });
    expect(chosen?.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: "✓ Yes", callback_data: "done" }]],
    });
  });
});

describe("download", () => {
  const file = { id: "f1", name: "a", contentType: "x/y", size: null, kind: "document" as const };

  it("fetches a file's bytes through getFile", async () => {
    api.replies.set("getFile", ok({ file_id: "f1", file_path: "docs/a.bin", file_size: 3 }));
    api.replies.set("file:docs/a.bin", { bytes: new Uint8Array([1, 2, 3]) });
    const bytes = await adapter().download(account, file, { ...call, maxBytes: 100 });
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(api.of("getFile")[0]?.body).toEqual({ file_id: "f1" });
  });

  it("throws MessagingFileTooLargeError past maxBytes, by getFile's size or by the body", async () => {
    api.replies.set("getFile", ok({ file_path: "docs/a.bin", file_size: 500 }));
    await expect(
      adapter().download(account, file, { ...call, maxBytes: 100 }),
    ).rejects.toBeInstanceOf(MessagingFileTooLargeError);
    api.replies.set("getFile", ok({ file_path: "docs/a.bin" }));
    api.replies.set("file:docs/a.bin", { bytes: new Uint8Array(500) });
    await expect(
      adapter().download(account, file, { ...call, maxBytes: 100 }),
    ).rejects.toBeInstanceOf(MessagingFileTooLargeError);
  });

  it("has Telegram's limits", () => {
    expect(adapter().limits).toEqual({ download: 20 * 1024 * 1024, upload: 50 * 1024 * 1024 });
  });
});

describe("deepLink", () => {
  it("opens a chat with the bot carrying the code", () => {
    expect(adapter().deepLink({ platformBotId: "123", handle: "@ada_bot" }, "abc 1")).toBe(
      "https://t.me/ada_bot?start=abc%201",
    );
  });
});

describe("delivery errors and the poll loop", () => {
  const forbidden = {
    status: 403,
    body: { ok: false, description: "Forbidden: bot was blocked by the user" },
  };
  const update = { update_id: 20, message: { message_id: 1, from, chat: privateChat, text: "x" } };

  it("treats a 403 as a credentials rejection only on account-wide calls", async () => {
    api.replies.set("getUpdates", forbidden);
    await expect(
      adapter().listen!(account, {
        ...call,
        signal: new AbortController().signal,
        receive: async () => {},
      }),
    ).rejects.toBeInstanceOf(CredentialsRejectedError);
    api.replies.set("sendMessage", forbidden);
    const sending = adapter().send(account, { chatId: "7", text: "hi" }, call);
    await expect(sending).rejects.toThrow("blocked by the user");
    await expect(sending).rejects.not.toBeInstanceOf(CredentialsRejectedError);
    api.replies.set("editMessageReplyMarkup", forbidden);
    await expect(
      adapter().editButtons(account, { chatId: "7", messageId: "5", chosen: null }, call),
    ).rejects.not.toBeInstanceOf(CredentialsRejectedError);
  });

  it("treats a 401 as a credentials rejection on any call", async () => {
    api.replies.set("sendMessage", rejected);
    await expect(adapter().send(account, { chatId: "7", text: "hi" }, call)).rejects.toBeInstanceOf(
      CredentialsRejectedError,
    );
  });

  it("resends a part as plain text when Telegram cannot parse its entities", async () => {
    let calls = 0;
    api.replies.set("sendMessage", () =>
      calls++ === 0
        ? { status: 400, body: { ok: false, description: "Bad Request: can't parse entities" } }
        : ok({ message_id: 3 }),
    );
    const sent = await adapter().send(account, { chatId: "7", text: "**hi**." }, call);
    expect(sent.messageIds).toEqual(["3"]);
    const [first, second] = api.of("sendMessage");
    expect(first?.body.parse_mode).toBe("MarkdownV2");
    expect(second?.body.parse_mode).toBeUndefined();
    expect(second?.body.text).toBe("**hi**.");
  });

  it("throws MessagingFileTooLargeError when getFile says the file is too big", async () => {
    api.replies.set("getFile", {
      status: 400,
      body: { ok: false, description: "Bad Request: file is too big" },
    });
    const file = { id: "f", name: "a", contentType: "x/y", size: null, kind: "document" as const };
    await expect(
      adapter().download(account, file, { ...call, maxBytes: 100 }),
    ).rejects.toBeInstanceOf(MessagingFileTooLargeError);
  });

  it("skips an update after three consecutive receive failures, warning once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const polling = adapter();
    const controller = new AbortController();
    api.replies.set("getUpdates", (body) => {
      if (body.offset !== undefined) controller.abort();
      return ok(body.offset === undefined ? [update] : []);
    });
    const attempt = (signal: AbortSignal) =>
      polling.listen!(account, {
        ...call,
        signal,
        receive: async () => {
          throw new Error("poison");
        },
      });
    await expect(attempt(controller.signal)).rejects.toThrow("poison");
    expect(warn).not.toHaveBeenCalled();
    await expect(attempt(controller.signal)).rejects.toThrow("poison");
    await attempt(controller.signal);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(api.of("getUpdates").at(-1)?.body.offset).toBe(21);
    warn.mockRestore();
  });

  it("waits a 429's retry_after before polling again", async () => {
    const controller = new AbortController();
    let polls = 0;
    const times: number[] = [];
    api.replies.set("getUpdates", () => {
      times.push(Date.now());
      if (polls++ === 0) {
        return {
          status: 429,
          body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 1 } },
        };
      }
      controller.abort();
      return ok([]);
    });
    await adapter().listen!(account, {
      ...call,
      signal: controller.signal,
      receive: async () => {},
    });
    expect(times).toHaveLength(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(900);
  });
});

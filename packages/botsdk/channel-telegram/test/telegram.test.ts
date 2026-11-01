import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CredentialsRejectedError,
  MessagingFileTooLargeError,
  MessagingSendError,
  type MessagingUpdate,
} from "@botsdk/bot/channel";

import { telegram, TelegramApiError } from "../src";
import { FakeBotApi } from "./fake-bot-api";
import { markdownV2Problem } from "./markdown-v2-check";

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
      press: { control: "approval-1", option: "approve", messageId: "9" },
    });
    expect(api.of("answerCallbackQuery").map((request) => request.body.callback_query_id)).toEqual([
      "cq1",
      "cq2",
    ]);
  });
});

describe("what a Message looks like on Telegram", () => {
  const parseError = {
    status: 400,
    body: { ok: false, description: "Bad Request: can't parse entities: bad" },
  };

  /** Sends `text` to a Bot API that refuses what Telegram would. Each message's text, as sent. */
  async function sent(text: string, id = { next: 1 }): Promise<string[]> {
    const before = api.of("sendMessage").length;
    api.replies.set("sendMessage", (body) => {
      const problem = markdownV2Problem(String(body.text));
      return problem ? parseError : ok({ message_id: id.next++ });
    });
    await adapter().send(account, { chatId: "7", text }, call);
    const requests = api.of("sendMessage").slice(before);
    for (const { body } of requests) {
      const problem = markdownV2Problem(String(body.text));
      if (problem) throw new Error(`Telegram refuses it: ${problem}\n${String(body.text)}`);
      expect(String(body.text).length).toBeLessThanOrEqual(4096);
    }
    return requests.map(({ body }) => String(body.text));
  }

  it.each([
    ["a stray mark", "2*3"],
    ["an unescaped dot", "a."],
    ["code in bold", "*a `b`*"],
    ["crossed entities", "*a _b* c_"],
    ["two italics touching", "_a__b_"],
    ["a block left open", "```\na"],
    ["a quote in bold", "*a\n>b*"],
    ["bold over a quote's line end", ">*a\n>b*"],
    ["a code block in a quote", ">```\na\n```"],
    ["a link in a link", "[a[b](u)](v)"],
  ])("has a fake Bot API that refuses %s, as Telegram would", (_, text) => {
    expect(markdownV2Problem(text)).not.toBeNull();
  });

  /** What's left of a part once its marker and its markup are taken off: what the user reads. */
  const reads = (part: string) =>
    part
      .replace(/ \\\(\d+\/\d+\\\)$/, "")
      .replace(/^```.*\n|\n```$/gm, "")
      .replace(/^>/gm, "")
      .replace(/(?<!\\)[*_~]/g, "")
      .replace(/\\(.)/g, "$1");

  it.each([
    ["bold, italic, code", "**bold** and *it* and `a.b` (x)", "*bold* and _it_ and `a.b` \\(x\\)"],
    ["strikethrough", "~~gone~~ now", "~gone~ now"],
    ["a quote", "> said\n> more", ">said\n>more"],
    ["a heading as bold", "# Title", "*Title*"],
    ["a list", "- one\n- two", "• one\n• two"],
    ["a numbered list", "3. three\n4. four", "3\\. three\n4\\. four"],
    ["a nested list", "- a\n  - b", "• a\n  • b"],
    ["paragraphs", "one\n\ntwo", "one\n\ntwo"],
    ["a line break", "one\ntwo", "one\ntwo"],
    ["a code block", "```ts\nconst a = 1.5;\n```", "```ts\nconst a = 1.5;\n```"],
    ["code's own escapes", "```\na`b\\c\n```", "```\na\\`b\\\\c\n```"],
    ["inline code's own escapes", "`a\\b.c`", "`a\\\\b.c`"],
    ["a link", "see [docs](https://a.b/c_(d))", "see [docs](https://a.b/c_(d\\))"],
    ["a bare address", "at https://a.b/c.", "at [https://a\\.b/c](https://a.b/c)\\."],
    ["other specials", "snake_case 1-2 #1!", "snake\\_case 1\\-2 \\#1\\!"],
    ["a rule, gone", "a\n\n---\n\nb", "a\n\nb"],
  ])("converts %s", async (_, markdown, expected) => {
    expect(await sent(markdown)).toEqual([expected]);
  });

  it("makes a table one monospaced code block, its columns aligned", async () => {
    expect(await sent("| Name | Qty |\n|---|--:|\n| a*b | 10 |\n| [c](https://c.d) | 2 |")).toEqual(
      ["```\nName              Qty\na*b                10\nc (https://c.d/)    2\n```"],
    );
  });

  it("makes a Message that is all JSON a code block, its asterisks kept", async () => {
    expect(await sent('{"a":"*b* _c_"}')).toEqual(['```json\n{"a":"*b* _c_"}\n```']);
  });

  it.each([
    ["2*3*4", "2\\*3\\*4"],
    ["2**3**4", "2\\*\\*3\\*\\*4"],
    ["2 * 3 * 4", "2 \\* 3 \\* 4"],
    ["a \\* b", "a \\* b"],
    ["\\*not italic\\*", "\\*not italic\\*"],
    ["5~10~20", "5\\~10\\~20"],
  ])("keeps %s as written", async (markdown, expected) => {
    expect(await sent(markdown)).toEqual([expected]);
  });

  it.each([
    ["code in bold leaves the bold", "**a `b` c**", "*a *`b`* c*"],
    ["code in a heading leaves the bold", "# a `b`", "*a *`b`"],
    ["code in a link is the link's text", "[`code`](https://a.b)", "[code](https://a.b/)"],
    ["bold and italic together", "***a***", "*_a_*"],
    ["italic in italic is one italic", "*a _b_ c*", "_a b c_"],
    ["two italics in a row never read as underline", "*a*_b_", "_ab_"],
    ["bold in a link", "[**a** b](https://a.b)", "[*a* b](https://a.b/)"],
    ["a quote in a quote is one quote", "> a\n>\n> > b", ">a\n>\n>b"],
    ["a code block leaves its quote", "> x\n>\n> ```\n> y\n> ```", ">x\n>\n```\ny\n```"],
    ["a table leaves its quote", "> | a |\n> |---|\n> | b |", "```\na\nb\n```"],
    ["bold closes at a line end", "**a\nb**", "*a*\n*b*"],
    ["bold closes at a line end in a quote", "> **a\nb**", ">*a*\n>*b*"],
  ])("follows the nesting rules: %s", async (_, markdown, expected) => {
    expect(await sent(markdown)).toEqual([expected]);
  });

  it.each([
    ["<script>", "<script>alert(1)</script>\n\nhi", "hi"],
    ["inline HTML", "a <b onclick='x()'>b</b>", "a b"],
    ["a javascript: link", "[x](javascript:alert(1))", "x"],
    ["a tg: link", "[x](tg://user?id=1)", "x"],
    ["a relative link", "[x](/a)", "x"],
    ["a remote image", "a ![p](https://e.vil/x.png) b", "a  b"],
  ])("never lets through %s", async (_, markdown, expected) => {
    expect(await sent(markdown)).toEqual([expected]);
  });

  it("writes a mailto link's address out, as Telegram links an address by itself", async () => {
    expect(await sent("[write](mailto:a@b.co)")).toEqual(["write \\(a@b\\.co\\)"]);
    expect(await sent("[a@b.co](mailto:a@b.co)")).toEqual(["a@b\\.co"]);
  });

  it("sends nothing for a Message with nothing left to show", async () => {
    expect(await sent("![p](https://e.vil/x.png)")).toEqual([]);
    expect(await sent("<script>x</script>")).toEqual([]);
    expect(await sent("```\n\n```")).toEqual([]);
    expect(await sent("&nbsp;")).toEqual([]);
  });

  describe("across split parts", () => {
    const numbered = (parts: string[]) => {
      expect(parts.length).toBeGreaterThan(1);
      for (const [index, part] of parts.entries()) {
        expect(part.endsWith(` \\(${index + 1}/${parts.length}\\)`)).toBe(true);
      }
    };

    it("numbers the parts of a long text", async () => {
      const text = Array.from({ length: 600 }, (_, i) => `line ${i}.`).join("\n");
      const parts = await sent(text);
      numbered(parts);
      expect(parts.map(reads).join("\n")).toBe(text);
    });

    it("closes bold a part cuts and opens it again in the next", async () => {
      // Within one run `marked` reads whole; its escapes take it past one message.
      const parts = await sent(`**${"a.b ".repeat(1000).trim()}**`);
      numbered(parts);
      for (const part of parts) expect(part).toMatch(/^\*a\\\.b.*a\\\.b ?\* \\\(\d+\/\d+\\\)$/);
    });

    it("closes a code block a part cuts and opens it again, with its language", async () => {
      const parts = await sent("```py\n" + "x = 1\n".repeat(1500) + "```");
      numbered(parts);
      for (const part of parts) expect(part).toMatch(/^```py\nx = 1\n[^]*\n``` \\\(\d+\/\d+\\\)$/);
    });

    it("cuts a table into code blocks", async () => {
      const rows = Array.from({ length: 800 }, (_, i) => `| ${i} | row |`).join("\n");
      const parts = await sent(`| a | b |\n|---|---|\n${rows}`);
      numbered(parts);
      for (const part of parts) expect(part).toMatch(/^```\n[^]*\n``` \\\(\d+\/\d+\\\)$/);
    });

    it("keeps a quote a quote in every part", async () => {
      const parts = await sent(Array.from({ length: 1500 }, () => "> line").join("\n"));
      numbered(parts);
      for (const part of parts) expect(part.split("\n").every((l) => l.startsWith(">"))).toBe(true);
    });

    it("never cuts an escape, a pair of surrogates or a link", async () => {
      expect((await sent(".".repeat(5000))).map(reads).join("")).toBe(".".repeat(5000));
      expect((await sent("😀".repeat(3000))).map(reads).join("")).toBe("😀".repeat(3000));
      const parts = await sent(`[${"a.b ".repeat(1000).trim()}](https://a.b/)`);
      numbered(parts);
      for (const part of parts) expect(part).toContain("](https://a.b/)");
    });
  });

  describe("a rejected send", () => {
    const refuseMarkdown = () => {
      let id = 10;
      api.replies.set("sendMessage", (body) =>
        body.parse_mode === "MarkdownV2" ? parseError : ok({ message_id: id++ }),
      );
    };
    const plainSent = () =>
      api
        .of("sendMessage")
        .filter((request) => request.body.parse_mode === undefined)
        .map((request) => String(request.body.text));

    it("falls back to clean text, with no Markdown in it", async () => {
      refuseMarkdown();
      const text = [
        "# Title",
        "**bold** *it* ~~gone~~ `code` 2*3*4",
        "> quoted",
        "- one\n- two",
        "[docs](https://a.b/c) <b>x</b> ![p](https://e.vil/x.png) [y](javascript:z)",
        "| a | b |\n|---|---|\n| 1 | 2 |",
        "```\ncode **block**\n```",
      ].join("\n\n");
      const sent = await adapter().send(account, { chatId: "7", text }, call);
      expect(sent.messageIds).toEqual(["10"]);
      expect(plainSent()).toEqual([
        [
          "Title",
          "bold it gone code 2*3*4",
          "  quoted",
          "• one\n• two",
          "docs (https://a.b/c) x  y",
          "a  b\n1  2",
          "code **block**",
        ].join("\n\n"),
      ]);
    });

    it("writes out what a part holds, marker included, when one part of many is refused", async () => {
      let id = 10;
      api.replies.set("sendMessage", (body) =>
        body.parse_mode === "MarkdownV2" && String(body.text).endsWith("\\(2/2\\)")
          ? parseError
          : ok({ message_id: id++ }),
      );
      await adapter().send(
        account,
        { chatId: "7", text: `**${"a.b ".repeat(1000).trim()}**` },
        call,
      );
      const [plain] = plainSent();
      expect(plain).toMatch(/^a\.b.* \(2\/2\)$/);
      expect(plain).not.toContain("*");
    });

    it("splits the plain resend too, so no message passes 4096 characters", async () => {
      refuseMarkdown();
      // Its MarkdownV2 (`>a`) fits one message; the clean text (`  a`) doesn't.
      const text = Array.from({ length: 1300 }, () => "> a").join("\n");
      const sent = await adapter().send(
        account,
        {
          chatId: "7",
          text,
          buttons: { control: "c1", options: [{ option: "yes", label: "Yes" }] },
        },
        call,
      );
      const pieces = plainSent();
      expect(pieces.length).toBeGreaterThan(1);
      for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(4096);
      expect(pieces.join("")).toBe(Array.from({ length: 1300 }, () => "  a").join("\n"));
      const plain = api.of("sendMessage").filter((r) => r.body.parse_mode === undefined);
      expect(plain.slice(0, -1).every((r) => r.body.reply_markup === undefined)).toBe(true);
      expect(sent.messageIds).toHaveLength(pieces.length);
      expect(sent.buttonsMessageId).toBe(sent.messageIds.at(-1));
    });

    it("resumes a plain resend after the pieces it got out", async () => {
      let id = 10;
      let plainCalls = 0;
      api.replies.set("sendMessage", (body) => {
        if (body.parse_mode === "MarkdownV2") return parseError;
        if (++plainCalls === 2) return { status: 500, body: { ok: false, description: "boom" } };
        return ok({ message_id: id++ });
      });
      const message = {
        chatId: "7",
        text: Array.from({ length: 1300 }, () => "> a").join("\n"),
      };
      const error = await adapter()
        .send(account, message, call)
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(MessagingSendError);
      const { progress } = error as MessagingSendError;
      expect(progress).toEqual({ parts: 0, pieces: 1, sent: { messageIds: ["10"] } });
      const before = api.of("sendMessage").length;

      const sent = await adapter().send(account, { ...message, resume: progress }, call);
      const resumed = api.of("sendMessage").slice(before);
      expect(resumed.every((request) => request.body.parse_mode === undefined)).toBe(true);
      const delivered = api
        .of("sendMessage")
        .filter((request, at) => request.body.parse_mode === undefined && at !== 2);
      expect(delivered.map((request) => String(request.body.text)).join("")).toBe(
        Array.from({ length: 1300 }, () => "  a").join("\n"),
      );
      expect(sent.messageIds).toEqual(["10", ...resumed.map((_, at) => String(11 + at))]);
    });

    it("doesn't resend on a refusal that isn't about the markup", async () => {
      api.replies.set("sendMessage", {
        status: 400,
        body: { ok: false, description: "Bad Request: chat not found" },
      });
      await expect(adapter().send(account, { chatId: "7", text: "hi" }, call)).rejects.toThrow(
        "chat not found",
      );
      expect(api.of("sendMessage")).toHaveLength(1);
    });
  });

  it("turns link previews off on every message: MarkdownV2, each part, and the plain resend", async () => {
    let first = true;
    api.replies.set("sendMessage", (body) => {
      if (first && body.parse_mode === "MarkdownV2") {
        first = false;
        return parseError;
      }
      return ok({ message_id: 1 });
    });
    await adapter().send(
      account,
      { chatId: "7", text: `[a](https://e.vil) ${"word ".repeat(1000)}` },
      call,
    );
    const requests = api.of("sendMessage");
    expect(requests.some((request) => request.body.parse_mode === undefined)).toBe(true);
    expect(requests.filter((request) => request.body.parse_mode).length).toBeGreaterThan(1);
    for (const { body } of requests) {
      expect(body.link_preview_options).toEqual({ is_disabled: true });
    }
  });

  it("gives a retry the same parts, so what a failed send got out lines up", async () => {
    const text = `# Title\n\n**${"word ".repeat(1500).trim()}**\n\n> ${"said ".repeat(1500).trim()}`;
    let id = 1;
    let calls = 0;
    api.replies.set("sendMessage", () =>
      ++calls === 2
        ? { status: 500, body: { ok: false, description: "boom" } }
        : ok({ message_id: id++ }),
    );
    const message = { chatId: "7", text };
    const error = await adapter()
      .send(account, message, call)
      .catch((thrown: unknown) => thrown);
    expect((error as MessagingSendError).progress).toEqual({
      parts: 1,
      sent: { messageIds: ["1"] },
    });
    await adapter().send(
      account,
      { ...message, resume: (error as MessagingSendError).progress },
      call,
    );
    const [firstPart, failed, retried, ...rest] = api
      .of("sendMessage")
      .map(({ body }) => String(body.text));
    expect(retried).toBe(failed);
    expect(rest.length).toBeGreaterThan(0);
    const whole = await sent(text);
    expect([firstPart, retried, ...rest]).toEqual(whole);
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

  it("resumes after the parts an earlier send got out, each part reaching the chat once", async () => {
    let id = 1;
    let failed = false;
    api.replies.set("sendMessage", () => ok({ message_id: id++ }));
    api.replies.set("sendDocument", () => {
      if (failed) return ok({ message_id: id++ });
      failed = true;
      return { status: 500, body: { ok: false, description: "Internal Server Error" } };
    });
    const content = new TextEncoder().encode("hello");
    const message = {
      chatId: "7",
      text: "Here they are.",
      files: [
        { name: "a.txt", contentType: "text/plain", content },
        { name: "b.txt", contentType: "text/plain", content },
      ],
      buttons: { control: "c1", options: [{ option: "yes", label: "Yes" }] },
    };

    const error = await adapter()
      .send(account, message, call)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MessagingSendError);
    const { progress } = error as MessagingSendError;
    expect(progress).toEqual({ parts: 1, sent: { messageIds: ["1"] } });

    const sent = await adapter().send(account, { ...message, resume: progress }, call);
    expect(api.of("sendMessage")).toHaveLength(1);
    expect(api.of("sendDocument").map((request) => request.body.document)).toMatchObject([
      { name: "a.txt" },
      { name: "a.txt" },
      { name: "b.txt" },
    ]);
    expect(sent).toEqual({ messageIds: ["1", "2", "3"], buttonsMessageId: "3" });
  });

  it("throws the platform's own error when no part was sent", async () => {
    api.replies.set("sendMessage", {
      status: 429,
      body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 3 } },
    });
    await expect(adapter().send(account, { chatId: "7", text: "hi" }, call)).rejects.toBeInstanceOf(
      TelegramApiError,
    );
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

  it("counts a poison update's failures even when an earlier update of the batch succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const polling = adapter();
    const controller = new AbortController();
    const good = { update_id: 19, message: { message_id: 0, from, chat: privateChat, text: "ok" } };
    api.replies.set("getUpdates", (body) => {
      if (body.offset !== undefined) controller.abort();
      return ok(body.offset === undefined ? [good, update] : []);
    });
    const attempt = () =>
      polling.listen!(account, {
        ...call,
        signal: controller.signal,
        receive: async (received) => {
          if (received.text === "x") throw new Error("poison");
        },
      });
    await expect(attempt()).rejects.toThrow("poison");
    await expect(attempt()).rejects.toThrow("poison");
    await attempt();
    expect(warn).toHaveBeenCalledTimes(1);
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

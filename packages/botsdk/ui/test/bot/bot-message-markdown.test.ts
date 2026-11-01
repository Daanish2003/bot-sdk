// @vitest-environment jsdom
import type { BotMessage } from "@botsdk/client/bot/turn";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { BotConversation } from "../../src/bot/bot-conversation";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const createdAt = new Date("2026-11-01T09:00:00.000Z");
const ada = { id: "b1", name: "Ada", model: "openai:gpt-6-luna", createdAt };

function mount(messages: BotMessage[]) {
  const router = {
    bots: {
      get: os.handler(() => ({ bot: { ...ada, turnStatus: null }, messages, turns: [] })),
      stop: os.handler(() => {}),
      send: os.input(z.custom<unknown>()).handler(() => {}),
    },
    routines: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
    checkIns: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
    helpers: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
    secrets: { list: os.handler(() => []) },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return render(
    providerFor(createElement(BotConversation, { botId: ada.id }), { fetch, messages: {} }),
  );
}

/** The thread's one Message from `role`, once it has rendered. */
async function shown(text: string, role: BotMessage["role"] = "assistant") {
  const { container } = mount([{ id: "m1", role, text, createdAt }]);
  await waitFor(() => expect(container.querySelector("[data-bot-message]")).not.toBeNull());
  return container.querySelector<HTMLElement>("[data-bot-message]")!;
}

describe("a Bot's Message", () => {
  it("renders headings, lists, tables, quotes and bold", async () => {
    const message = await shown(
      "## Title\n\n**bold**\n\n- one\n- two\n\n> quoted\n\n| A |\n| --- |\n| 1 |",
    );

    expect(message.querySelector("h2")?.textContent).toBe("Title");
    expect(message.querySelector("strong")?.textContent).toBe("bold");
    expect(message.querySelectorAll("li")).toHaveLength(2);
    expect(message.querySelector("blockquote")?.textContent).toContain("quoted");
    expect(message.querySelector("td")?.textContent).toBe("1");
    expect(message.textContent).not.toContain("**");
  });

  it("has typography styles and no pre-wrap", async () => {
    const message = await shown("Hello");

    expect(message.querySelector(".prose")).not.toBeNull();
    expect(message.className).not.toContain("whitespace-pre-wrap");
  });

  it("keeps a single line break as a line break", async () => {
    const message = await shown("first\nsecond");

    expect(message.querySelector("p br")).not.toBeNull();
  });

  it("keeps single tildes as written, and strikes through double ones", async () => {
    const message = await shown("The range 5~10~20, ~~gone~~");

    expect(message.textContent).toContain("5~10~20");
    expect(message.querySelectorAll("del")).toHaveLength(1);
    expect(message.querySelector("del")?.textContent).toBe("gone");
  });

  it("runs the column's full width, with no bubble", async () => {
    const message = await shown("Hello");

    expect(message.parentElement!.className).toContain("self-stretch");
    expect(message.className).not.toContain("rounded-2xl");
  });
});

describe("the user's Message", () => {
  it("shows what they typed, with line breaks kept and no Markdown applied", async () => {
    const typed = "**not bold**\n# not a heading\n<b>x</b> [a](https://example.com)";
    const message = await shown(typed, "user");

    expect(message.textContent).toBe(typed);
    expect(message.children).toHaveLength(0);
    expect(message.className).toContain("whitespace-pre-wrap");
  });

  it("is a higher-contrast bubble on the right", async () => {
    const message = await shown("hi", "user");

    expect(message.className).toContain("bg-primary");
    expect(message.parentElement!.className).toContain("self-end");
  });
});

describe("unsafe content in a Bot's Message", () => {
  it("shows raw HTML as harmless text", async () => {
    const message = await shown(
      'Before\n\n<script>window.pwned = 1</script>\n\n<img src="https://attacker.example/a.png" onerror="alert(1)">\n\nAn inline <b>tag</b> too',
    );

    expect(message.querySelector("script, b")).toBeNull();
    expect(message.querySelector("img")).toBeNull();
    expect(message.textContent).toContain("<script>window.pwned = 1</script>");
    expect(message.textContent).toContain("<b>");
  });

  it("doesn't load a remote image, and shows its alt text", async () => {
    const message = await shown("![a chart](https://attacker.example/a.png)");

    expect(message.querySelector("img")).toBeNull();
    expect(message.innerHTML).not.toContain("attacker.example");
    expect(message.textContent).toContain("a chart");
  });

  it.each([
    ["a javascript: link", "[click](javascript:alert(1))"],
    ["a mixed-case javascript: link", "[click](JaVaScRiPt:alert(1))"],
    ["a data: link", "[click](data:text/html,<script>alert(1)</script>)"],
    ["an ftp: link", "[click](ftp://example.com/file)"],
    ["a relative link", "[click](/settings)"],
    ["an in-page link", "[click](#top)"],
  ])("shows %s as plain text", async (_, markdown) => {
    const message = await shown(markdown);

    expect(message.querySelector("a")).toBeNull();
    expect(message.textContent).toContain("click");
  });

  it.each([
    ["http", "[go](http://example.com/a)", "http://example.com/a"],
    ["https", "[go](https://example.com/a)", "https://example.com/a"],
    ["mailto", "[go](mailto:ada@example.com)", "mailto:ada@example.com"],
  ])("keeps a %s link, in a new tab with a safe rel", async (_, markdown, href) => {
    const link = (await shown(markdown)).querySelector("a")!;

    expect(link.getAttribute("href")).toBe(href);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("shows the real address on hover, never the author's title", async () => {
    const message = await shown(
      '[bank.example](https://attacker.example/x "https://bank.example")',
    );
    const link = message.querySelector("a")!;

    expect(link.getAttribute("title")).toBe("https://attacker.example/x");
    expect(message.innerHTML).not.toContain("https://bank.example");
  });
});

describe("Markdown across a Message", () => {
  it("resolves a footnote whose definition is in another block", async () => {
    const message = await shown("A claim.[^1]\n\nAnother paragraph.\n\n[^1]: The source.");

    const reference = message.querySelector<HTMLAnchorElement>("a[data-footnote-ref]")!;
    expect(reference.textContent).toBe("1");
    expect(message.textContent).toContain("The source.");
    expect(message.textContent).not.toContain("[^1]");
    const target = reference.getAttribute("href")!.slice(1);
    expect(message.querySelector(`[id="${target}"]`)).not.toBeNull();
    expect(reference.getAttribute("target")).toBeNull();
    const back = message.querySelector("a[data-footnote-backref]")!;
    expect(message.querySelector(`[id="${back.getAttribute("href")!.slice(1)}"]`)).toBe(reference);
  });

  it("keeps two Messages' footnotes apart", async () => {
    const { container } = mount([
      { id: "m1", role: "assistant", text: "One.[^1]\n\n[^1]: First.", createdAt },
      { id: "m2", role: "assistant", text: "Two.[^1]\n\n[^1]: Second.", createdAt },
    ]);
    await waitFor(() => expect(container.querySelectorAll("a[data-footnote-ref]")).toHaveLength(2));

    const ids = [...container.querySelectorAll("a[data-footnote-ref]")].map((link) => link.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("resolves a reference link whose definition is in another block", async () => {
    const message = await shown(
      "See [the docs][docs].\n\nMore text.\n\n[docs]: https://example.com",
    );

    expect(message.querySelector("a")?.getAttribute("href")).toBe("https://example.com/");
    expect(message.textContent).not.toContain("[docs]");
  });

  it("leaves no `node` attribute in the DOM", async () => {
    const message = await shown("Use `x` and [a](https://example.com)\n\n```\nblock\n```");

    expect(message.querySelector("[node]")).toBeNull();
  });

  it("keeps inline code inline, even across a line break", async () => {
    const message = await shown("Run `one\ntwo` now");

    expect(message.querySelector("p code")?.textContent).toContain("one");
    expect(message.querySelector("pre")).toBeNull();
  });

  it("shows a one-line fence as a block", async () => {
    const message = await shown("```\nonly line\n```");

    expect(message.querySelector("pre code")?.textContent).toContain("only line");
    expect(message.querySelector("p code")).toBeNull();
  });
});

describe("highlighting", () => {
  it("keeps highlighting after a fence named like an Object property", async () => {
    const { container } = mount([
      {
        id: "m1",
        role: "assistant",
        text: "```constructor\nx\n```\n\n```toString\ny\n```",
        createdAt,
      },
    ]);
    await waitFor(() => expect(container.querySelector("[data-bot-message] pre")).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 200));
    cleanup();

    const message = await shown("```ts\nconst after = 1;\n```");

    await waitFor(() => expect(message.querySelector("pre.shiki")).not.toBeNull(), {
      timeout: 5000,
    });
  });

  it("reads a fence's language whatever its case", async () => {
    const message = await shown("```TS\nconst a = 1;\n```");

    await waitFor(() => expect(message.querySelector("pre.shiki")).not.toBeNull(), {
      timeout: 5000,
    });
  });

  it("shows an empty fence as an empty block", async () => {
    const message = await shown("```ts\n```");

    await waitFor(() => expect(message.querySelector("pre")).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(message.textContent).not.toContain("undefined");
  });

  it.each([
    ["ts", "const a = 1;"],
    ["sh", "echo hi"],
    ["json", '{\n  "a": 1\n}'],
  ])("highlights a %s fence", async (language, code) => {
    const message = await shown(`\`\`\`${language}\n${code}\n\`\`\``);

    await waitFor(() => expect(message.querySelector("pre.shiki")).not.toBeNull(), {
      timeout: 5000,
    });
    expect(message.querySelector("pre.shiki")?.textContent).toContain(code);
  });

  it.each([["rust"], ["constructor"]])("keeps a %s fence as plain code", async (language) => {
    const message = await shown(`\`\`\`${language}\nfn main() {}\n\`\`\``);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(message.querySelector("pre.shiki")).toBeNull();
    expect(message.querySelector("pre code")?.textContent).toContain("fn main() {}");
  });
});

describe("JSON in a Bot's Message", () => {
  it("shows a Message that is a JSON object from start to finish as an indented block", async () => {
    const message = await shown('{"a":"*kept*","b":[1,2]}');

    expect(message.querySelector("pre")?.textContent).toBe(
      '{\n  "a": "*kept*",\n  "b": [\n    1,\n    2\n  ]\n}',
    );
    expect(message.querySelector("em")).toBeNull();
  });

  it("shows a JSON array, however it is padded, as an indented block", async () => {
    const message = await shown('\n  [{"a":"2*3*4"}]  \n');

    expect(message.querySelector("pre")?.textContent).toBe('[\n  {\n    "a": "2*3*4"\n  }\n]');
  });

  it("pretty-prints a fenced json block", async () => {
    const message = await shown('Here:\n\n```json\n{"a":1,"b":{"c":2}}\n```');

    expect(message.querySelector("pre")?.textContent).toBe(
      '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}',
    );
  });

  it("shows an invalid fenced json block as it came", async () => {
    const message = await shown('```json\n{"a": 1,, }\n```');

    expect(message.querySelector("pre")?.textContent).toBe('{"a": 1,, }');
  });

  it("shows JSON as it came when indenting would change its values", async () => {
    const big = '{"id":12345678901234567890,"v":1.0}';

    expect((await shown(big)).querySelector("pre")?.textContent).toBe(big);
    cleanup();
    const fenced = await shown("```json\n" + big + "\n```");
    expect(fenced.querySelector("pre")?.textContent).toBe(big);
  });

  it("leaves JSON inside a sentence alone", async () => {
    const message = await shown('The result was {"a":1} and then it stopped.');

    expect(message.querySelector("pre")).toBeNull();
    expect(message.querySelector("p")?.textContent).toBe(
      'The result was {"a":1} and then it stopped.',
    );
  });

  it("leaves a JSON scalar, and text that starts like JSON, to Markdown", async () => {
    expect((await shown("123")).querySelector("pre")).toBeNull();
    cleanup();
    const link = await shown("[docs](https://example.com)");
    expect(link.querySelector("pre")).toBeNull();
    expect(link.querySelector("a")).not.toBeNull();
  });

  it("doesn't turn the user's JSON into a block", async () => {
    const message = await shown('{"a":1}', "user");

    expect(message.querySelector("pre")).toBeNull();
    expect(message.textContent).toBe('{"a":1}');
  });
});

describe("code blocks", () => {
  const lines = (count: number) =>
    Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

  it("copies the block's code from a named button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const message = await shown("```ts\nconst a = 1;\n```");

    const copy = message.querySelector<HTMLButtonElement>("button[aria-label='Copy code']")!;
    fireEvent.click(copy);

    expect(writeText).toHaveBeenCalledWith("const a = 1;");
    await waitFor(() => expect(copy.textContent).toBe("Copied"));
  });

  it("copies the pretty-printed JSON of a whole-Message block", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const message = await shown('{"a":1}');

    fireEvent.click(message.querySelector("button[aria-label='Copy code']")!);

    expect(writeText).toHaveBeenCalledWith('{\n  "a": 1\n}');
  });

  it("starts a long block collapsed, and shows all its lines on request", async () => {
    const message = await shown(`\`\`\`\n${lines(40)}\n\`\`\``);

    const toggle = message.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("Show all 40 lines");
    expect(message.querySelector("[data-collapsed]")).not.toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Show fewer lines");
    expect(message.querySelector("[data-collapsed]")).toBeNull();
  });

  it("doesn't collapse a short block", async () => {
    const message = await shown(`\`\`\`\n${lines(5)}\n\`\`\``);

    expect(message.querySelector("button[aria-expanded]")).toBeNull();
    expect(message.querySelector("[data-collapsed]")).toBeNull();
  });

  it("scrolls wide code and tables inside their block", async () => {
    const message = await shown("```\nwide\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");

    expect(message.querySelector("pre")!.parentElement!.className).toContain("overflow-x-auto");
    expect(message.querySelector("table")!.parentElement!.className).toContain("overflow-x-auto");
    expect(message.parentElement!.className).toContain("min-w-0");
  });
});

describe("a Message's time", () => {
  it("is in the Message, revealed on hover and on keyboard focus", async () => {
    const message = await shown("hello");
    const root = message.parentElement!;
    const time = root.querySelector("time");

    expect(time?.getAttribute("datetime")).toBe(createdAt.toISOString());
    expect(time?.className).toContain("group-hover:opacity-100");
    expect(time?.className).toContain("group-focus-within:opacity-100");
    expect(root.getAttribute("tabindex")).toBe("0");
  });
});

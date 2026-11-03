import type { RichControl } from "@botsdk/client/bot/rich-control";
import { describe, expect, it } from "vitest";

import {
  emailBody,
  headerText,
  maxAttachedBytes,
  namedAddress,
  replySubject,
} from "../../src/channel/internal";

const botUrl = "https://app.example/bots/b1";
const file = (id: string, name: string, size: number) => ({
  id: `0199d3a0-0000-7000-8000-00000000000${id}`,
  name,
  size,
  mediaType: "text/csv",
});

const lastLineOf = (control: RichControl) =>
  emailBody({ text: "Hi.", control }, { botUrl }).text.split("\n").at(-1);

describe("emailBody", () => {
  it("sends text as plain text plus simple, escaped HTML", () => {
    const body = emailBody({ text: '1 < 2 & "so"\nnext line' }, { botUrl });

    expect(body.text).toBe('1 < 2 & "so"\nnext line');
    expect(body.html).toBe("<p>1 &lt; 2 &amp; &quot;so&quot;<br>next line</p>");
    expect(body).not.toHaveProperty("attachments");
  });

  it("attaches files that fit in 10 MB in total", () => {
    const report = file("1", "report.csv", 8);
    const bytes = new TextEncoder().encode("a,b\n1,2\n");

    const body = emailBody(
      { text: "Here it is.", control: { kind: "files", files: [report] } },
      { botUrl, files: [{ file: report, bytes }] },
    );

    expect(body.attachments).toEqual([
      { name: "report.csv", contentType: "text/csv", content: bytes },
    ]);
    expect(body.text).toBe("Here it is.");
  });

  it("links files over 10 MB in total, or gone from storage, instead of attaching them", () => {
    const big = file("1", "big.csv", maxAttachedBytes);
    const small = file("2", "small.csv", 1);
    const control: RichControl = { kind: "files", files: [big, small] };

    for (const files of [
      [
        { file: big, bytes: null },
        { file: small, bytes: null },
      ],
      [{ file: small, bytes: null }],
    ]) {
      const body = emailBody({ text: "Here.", control }, { botUrl, files });
      expect(body).not.toHaveProperty("attachments");
      expect(body.text).toBe(
        ["Here.", "", "- big.csv\n- small.csv", "", `Download them in the app: ${botUrl}`].join(
          "\n",
        ),
      );
      expect(body.html).toContain("<ul><li>big.csv</li><li>small.csv</li></ul>");
    }
  });

  it("reduces each card to one line and a link", () => {
    expect(
      lastLineOf({
        kind: "computer",
        helperId: "h1",
        reason: "Log in",
        state: "open",
      } as RichControl),
    ).toBe(`Take over the Computer in the app: ${botUrl}`);
    expect(
      lastLineOf({
        kind: "demonstration",
        demonstrationId: "d1",
        goal: "File it",
        state: "recording",
        startedAt: "2026-10-22T09:00:00.000Z",
        endedAt: null,
        steps: 0,
      } as RichControl),
    ).toBe(`Show me in the app: ${botUrl}`);
    expect(lastLineOf({ kind: "routine_approval", routineId: "r1" } as RichControl)).toBe(
      `Approve or decline in the app: ${botUrl}`,
    );
    // A release Approval is answered only on its page.
    expect(
      lastLineOf({
        kind: "release_approval",
        representativeId: "rep-1",
        representativeName: "Front desk",
        path: "/representatives/rep-1",
        expiresAt: "2026-11-10T09:00:00.000Z",
      } as RichControl),
    ).toBe(`Review it in the app: ${botUrl}`);
    expect(lastLineOf({ kind: "review_approval", reviewId: "v1" } as RichControl)).toBe(
      `Approve or decline in the app: ${botUrl}`,
    );
    expect(
      emailBody(
        { text: "Hi.", control: { kind: "routine_approval", routineId: "r1" } as RichControl },
        { botUrl },
      ).text.split("\n"),
    ).toHaveLength(3);
  });

  it("sends a Secret request as a link only, naming no field to answer in", () => {
    const body = emailBody(
      {
        text: "I need your token.",
        control: { kind: "secret", name: "GITHUB_TOKEN", why: "To push." },
      },
      { botUrl },
    );

    expect(body.text).toBe(`I need your token.\n\nEnter it securely in the app: ${botUrl}`);
  });
});

describe("replySubject", () => {
  it("answers with one Re:, and the fallback for an empty subject", () => {
    expect(replySubject("Plans", "Ada")).toBe("Re: Plans");
    expect(replySubject("RE: re:Plans", "Ada")).toBe("Re: Plans");
    expect(replySubject("Two\r\nlines", "Ada")).toBe("Re: Two lines");
    expect(replySubject("  ", "Ada")).toBe("Re: Ada");
    expect(replySubject("", "Ada\r\nBcc: x@example.com")).toBe("Re: Ada Bcc: x@example.com");
    expect(headerText("Ada\r\nBcc: x@example.com")).toBe("Ada Bcc: x@example.com");
  });
});

describe("namedAddress", () => {
  it("quotes the Bot's name so it can't break the header", () => {
    expect(namedAddress('Ada "the" Bot\r\nBcc: x', "a.b@bots.example")).toBe(
      '"Ada \\"the\\" Bot Bcc: x" <a.b@bots.example>',
    );
  });
});

describe("emailBody with Markdown (spec #1117)", () => {
  const source = [
    "# Plan",
    "",
    "Some **bold**, _soft_ and `code` with [a link](https://example.com/a?x=1&y=2).",
    "",
    "- one",
    "- two",
    "",
    "1. first",
    "2. second",
    "",
    "> quoted",
    "",
    "| Name | Qty |",
    "| :--- | ---: |",
    "| Apples | 3 |",
    "| Figs | 12 |",
    "",
    "```ts",
    "const a = 1 < 2;",
    "```",
  ].join("\n");

  it("renders headings, lists, tables, code, quotes and links in the HTML part", () => {
    const { html } = emailBody({ text: source }, { botUrl });

    expect(html).toContain("<h1>Plan</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>soft</em>");
    expect(html).toMatch(/<code[^>]*>code<\/code>/);
    expect(html).toContain('<a href="https://example.com/a?x=1&amp;y=2">a link</a>');
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(html).toContain("<blockquote");
    expect(html).toMatch(
      /<table[\s\S]*<th[^>]*>Name<\/th>[\s\S]*<td[^>]*>Apples<\/td>[\s\S]*<\/table>/,
    );
    expect(html).toContain("const a = 1 &lt; 2;");
    expect(html).toMatch(/<pre[\s\S]*<code[\s\S]*<\/pre>/);
  });

  it("sends clean text with no Markdown characters, a table as aligned text", () => {
    const { text } = emailBody({ text: source }, { botUrl });

    expect(text).not.toMatch(/[*_`#|]|\]\(/);
    expect(text).toContain("Plan");
    expect(text).toContain("a link (https://example.com/a?x=1&y=2)");
    expect(text).toContain("Name    Qty\nApples    3\nFigs     12");
  });

  it("keeps a single line break as a line break in both parts", () => {
    const body = emailBody({ text: "one\ntwo" }, { botUrl });

    expect(body.text).toBe("one\ntwo");
    expect(body.html).toContain("one<br>two");
  });

  it("keeps a word in angle brackets, escaped in the HTML part", () => {
    const body = emailBody({ text: "Use Array<string> here" }, { botUrl });
    expect(body.text).toBe("Use Array<string> here");
    expect(body.html).toContain("Use Array&lt;string&gt; here");
  });

  it.each([
    ["convert <input> <output>", "convert &lt;input&gt; &lt;output&gt;"],
    ["cp <source> <target>", "cp &lt;source&gt; &lt;target&gt;"],
    ["Array<object>", "Array&lt;object&gt;"],
    ["Box<U>", "Box&lt;U&gt;"],
    ["React.FC<P>", "React.FC&lt;P&gt;"],
    ["<b>bold</b>", "&lt;b&gt;bold&lt;/b&gt;"],
  ])("keeps %s in both parts, escaped in the HTML", (source, escaped) => {
    const body = emailBody({ text: source }, { botUrl });
    expect(body.text).toBe(source);
    expect(body.html).toContain(escaped);
    expect(body.html).not.toContain("<b>");
  });

  it.each([
    "before <script src=x",
    "before <img src=x onerror=alert(1) after",
    "before <img\nsrc=x onerror=alert(1)",
    "<scr<script>ipt>",
    "a &lt;script&gt; b",
  ])("takes no tag through either part from %s", (source) => {
    const { text, html } = emailBody({ text: source }, { botUrl });
    for (const part of [text, html]) {
      expect(part).not.toMatch(/<(script|img)|&lt;(script|img)|onerror/i);
    }
  });

  it("never lets a script, a javascript: link or a remote image through", () => {
    const hostile = [
      "<script>alert(1)</script>",
      "",
      "[click](javascript:alert(1)) [data](data:text/html,x)",
      "",
      "![pixel](https://evil.example/p.png)",
      "",
      '<img src="https://evil.example/q.png" onerror="x()">',
      "",
      "<b onclick=x()>raw</b>",
    ].join("\n");

    const { text, html } = emailBody({ text: hostile }, { botUrl });

    for (const part of [text, html]) {
      expect(part).not.toMatch(/<script|javascript:|evil\.example|<img|onerror|onclick|data:text/i);
    }
    expect(html).not.toContain("<b");
    expect(html).toContain("click");
  });

  it("keeps a loose list item's paragraphs and blocks apart", () => {
    const { html } = emailBody({ text: "- first\n\n  second\n\n  ```\n  x\n  ```" }, { botUrl });

    expect(html).toContain("<li><p>first</p>\n<p>second</p>\n<pre");
  });

  it("escapes text that looks like HTML", () => {
    const { html } = emailBody({ text: 'use `<div>` & "x"' }, { botUrl });

    expect(html).toContain("&lt;div&gt;");
    expect(html).not.toContain("<div>");
  });

  it("renders a Rich control's lines after the Markdown", () => {
    const { text, html } = emailBody(
      { text: "**Pick**", control: { kind: "choice", options: ["A", "B"] } as RichControl },
      { botUrl },
    );

    expect(text).toBe(`Pick\n\n1. A\n2. B\n\nAnswer in the app: ${botUrl}`);
    expect(html).toContain("<strong>Pick</strong>");
    expect(html).toContain("<ol><li>A</li><li>B</li></ol>");
    expect(html).toContain(`<a href="${botUrl}">Answer in the app</a>`);
  });
});

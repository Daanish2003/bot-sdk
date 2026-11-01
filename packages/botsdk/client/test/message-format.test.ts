import { describe, expect, it } from "vitest";

import { oneLine, parseMessage, plainText } from "@botsdk/client/message-format";

describe("oneLine", () => {
  it("is the first line with no Markdown characters", () => {
    expect(
      oneLine("## **Your** _train_ `leaves` ~~now~~ at [nine](https://a.example)\nPlatform 4"),
    ).toBe("Your train leaves now at nine");
  });

  it("stops at a single line break", () => {
    expect(oneLine("\n\nYour train leaves at 9.\nPlatform 4.")).toBe("Your train leaves at 9.");
  });

  it("reads the first item of a list or a quote without its marker", () => {
    expect(oneLine("- first\n- second")).toBe("first");
    expect(oneLine("1. first\n2. second")).toBe("first");
    expect(oneLine("> quoted\n> more")).toBe("quoted");
  });

  it("collapses runs of whitespace", () => {
    expect(oneLine("one   two")).toBe("one two");
  });

  it("skips a code block or table that opens the Message, to its first ordinary line", () => {
    expect(oneLine("```ts\nconst a = 1;\n```\n\nThat's the fix.\nMore.")).toBe("That's the fix.");
    expect(oneLine("| a | b |\n|---|---|\n| 1 | 2 |\n\nThe totals.")).toBe("The totals.");
    expect(oneLine("    indented\n\nAfter.")).toBe("After.");
  });

  it('is "Code" or "Table" when the Message has no ordinary line', () => {
    expect(oneLine("```\nconst a = 1;\n```")).toBe("Code");
    expect(oneLine("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("Table");
    expect(oneLine("- ```\n  x\n  ```")).toBe("Code");
  });

  it("names what opens the Message when it has both", () => {
    expect(oneLine("```\nx\n```\n\n| a |\n|---|\n| 1 |")).toBe("Code");
    expect(oneLine("| a |\n|---|\n| 1 |\n\n```\nx\n```")).toBe("Table");
  });

  it("is empty when there's nothing to show", () => {
    expect(oneLine("")).toBe("");
    expect(oneLine("---")).toBe("");
    expect(oneLine("![a cat](https://evil.example/cat.png)")).toBe("");
    expect(oneLine("<div></div>")).toBe("");
  });

  it("previews a JSON Message as code, whatever its length, so asterisks aren't lost", () => {
    expect(oneLine('{"sum": "2*3*4"}')).toBe("Code");
    expect(oneLine(JSON.stringify({ text: "a*b*c ".repeat(2000) }))).toBe("Code");
  });

  it("leaves JSON inside a sentence alone", () => {
    expect(oneLine('The value is {"a": 1}.')).toBe('The value is {"a": 1}.');
  });

  it("finds the line after a long code block, and a reference link's address after long text", () => {
    const code = `\`\`\`ts\n${"const a = 1;\n".repeat(1000)}\`\`\``;
    expect(oneLine(`${code}\n\nThat's the fix.`)).toBe("That's the fix.");
    expect(oneLine(`[click][1]\n\n${code}\n\n[1]: https://a.example`)).toBe("click");
  });

  it("stays quick on the source that costs the parser most", () => {
    const started = performance.now();
    expect(oneLine("*a ".repeat(100_000))).toContain("a");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("never throws, even on source that runs the parser out of stack", () => {
    expect(oneLine(`${">".repeat(100_000)} x`)).toBe("x");
  });
});

describe("what never comes through", () => {
  const unsafe = [
    ["a script block", "<script>alert(1)</script>"],
    ["a script in a line", "before <script>alert(1)</script> after"],
    ["a style in a line", "before <style>x{}</style> after"],
    ["a mixed-case script", "before <ScRiPt>alert(1)</sCrIpT> after"],
    ["a tag's attributes", 'before <img src=x onerror="alert(1)"> after'],
    ["an image", "before ![alt](https://evil.example/a.png) after"],
    ["an image by reference", "before ![alt][1] after\n\n[1]: https://evil.example/a.png"],
  ];

  it.each(unsafe)("%s, in plain text or one line", (_name, source) => {
    for (const text of [plainText(source), oneLine(source)]) {
      expect(text).not.toMatch(/<|alert|onerror|evil\.example|alt|x\{\}/i);
    }
  });

  it("takes nothing unsafe through marks inside a word", () => {
    for (const source of [
      "a*b<script>alert(1)</script>c*d",
      "a*b![alt](https://evil.example/a.png)c*d",
    ]) {
      expect(plainText(source)).toBe("a*bc*d");
    }
    expect(plainText("a*b[click](javascript:alert(1))c*d")).toBe("a*bclickc*d");
  });

  it("takes nothing unsafe through source that runs the parser out of stack", () => {
    const source = `${">".repeat(100_000)} <script>alert(1)</script> ![alt](https://evil.example/a.png) x`;
    expect(plainText(source)).toBe("x");
  });

  it("takes nothing unsafe through a run too long to read at once", () => {
    const source = `${"word ".repeat(2000)}<script>alert(1)</script> ![alt](https://evil.example/a.png) [x](javascript:y)`;
    expect(plainText(source)).not.toMatch(/<|alert|evil|javascript/);
  });

  it("keeps the words of block HTML, without its tags or hidden elements", () => {
    expect(oneLine("<div>Your train leaves at 9</div>")).toBe("Your train leaves at 9");
    expect(plainText("<details>\nhello\n<script>alert(1)</script>\nthere\n</details>")).toBe(
      "hello\nthere",
    );
    expect(plainText("<script>alert(1)\nmore")).toBe("");
  });

  it("drops all of a block tag or comment with a `>` inside it", () => {
    expect(plainText('<!-- a > b -->\n\n<div title="a>b">words</div>')).toBe("words");
  });

  it("keeps a line that only names a tag", () => {
    expect(plainText("The <script> tag runs code.")).toBe("The  tag runs code.");
  });

  it("reads an HTML line break as a line break", () => {
    expect(plainText("hello<br>world<br/>again")).toBe("hello\nworld\nagain");
  });

  it("keeps the words around raw HTML", () => {
    expect(oneLine("<b>bold</b> before <script>alert(1)</script> after")).toBe("bold before after");
    expect(plainText("before ![alt](https://evil.example/a.png) after")).toBe("before  after");
  });

  it("drops an image used as a link's text, and the link with it", () => {
    expect(plainText("x [![alt](https://evil.example/a.png)](https://a.example)")).toBe("x ");
  });

  const unsafeLinks = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "&#106;avascript:alert(1)",
    "&#x6A;avascript:alert(1)",
    "java%0ascript:alert(1)",
    "data:text/html,hi",
    "vbscript:x",
    "file:///etc/passwd",
    "tel:+123",
    "/relative",
    "#fragment",
    "//evil.example",
  ];

  it.each(unsafeLinks)("a link to %s becomes its plain text", (href) => {
    const source = `[click here](${href})`;
    expect(oneLine(source)).toBe("click here");
    expect(plainText(source)).toBe("click here");
    expect(parseMessage(source)).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "click here" }] },
    ]);
  });

  it("an unsafe link by reference or autolink is plain text too", () => {
    expect(plainText("[click][1]\n\n[1]: javascript:alert(1)")).toBe("click");
    expect(parseMessage("<javascript:alert(1)>")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "javascript:alert(1)" }] },
    ]);
  });

  it.each(["http://a.example/", "https://a.example/", "HTTPS://a.example/", "mailto:a@a.example"])(
    "a link to %s stays a link",
    (href) => {
      const [paragraph] = parseMessage(`[click](${href})`);
      expect(paragraph).toEqual({
        type: "paragraph",
        children: [
          {
            type: "link",
            href: href.replace("HTTPS", "https"),
            children: [{ type: "text", text: "click" }],
          },
        ],
      });
    },
  );
});

describe("text as written", () => {
  it("leaves arithmetic and ranges intact", () => {
    for (const text of ["2*3*4", "2*3*4*5*6", "2**3**4", "5~10~20", "snake_case_name"]) {
      expect(plainText(text)).toBe(text);
      expect(parseMessage(text)).toEqual([
        { type: "paragraph", children: [{ type: "text", text }] },
      ]);
    }
  });

  it("still reads marks that touch punctuation or a word's edge as formatting", () => {
    expect(plainText("**3.1**% *a* b**c**")).toBe("3.1% a bc");
  });

  it("reads marks between letters of a language written without spaces as formatting", () => {
    expect(plainText("这是**重要**的")).toBe("这是重要的");
  });

  it("reads a long run in time that grows with its length", () => {
    const started = performance.now();
    expect(plainText("*a ".repeat(30_000))).toContain("a");
    expect(performance.now() - started).toBeLessThan(20_000);
  });

  it("keeps formatting in a long run", () => {
    expect(plainText(`${"word ".repeat(2000)}**end**`)).toBe(`${"word ".repeat(2000)}end`);
  });

  it("takes an escaped character as itself", () => {
    expect(plainText("\\*not bold\\* 2\\*3")).toBe("*not bold* 2*3");
  });

  it("reads entities as what they stand for", () => {
    expect(plainText("Tom &amp; Jerry &lt;3 &#39;x&#x27; &bogus; & more")).toBe(
      "Tom & Jerry <3 'x' &bogus; & more",
    );
  });

  it("leaves an unknown entity alone, whatever its name", () => {
    expect(plainText("&constructor; &toString;")).toBe("&constructor; &toString;");
  });

  it("keeps a JSON Message whole", () => {
    const source = '{"sum": "2*3*4", "b": "**x**"}';
    expect(parseMessage(`\n${source}\n`)).toEqual([
      { type: "code", language: "json", text: source },
    ]);
    expect(plainText(source)).toBe(source);
  });

  it("shows source the parser can't read as text", () => {
    expect(parseMessage(`${">".repeat(100_000)} x`)).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "x" }] },
    ]);
  });
});

describe("parseMessage", () => {
  it("gives a renderer each kind of block, with no Channel's format in it", () => {
    const source = [
      "# Title",
      "",
      "One **bold** *em* ~~gone~~ `code`",
      "two [link](https://a.example/)",
      "",
      "> quoted",
      "",
      "3. three",
      "4. four",
      "   - nested",
      "",
      "```ts title",
      "const a = 1;",
      "```",
      "",
      "| A | B |",
      "|:--|--:|",
      "| 1 | **2** |",
      "",
      "---",
    ].join("\n");

    const text = (value: string) => ({ type: "text", text: value });
    expect(parseMessage(source)).toEqual([
      { type: "heading", level: 1, children: [text("Title")] },
      {
        type: "paragraph",
        children: [
          text("One "),
          { type: "strong", children: [text("bold")] },
          text(" "),
          { type: "emphasis", children: [text("em")] },
          text(" "),
          { type: "strikethrough", children: [text("gone")] },
          text(" "),
          { type: "code", text: "code" },
          { type: "break" },
          text("two "),
          { type: "link", href: "https://a.example/", children: [text("link")] },
        ],
      },
      { type: "quote", children: [{ type: "paragraph", children: [text("quoted")] }] },
      {
        type: "list",
        ordered: true,
        start: 3,
        items: [
          [{ type: "paragraph", children: [text("three")] }],
          [
            { type: "paragraph", children: [text("four")] },
            {
              type: "list",
              ordered: false,
              start: 1,
              items: [[{ type: "paragraph", children: [text("nested")] }]],
            },
          ],
        ],
      },
      { type: "code", language: "ts", text: "const a = 1;" },
      {
        type: "table",
        align: ["left", "right"],
        header: [[text("A")], [text("B")]],
        rows: [[[text("1")], [{ type: "strong", children: [text("2")] }]]],
      },
      { type: "rule" },
    ]);
  });

  it("keeps an @name in code apart from one in text", () => {
    expect(parseMessage("_@Ada_ `@Grace`")).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "emphasis", children: [{ type: "text", text: "@Ada" }] },
          { type: "text", text: " " },
          { type: "code", text: "@Grace" },
        ],
      },
    ]);
  });
});

describe("plainText", () => {
  it("has no Markdown characters", () => {
    expect(
      plainText(
        "# Title\n\nOne **bold** _em_ ~~gone~~ `code`\ntwo\n\n> quoted\n> more\n\n- a\n  - b\n\n2. c\n3. d\n\n---\n\nEnd",
      ),
    ).toBe(
      "Title\n\nOne bold em gone code\ntwo\n\n  quoted\n  more\n\n• a\n  • b\n\n2. c\n3. d\n\nEnd",
    );
  });

  it("keeps a code block's text as written", () => {
    expect(plainText("```\n# not a heading\n**x**\n```")).toBe("# not a heading\n**x**");
  });

  it("follows a link's text with its address, unless it is the address", () => {
    expect(plainText("[docs](https://a.example/) https://b.example/ a@c.example")).toBe(
      "docs (https://a.example/) https://b.example/ a@c.example",
    );
    expect(
      plainText("https://a.example www.b.example [https://c.example](https://c.example)"),
    ).toBe("https://a.example www.b.example https://c.example");
  });

  it("aligns a table's columns, on the right where it says so", () => {
    expect(plainText("| Name | Cost |\n|---|--:|\n| Ada | 3 |\n| Grace **H** | 100 |")).toBe(
      ["Name     Cost", "Ada         3", "Grace H   100"].join("\n"),
    );
  });
});

import { describe, expect, it } from "vitest";

import { messagingBody } from "../../src/channel/messaging-out";

const appUrl = "https://app.example/bots/b1";
const body = (text: string, control?: Parameters<typeof messagingBody>[0]["control"]) =>
  messagingBody({ id: "m1", text, control }, { appUrl, uploadLimit: 100 });

describe("messagingBody", () => {
  it("leaves the Message's text as written, and carries a choice's options as a list", () => {
    const { text, control } = body("1. Foo", {
      kind: "choice",
      options: ["**Yes**", "No"],
      other: true,
    });

    expect(text).toBe("1. Foo");
    expect(control).toEqual([
      {
        type: "list",
        ordered: true,
        start: 1,
        items: ["**Yes**", "No", "Other: reply with your own answer"].map((item) => [
          { type: "paragraph", children: [{ type: "text", text: item }] },
        ]),
      },
    ]);
  });

  it("carries a link into the app as a link, whatever the Message's text left open", () => {
    const { text, control } = body("```\ncode", { kind: "secret", name: "T", why: "To push." });

    expect(text).toBe("```\ncode");
    expect(control).toEqual([
      {
        type: "paragraph",
        children: [
          {
            type: "link",
            href: appUrl,
            children: [{ type: "text", text: "Enter it securely in the app" }],
          },
        ],
      },
    ]);
  });

  it("has no lines for a Message with no control", () => {
    expect(body("Hello")).toEqual({ text: "Hello" });
  });
});

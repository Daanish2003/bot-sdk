import { oneLine, plainText } from "@botsdk/client/message-format";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "@/components/ui/prompt-kit/markdown";

/** What a reader of the web sees: the rendered page without its elements or escapes. */
const shownOnWeb = (source: string) =>
  renderToStaticMarkup(createElement(Markdown, null, source))
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .trim();

describe("words in angle brackets", () => {
  it.each([
    "convert <input> <output>",
    "cp <source> <target>",
    "Array<object>",
    "Box<U>",
    "React.FC<P>",
    "<b>bold</b>",
  ])("%s shows the same on the web and the Channels", (source) => {
    expect(shownOnWeb(source)).toBe(source);
    expect(plainText(source)).toBe(source);
    expect(oneLine(source)).toBe(source);
  });
});

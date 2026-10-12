import type { MessagePart } from "@tanstack/ai";
import { createElement, Fragment } from "react";
import type { Source } from "../../../core/shared/chat/sources";
import { pageSourcesOf, sourcesOf } from "../../../core/shared/chat/sources";
import { toolCallOf } from "../../../core/shared/chat/tool-call";
import { Markdown } from "@/components/ui/prompt-kit/markdown";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { replyComponents, ReplySources, SourceChips } from "../../../ui/chat/source-chips";
import { ToolCallRow } from "../../../ui/chat/tool-call-row";

const sources: Source[] = [
  { number: 1, url: "https://tanstack.com/ai", title: "TanStack AI", snippet: "Docs" },
  { number: 2, url: "https://example.com/blog", title: "Blog", snippet: "Post" },
];

const render = (markdown: string) =>
  renderToStaticMarkup(
    createElement(
      ReplySources.Provider,
      { value: sources },
      createElement(Markdown, { components: replyComponents, children: markdown }),
    ),
  );

describe("a reply's links", () => {
  it("render a link to one of this Message's Sources as its numbered citation chip", () => {
    const html = render("Lazy tools ([tanstack.com](https://tanstack.com/ai)).");

    expect(html).toMatch(
      /<a href="https:\/\/tanstack\.com\/ai"[^>]*data-slot="hover-card-trigger"><span[^>]*>1<\/span><\/a>/,
    );
    expect(html).not.toContain(">tanstack.com<");
  });

  it("leave any other link plain, opening in a new tab without referrer or endorsement", () => {
    const html = render("See [the spec](https://other.dev/spec).");

    expect(html).toContain(
      '<a href="https://other.dev/spec" target="_blank" rel="noopener noreferrer nofollow">the spec</a>',
    );
  });

  it("give citation chips the same new-tab rel", () => {
    expect(render("([x](https://example.com/blog))")).toContain(
      'target="_blank" rel="noopener noreferrer nofollow"',
    );
  });
});

describe("a fetched page", () => {
  it("shows its numbered Source chip under its call row", () => {
    const parts = [
      {
        type: "tool-call",
        id: "call-1",
        name: "fetch_url",
        arguments: JSON.stringify({ url: "https://example.com/page" }),
        input: { url: "https://example.com/page" },
        state: "complete",
        output: { url: "https://example.com/page", title: "Example page", content: "Hello." },
        metadata: { source: "builtin", status: "done" },
      },
    ] as MessagePart[];
    const found = sourcesOf(parts);
    const call = toolCallOf(parts[0]!)!;

    const html = renderToStaticMarkup(
      createElement(
        ReplySources.Provider,
        { value: found },
        createElement(
          Fragment,
          null,
          createElement(ToolCallRow, { call }),
          createElement(SourceChips, { sources: pageSourcesOf(call, found) }),
        ),
      ),
    );

    expect(html).toContain("fetch_url");
    expect(html.indexOf("fetch_url")).toBeLessThan(html.indexOf('data-slot="hover-card-trigger"'));
    expect(html).toMatch(/data-slot="hover-card-trigger"[\s\S]*?<span[^>]*>1<\/span>/);
  });
});

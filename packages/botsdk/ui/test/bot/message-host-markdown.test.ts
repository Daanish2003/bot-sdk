// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Message } from "../../src/bot/message";

// A Host's copy as the registry ships it: passing `components` replaces its renderers, and it has
// no rule of its own for links or images.
vi.mock("@/components/ui/prompt-kit/markdown", async () => {
  const { default: ReactMarkdown } = await import("../../../../ui/node_modules/react-markdown");
  return {
    Markdown: ({ children, components }: { children: string; components?: object }) =>
      createElement(ReactMarkdown, { components }, children),
  };
});

afterEach(cleanup);

const shown = (text: string) =>
  render(createElement(Message, { id: "m1", role: "assistant", text })).container;

describe("the safety rules on a Host's copy of the Markdown component", () => {
  it("doesn't load a remote image", () => {
    const message = shown("![a chart](https://attacker.example/a.png)");

    expect(message.querySelector("img")).toBeNull();
    expect(message.textContent).toContain("a chart");
  });

  it("shows raw HTML as harmless text", () => {
    const message = shown("<script>window.pwned = 1</script>");

    expect(message.querySelector("script")).toBeNull();
    expect(message.textContent).toContain("<script>");
  });

  it("shows a link outside http, https and mailto as plain text", () => {
    const message = shown("[irc](irc://example.com) and [rel](/settings)");

    expect(message.querySelector("a")).toBeNull();
    expect(message.textContent).toContain("irc and rel");
  });

  it("opens a link in a new tab, with the real address on hover", () => {
    const link = shown('[bank](https://attacker.example/x "bank.example")').querySelector("a")!;

    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("title")).toBe("https://attacker.example/x");
  });
});

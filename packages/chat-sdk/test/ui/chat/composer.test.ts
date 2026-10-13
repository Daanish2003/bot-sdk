import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { Composer } from "../../../ui/chat/composer";

describe("the composer after a refused Message", () => {
  it("keeps the text the user sent and shows the reason", () => {
    const html = renderToStaticMarkup(
      createElement(Composer, {
        onSend: () => {},
        value: "Please rephrase me",
        onValueChange: () => {},
        refusal: "Off-policy request",
      }),
    );

    expect(html).toContain("Please rephrase me");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Off-policy request");
  });

  it("shows no alert when nothing was refused", () => {
    const html = renderToStaticMarkup(
      createElement(Composer, { onSend: () => {}, value: "", onValueChange: () => {} }),
    );

    expect(html).not.toContain('role="alert"');
  });
});

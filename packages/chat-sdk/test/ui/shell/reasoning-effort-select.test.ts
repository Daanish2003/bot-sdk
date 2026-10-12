import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ReasoningSupport } from "../../../core/shared/chat/models";
import { ReasoningEffortSelect } from "../../../ui/shell/reasoning-effort-select";

const sonnetLike: { provider: string; reasoning: ReasoningSupport } = {
  provider: "anthropic",
  reasoning: { efforts: ["low", "medium", "high"], off: false, defaultEffort: null },
};

const render = (props: Parameters<typeof ReasoningEffortSelect>[0]) =>
  renderToStaticMarkup(createElement(ReasoningEffortSelect, props));

describe("the reasoning effort control", () => {
  it("is hidden for a Model that doesn't reason", () => {
    const model = {
      provider: "anthropic",
      reasoning: { efforts: [], off: false, defaultEffort: null },
    };

    expect(render({ model, value: null, onChange: () => {} })).toBe("");
  });

  it("is hidden for a Provider whose adapter takes no reasoning setting", () => {
    const model = { provider: "mistral", reasoning: sonnetLike.reasoning };

    expect(render({ model, value: null, onChange: () => {} })).toBe("");
  });

  it("is hidden until the selected Model is known", () => {
    expect(render({ model: undefined, value: null, onChange: () => {} })).toBe("");
  });

  it("shows the Model's default when the Conversation has no choice", () => {
    const html = render({ model: sonnetLike, value: null, onChange: () => {} });

    expect(html).toContain('aria-label="Reasoning effort"');
    expect(html).toContain("Model default");
  });

  it("shows the Model's default for a stored choice the Model doesn't offer", () => {
    // `off` isn't offered by this Model, so the stored choice reads as the default.
    const html = render({ model: sonnetLike, value: "off", onChange: () => {} });

    expect(html).toContain("Model default");
    expect(html).not.toContain(">Off<");
  });

  it("shows the stored choice when the Model offers it", () => {
    const html = render({ model: sonnetLike, value: "high", onChange: () => {} });

    expect(html).toContain(">High<");
  });
});

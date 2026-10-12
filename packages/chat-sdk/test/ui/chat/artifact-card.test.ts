import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { storedParts } from "../../../core/shared/message-parts";
import { toUIParts } from "../../../core/shared/chat/parts";
import { toolCallOf } from "../../../core/shared/chat/tool-call";
import { ArtifactCard } from "../../../ui/chat/artifact-card";

const callOf = (fields: Record<string, unknown>) => {
  const call = toolCallOf({
    type: "tool-call",
    id: "call-1",
    name: "create_artifact",
    arguments: JSON.stringify({ kind: "html", title: "Landing page" }),
    input: { kind: "html", title: "Landing page" },
    state: "input-complete",
    metadata: { source: "builtin", status: "running" },
    ...fields,
  } as never);
  if (!call) throw new Error("Expected a tool call");
  return call;
};

const done = {
  state: "complete",
  output: { artifactId: "abc", version: 1 },
  metadata: { source: "builtin", status: "done" },
};

describe("an Artifact card in a reply", () => {
  it("shows the title and what was made, as a button that opens the version", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactCard, { call: callOf(done), onOpen: () => {} }),
    );

    expect(html).toContain("Landing page");
    expect(html).toContain("Created v1 · HTML");
    expect(html).toContain("<button");
  });

  it("reads Writing… while the call runs, and is not a button yet", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactCard, { call: callOf({}), onOpen: () => {} }),
    );

    expect(html).toContain("Writing…");
    expect(html).not.toContain("<button");
  });

  it("reads Not saved when the call failed and saved no version", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactCard, {
        call: callOf({
          state: "output-error",
          output: { error: "Input validation failed" },
          metadata: { source: "builtin", status: "error" },
        }),
        onOpen: () => {},
      }),
    );

    expect(html).toContain("Not saved");
    expect(html).not.toContain("Created");
  });

  it("is rebuilt from a stored artifact part with the same title, kind and version", () => {
    const [part] = toUIParts(
      storedParts([
        {
          type: "artifact",
          artifactId: "abc",
          version: 2,
          title: "Notes",
          kind: "markdown",
          state: "done",
        },
      ]),
    );
    const call = toolCallOf(part!);
    if (!call) throw new Error("Expected a tool call");

    const html = renderToStaticMarkup(createElement(ArtifactCard, { call, onOpen: () => {} }));

    expect(html).toContain("Notes");
    expect(html).toContain("Created v2 · Markdown");
  });
});

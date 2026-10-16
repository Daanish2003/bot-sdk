import { createElement } from "react";
import { renderEnglish as renderToStaticMarkup } from "../fake-dictionary";
import { describe, expect, it } from "vitest";

import { storedParts } from "../../../plugins/assistant/shared/message-parts";
import { toUIParts } from "../../../plugins/assistant/shared/chat/parts";
import { toolCallOf } from "../../../plugins/assistant/shared/chat/tool-call";
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
      createElement(ArtifactCard, { call: callOf(done), messageId: "m-1", onOpen: () => {} }),
    );

    expect(html).toContain("Landing page");
    expect(html).toContain("Created v1 · HTML");
    expect(html).toContain("<button");
  });

  it("reads Writing… while the call runs, and is not a button yet", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactCard, { call: callOf({}), messageId: "m-1", onOpen: () => {} }),
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
        messageId: "m-1",
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

    const html = renderToStaticMarkup(
      createElement(ArtifactCard, { call, messageId: "m-1", onOpen: () => {} }),
    );

    expect(html).toContain("Notes");
    expect(html).toContain("Updated to v2");
  });

  it("reads Updated to vN for a call that saved a later version, opening it on its Message", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactCard, {
        call: callOf({
          name: "update_artifact",
          input: { artifactId: "abc", title: "Notes" },
          output: { artifactId: "abc", version: 3 },
          metadata: { source: "builtin", status: "done" },
        }),
        messageId: "m-3",
        onOpen: () => {},
      }),
    );

    expect(html).toContain("Updated to v3");
    expect(html).toContain("<button");
  });

  it("reads Updating to vN while an update runs, N being the next version on the Branch", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactCard, {
        call: callOf({
          name: "update_artifact",
          input: { artifactId: "abc" },
          arguments: JSON.stringify({ artifactId: "abc", edits: [] }),
        }),
        messageId: "m-4",
        latestVersion: 3,
        onOpen: () => {},
      }),
    );

    expect(html).toContain("Updating to v4…");
    expect(html).not.toContain("<button");
  });

  it("reads Cut off, not saved when the call ended before it ran", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactCard, {
        call: callOf({
          state: "input-complete",
          metadata: { source: "builtin", status: "cancelled" },
        }),
        messageId: "m-1",
        onOpen: () => {},
      }),
    );

    expect(html).toContain("Cut off, not saved");
    expect(html).not.toContain("Writing…");
  });
});

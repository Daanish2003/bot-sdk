import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ArtifactPanelView,
  artifactVersionsOn,
  type ArtifactVersionContent,
  codeLanguageOf,
  copyArtifact,
} from "../../../ui/chat/artifact-panel";

const version: ArtifactVersionContent = {
  number: 1,
  title: "Landing page",
  kind: "html",
  language: null,
  content: "<h1>Hello from the page</h1>",
};

const render = (fields: Partial<ArtifactVersionContent> = {}) =>
  renderToStaticMarkup(
    createElement(ArtifactPanelView, { version: { ...version, ...fields }, onClose: () => {} }),
  );

describe("the Artifact panel", () => {
  it("shows the title, the kind and the source", () => {
    const html = render();

    expect(html).toContain("Landing page");
    expect(html).toContain("HTML");
    expect(html).toContain("&lt;h1&gt;Hello from the page&lt;/h1&gt;");
  });

  it("names its download after the title and the kind's extension", () => {
    expect(render()).toContain('data-download-name="Landing page.html"');
    expect(render({ kind: "code", language: "python", title: "Sorter" })).toContain(
      'data-download-name="Sorter.py"',
    );
  });

  it("has copy, download and close, and is full screen at phone width", () => {
    const html = render();

    expect(html).toContain('aria-label="Copy"');
    expect(html).toContain('aria-label="Download"');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("max-md:fixed");
    expect(html).toContain("md:w-1/2");
  });

  it("highlights code by its language, and the other kinds by their own", () => {
    expect(codeLanguageOf("code", "python")).toBe("python");
    expect(codeLanguageOf("code", null)).toBe("text");
    expect(codeLanguageOf("markdown", null)).toBe("markdown");
    expect(codeLanguageOf("svg", null)).toBe("xml");
  });
});

describe("the version dropdown", () => {
  const ref = (number: number, messageId: string) => ({
    artifactId: "abc",
    version: number,
    messageId,
  });
  /** A Message whose parts hold the `artifact` version it wrote, as the client sees them. */
  const writes = (id: string, number: number | null, artifactId = "abc") => ({
    id,
    parts:
      number === null
        ? []
        : [
            {
              type: "tool-call",
              name: "update_artifact",
              output: { artifactId, version: number },
            },
          ],
  });

  it("lists only the versions on the given path, newest first, with the latest marked", () => {
    // Only the path's Messages are given: a sibling Branch's version never reaches the list.
    const path = [writes("m-1", 1), writes("m-2", 2), writes("m-3", 3)];

    const versions = artifactVersionsOn(path, "abc");

    expect(versions.map((item) => [item.version, item.messageId])).toEqual([
      [3, "m-3"],
      [2, "m-2"],
      [1, "m-1"],
    ]);
    const html = renderToStaticMarkup(
      createElement(ArtifactPanelView, {
        version: { ...version, number: 3 },
        versions,
        onSelect: () => {},
        onClose: () => {},
      }),
    );
    expect(html).toContain('aria-label="Version"');
    expect(html).toContain("v3 (latest)");
    expect(html).toContain(">v2<");
    expect(html).toContain('value="3" selected=""');
  });

  it("ignores other Artifacts' versions, and shows no dropdown for a single version", () => {
    const path = [writes("m-1", 1), writes("m-2", 1, "other")];

    expect(artifactVersionsOn(path, "abc")).toEqual([ref(1, "m-1")]);
    const html = renderToStaticMarkup(
      createElement(ArtifactPanelView, {
        version,
        versions: artifactVersionsOn(path, "abc"),
        onClose: () => {},
      }),
    );
    expect(html).not.toContain('aria-label="Version"');
  });
});

describe("copying an Artifact", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("copies the version's content to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await copyArtifact("<h1>Hi</h1>");

    expect(writeText).toHaveBeenCalledWith("<h1>Hi</h1>");
  });
});

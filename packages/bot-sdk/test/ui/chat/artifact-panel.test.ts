import { createElement } from "react";
import { renderEnglish as renderToStaticMarkup } from "../fake-dictionary";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ArtifactPanelView,
  artifactVersionsOn,
  type ArtifactVersionContent,
  codeLanguageOf,
  copyArtifact,
} from "../../../plugins/assistant/ui/chat/artifact-panel";

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
  it("shows the title and the kind, and the source on the Code tab", () => {
    const html = render({ kind: "code", language: "html" });

    expect(html).toContain("Landing page");
    expect(html).toContain("&lt;h1&gt;Hello from the page&lt;/h1&gt;");
    expect(html).not.toContain("<iframe");
  });

  it("shows each kind's tabs: code kinds show Code only, the others Preview and Code", () => {
    expect(render({ kind: "code", language: "python" })).not.toContain('role="tab"');
    for (const kind of ["markdown", "html", "svg", "mermaid"] as const) {
      const html = render({ kind });
      expect(html).toContain('role="tab"');
      expect(html).toContain(">Preview<");
      expect(html).toContain(">Code<");
    }
  });

  it("previews HTML and Mermaid in a frame with allow-scripts and no allow-same-origin", () => {
    for (const kind of ["html", "mermaid"] as const) {
      const html = render({ kind });
      expect(html).toContain('sandbox="allow-scripts"');
      expect(html).not.toContain("allow-same-origin");
      expect(html).toContain("<iframe");
    }
  });

  it("draws SVG as an img from a data: URL, with no frame", () => {
    const html = render({ kind: "svg", content: "<svg></svg>" });

    expect(html).toContain('<img src="data:image/svg+xml;charset=utf-8,');
    expect(html).not.toContain("<iframe");
  });

  it("renders Markdown in Preview, and its source on the Code tab", () => {
    const html = render({ kind: "markdown", content: "# Heading" });

    expect(html).toContain("<h1");
    expect(html).toContain("Heading");
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

describe("the panel on a Shared link", () => {
  const readOnly = (fields: Partial<ArtifactVersionContent> = {}) =>
    renderToStaticMarkup(
      createElement(ArtifactPanelView, {
        version: { ...version, ...fields },
        readOnly: true,
        onClose: () => {},
      }),
    );

  it("shows the read-only strip, and only then", () => {
    expect(readOnly()).toContain("Shared link · read-only");
    expect(render()).not.toContain("Shared link · read-only");
  });

  it("keeps copy and download on a Shared link", () => {
    const html = readOnly();

    expect(html).toContain('aria-label="Copy"');
    expect(html).toContain('data-download-name="Landing page.html"');
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
    metadata: { status: "complete" },
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

  it("lists only the versions of stored Messages, since a streaming one has no id the server knows", () => {
    // A Message still streaming has no metadata status, and a temporary id.
    const streamingWrite = { ...writes("temp-9", 3), metadata: undefined };
    const path = [writes("m-1", 1), streamingWrite];

    expect(artifactVersionsOn(path, "abc")).toEqual([ref(1, "m-1")]);
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

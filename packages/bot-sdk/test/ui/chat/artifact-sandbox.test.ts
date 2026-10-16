import { describe, expect, it } from "vitest";

import {
  artifactFrameCsp,
  artifactFrameDocument,
  artifactFrameSandbox,
  clampFrameHeight,
  frameMessageOf,
  maxFrameHeight,
  mermaidVersion,
  minFrameHeight,
  svgDataUrl,
} from "../../../plugins/assistant/ui/chat/artifact-sandbox";

const headOf = (document: string) => document.slice(0, document.indexOf("</head>"));

describe("the frame document", () => {
  it("puts the CSP meta first in <head>, even when the Model wrote its own head, meta and no html", () => {
    const documents = [
      "<h1>Plain</h1>",
      "<html><head><title>Own head</title><meta charset='utf-8'></head><body>x</body></html>",
      "<!doctype html><head><meta http-equiv='Content-Security-Policy' content=\"script-src *\"></head>",
    ].map((content) => artifactFrameDocument({ kind: "html", content }));

    for (const document of documents) {
      const head = headOf(document);
      expect(
        head.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"'),
      ).toBe(true);
    }
  });

  it("carries exactly the directives listed, with no 'self', and the bootstrap follows the meta", () => {
    expect(artifactFrameCsp.split("; ")).toEqual([
      `script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/mermaid@${mermaidVersion}/`,
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "img-src data: blob:",
      "font-src data: blob:",
      "media-src data: blob:",
    ]);
    expect(artifactFrameCsp).not.toContain("'self'");

    const document = artifactFrameDocument({ kind: "html", content: "<p>hi</p>" });
    const metaEnd = document.indexOf('">', document.indexOf("Content-Security-Policy")) + 2;
    expect(document.slice(metaEnd)).toMatch(/^<script>\(function \(\) \{/);
  });

  it("keeps the Model's markup in the body, after the head", () => {
    const document = artifactFrameDocument({ kind: "html", content: "<p>Hello</p>" });

    expect(document).toContain("</head><body><p>Hello</p></body>");
  });

  it("loads the pinned Mermaid release, the one the CSP allows, and renders strictly", () => {
    const document = artifactFrameDocument({ kind: "mermaid", content: "graph TD; A-->B" });

    expect(document).toContain(
      `import("https://cdn.jsdelivr.net/npm/mermaid@${mermaidVersion}/dist/mermaid.esm.min.mjs")`,
    );
    expect(document).toContain('securityLevel: "strict"');
    expect(artifactFrameCsp).toContain(`https://cdn.jsdelivr.net/npm/mermaid@${mermaidVersion}/`);
  });

  it("escapes Mermaid source so it can't end the diagram element", () => {
    const document = artifactFrameDocument({
      kind: "mermaid",
      content: 'graph TD; A["</pre><script>x</script>"]',
    });

    expect(document).toContain(
      '<pre id="diagram" class="mermaid">graph TD; A[&quot;&lt;/pre&gt;&lt;script&gt;x&lt;/script&gt;&quot;]</pre>',
    );
  });
});

describe("the frame's sandbox", () => {
  it("is exactly allow-scripts: no allow-same-origin, which would give the Model's page the app's origin", () => {
    expect(artifactFrameSandbox).toBe("allow-scripts");
  });
});

describe("the frame's messages", () => {
  const frame = { name: "frame window" };

  it("takes a resize from the frame's own window, clamped", () => {
    expect(
      frameMessageOf({ source: frame, data: { type: "artifact:resize", height: 420 } }, frame),
    ).toEqual({ type: "resize", height: 420 });
    expect(
      frameMessageOf({ source: frame, data: { type: "artifact:resize", height: 1e9 } }, frame),
    ).toEqual({ type: "resize", height: maxFrameHeight });
    expect(clampFrameHeight(3)).toBe(minFrameHeight);
  });

  it("ignores a message from any other source", () => {
    const other = { name: "another window" };

    expect(
      frameMessageOf({ source: other, data: { type: "artifact:resize", height: 400 } }, frame),
    ).toBeUndefined();
    expect(
      frameMessageOf({ source: other, data: { type: "artifact:error", message: "x" } }, frame),
    ).toBeUndefined();
    expect(
      frameMessageOf({ source: frame, data: { type: "artifact:resize", height: 400 } }, undefined),
    ).toBeUndefined();
  });

  it("ignores messages of the wrong shape", () => {
    for (const data of [
      null,
      "artifact:resize",
      { type: "artifact:resize", height: "tall" },
      { type: "artifact:resize", height: Number.NaN },
      { type: "other" },
    ]) {
      expect(frameMessageOf({ source: frame, data }, frame)).toBeUndefined();
    }
  });

  it("takes an error from the frame as its message, shown in the panel", () => {
    expect(
      frameMessageOf({ source: frame, data: { type: "artifact:error", message: "boom" } }, frame),
    ).toEqual({
      type: "error",
      message: "boom",
    });
  });
});

describe("SVG as an image", () => {
  it("is a data: URL that carries the markup", () => {
    expect(svgDataUrl("<svg><circle r='1'/></svg>")).toBe(
      "data:image/svg+xml;charset=utf-8,%3Csvg%3E%3Ccircle%20r%3D'1'%2F%3E%3C%2Fsvg%3E",
    );
  });
});

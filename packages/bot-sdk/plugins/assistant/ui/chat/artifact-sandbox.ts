/**
 * The sandbox an HTML or Mermaid Artifact's Preview runs in (spec #304, ADR 0016, #190). The SDK
 * builds the frame document: a CSP the Model's own markup can only tighten, a bootstrap script that
 * reports the frame's height and errors to the panel, and the Mermaid runner. The frame is rendered
 * with `sandbox="allow-scripts"` and no `allow-same-origin`, so it has an opaque origin and can't
 * read the app, its cookies or its storage.
 */

/** The Mermaid release the frame loads. Pinned exactly; the CSP allows only this release's path. */
export const mermaidVersion = "12.0.0";
const mermaidPath = `https://cdn.jsdelivr.net/npm/mermaid@${mermaidVersion}/`;
const mermaidModuleUrl = `${mermaidPath}dist/mermaid.esm.min.mjs`;

/** The attributes of the frame that shows an HTML or Mermaid Preview. Never add `allow-same-origin`. */
export const artifactFrameSandbox = "allow-scripts";

/**
 * The Content Security Policy every frame carries. Its directives are exact: no `'self'` (the frame
 * has an opaque origin), nothing may be fetched or posted (`connect-src`, `form-action`), and the
 * only images, fonts and media are inline `data:` or `blob:` ones.
 */
export const artifactFrameCsp = [
  `script-src 'unsafe-inline' https://cdnjs.cloudflare.com ${mermaidPath}`,
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src data: blob:",
].join("; ");

export const minFrameHeight = 80;
export const maxFrameHeight = 10000;

/** Keeps a height the frame reports within what the panel will draw. */
export function clampFrameHeight(height: number): number {
  return Math.min(maxFrameHeight, Math.max(minFrameHeight, Math.round(height)));
}

/** The longest error message the panel shows from a frame. */
const maxFrameMessage = 500;

/** What a frame reports to the panel: its content height, or a script error inside it. */
export type FrameMessage = { type: "resize"; height: number } | { type: "error"; message: string };

/**
 * The message the panel takes from a frame, or `undefined` for anything else. It accepts a message
 * only when it comes from the frame's own window (`frame`), and only when its shape is one the
 * bootstrap sends.
 */
export function frameMessageOf(
  event: { source: unknown; data: unknown },
  frame: unknown,
): FrameMessage | undefined {
  if (!frame || event.source !== frame) return undefined;
  const data = event.data as { type?: unknown; height?: unknown; message?: unknown } | null;
  if (typeof data !== "object" || data === null) return undefined;
  if (data.type === "artifact:resize") {
    if (typeof data.height !== "number" || !Number.isFinite(data.height)) return undefined;
    return { type: "resize", height: clampFrameHeight(data.height) };
  }
  if (data.type === "artifact:error") {
    if (typeof data.message !== "string") return undefined;
    return { type: "error", message: data.message.slice(0, maxFrameMessage) };
  }
  return undefined;
}

/** The bootstrap script: reports the content height and any script error to the parent panel. */
const bootstrapScript = `(function () {
  var post = function (message) { parent.postMessage(message, "*"); };
  var last = -1;
  var report = function () {
    var height = Math.ceil(document.body.scrollHeight);
    if (height !== last) { last = height; post({ type: "artifact:resize", height: height }); }
  };
  if (window.ResizeObserver) new ResizeObserver(report).observe(document.documentElement);
  addEventListener("load", report);
  addEventListener("error", function (event) {
    post({ type: "artifact:error", message: String(event.message || "Script error") });
  });
  addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    post({ type: "artifact:error", message: String((reason && reason.message) || reason) });
  });
})();`;

/** Runs the Mermaid source in the frame's `<pre>` with the strict security level. */
const mermaidScript = `(async function () {
  try {
    var mermaid = (await import(${JSON.stringify(mermaidModuleUrl)})).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    await mermaid.run({ nodes: [document.getElementById("diagram")] });
  } catch (error) {
    parent.postMessage({ type: "artifact:error", message: String((error && error.message) || error) }, "*");
  }
})();`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The document an HTML or Mermaid Artifact's frame loads (`srcdoc`). The CSP meta is always the
 * first element of `<head>`, followed by the bootstrap. The Model's markup goes in `<body>`, so a
 * `<head>`, `<html>` or `<meta>` the Model wrote can't come before or displace it. A CSP the Model
 * writes can only add restrictions.
 */
export function artifactFrameDocument({
  kind,
  content,
}: {
  kind: "html" | "mermaid";
  content: string;
}): string {
  const body =
    kind === "mermaid"
      ? `<pre id="diagram" class="mermaid">${escapeHtml(content)}</pre><script>${mermaidScript}</script>`
      : content;
  return [
    "<!doctype html>",
    "<html><head>",
    `<meta http-equiv="Content-Security-Policy" content="${artifactFrameCsp}">`,
    `<script>${bootstrapScript}</script>`,
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}

/** An SVG as an `<img>` source. Inside `<img>` the SVG runs no script and loads nothing. */
export function svgDataUrl(content: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`;
}

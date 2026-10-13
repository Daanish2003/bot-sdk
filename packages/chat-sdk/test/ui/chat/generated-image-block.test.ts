import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GeneratedImagePart } from "../../../core/shared/message-parts";
import {
  generatedImageErrorLabels,
  type GeneratedImageErrorReason,
} from "../../../core/shared/chat/generated-image";
import { GeneratedImageBlock, GeneratedImageViewer } from "../../../ui/chat/generated-image-block";

const image = (fields: Partial<GeneratedImagePart> = {}): GeneratedImagePart => ({
  type: "generated_image",
  toolCallId: "call-1",
  prompt: "a red bicycle",
  aspectRatio: "square",
  state: "running",
  ...fields,
});

const imagesUrl = "http://localhost/api/chat/generated-images";

const render = (part: GeneratedImagePart) =>
  renderToStaticMarkup(createElement(GeneratedImageBlock, { image: part, imagesUrl }));

describe("a generated image block", () => {
  it("shows a running placeholder with its counter and the prompt as the caption", () => {
    const html = render(image({ state: "running" }));

    expect(html).toContain("Generating image");
    expect(html).toContain("0s");
    expect(html).toContain("a red bicycle");
  });

  it.each(Object.keys(generatedImageErrorLabels) as GeneratedImageErrorReason[])(
    "shows the %s error by its label, with the prompt",
    (reason) => {
      const html = render(image({ state: "error", errorReason: reason }));

      // React escapes an apostrophe in the markup, so the label is compared as it is rendered.
      expect(html).toContain(generatedImageErrorLabels[reason].replaceAll("'", "&#x27;"));
      expect(html).toContain("a red bicycle");
    },
  );

  it("shows a stopped image as stopped before it was ready", () => {
    const html = render(image({ state: "cancelled" }));

    expect(html).toContain("Stopped before the image was ready");
    expect(html).toContain("a red bicycle");
    expect(html).not.toContain("Generating image");
  });

  it("shows a done image from the owner's route, with its prompt as the caption", () => {
    const html = render(image({ state: "done", imageId: "img-1" }));

    expect(html).toContain(`src="${imagesUrl}/img-1"`);
    expect(html).toContain("a red bicycle");
    expect(html).not.toContain("Generating image");
  });

  it("offers Zoom, and a Download that names the file", () => {
    const html = render(image({ state: "done", imageId: "img-1" }));

    expect(html).toContain("Zoom");
    expect(html).toContain(`href="${imagesUrl}/img-1?download=1"`);
  });
});

describe("the lightbox of a generated image", () => {
  it("shows the image large, with its prompt and a Download", () => {
    const html = renderToStaticMarkup(
      createElement(GeneratedImageViewer, {
        image: image({ state: "done", imageId: "img-1" }),
        imagesUrl,
      }),
    );

    expect(html).toContain(`src="${imagesUrl}/img-1"`);
    expect(html).toContain("a red bicycle");
    expect(html).toContain(`href="${imagesUrl}/img-1?download=1"`);
  });
});

import { describe, expect, it } from "vitest";

import { findModel } from "../../../../core/shared/chat/models";
import {
  acceptAttribute,
  acceptedKinds,
  attachmentKind,
  normalizedMediaType,
} from "../../../../core/shared/attachments/kinds";

describe("attachmentKind", () => {
  it("reads JPEG, PNG, GIF and WebP as images", () => {
    for (const type of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
      expect(attachmentKind(type, "x")).toBe("image");
    }
  });

  it("reads PDFs as pdf", () => {
    expect(attachmentKind("application/pdf", "doc.pdf")).toBe("pdf");
  });

  it("reads text types and text-like file names as text", () => {
    expect(attachmentKind("text/plain", "notes.txt")).toBe("text");
    expect(attachmentKind("text/csv", "data.csv")).toBe("text");
    expect(attachmentKind("application/json", "a.json")).toBe("text");
    // Browsers give many code files no type, or a guess.
    expect(attachmentKind("", "main.rs")).toBe("text");
    expect(attachmentKind("video/mp2t", "index.ts")).toBe("text");
    expect(attachmentKind("", "README.md")).toBe("text");
  });

  it("refuses other types", () => {
    expect(attachmentKind("image/svg+xml", "a.svg")).toBeUndefined();
    expect(attachmentKind("image/bmp", "a.bmp")).toBeUndefined();
    expect(
      attachmentKind(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "a.docx",
      ),
    ).toBeUndefined();
    expect(attachmentKind("", "binary")).toBeUndefined();
  });
});

describe("normalizedMediaType", () => {
  it("stores text-like files as text/plain unless they have a text type", () => {
    expect(normalizedMediaType("", "main.rs")).toBe("text/plain");
    expect(normalizedMediaType("video/mp2t", "index.ts")).toBe("text/plain");
    expect(normalizedMediaType("text/csv", "data.csv")).toBe("text/csv");
    expect(normalizedMediaType("image/png", "a.png")).toBe("image/png");
  });
});

describe("acceptedKinds", () => {
  it("takes text from every Model, and images and PDFs by its capabilities", () => {
    expect(acceptedKinds(findModel("anthropic:claude-sonnet-5-5"))).toEqual([
      "text",
      "image",
      "pdf",
    ]);
    expect(acceptedKinds(findModel("openai:gpt-5.6"))).toEqual(["text", "image"]);
    expect(acceptedKinds({ images: false, pdfs: false })).toEqual(["text"]);
  });

  it("takes nothing without a Model", () => {
    expect(acceptedKinds(undefined)).toEqual([]);
  });
});

describe("acceptAttribute", () => {
  it("lists the media types and extensions for a file input", () => {
    const accept = acceptAttribute(["image", "pdf"]);
    expect(accept).toContain("image/png");
    expect(accept).toContain("application/pdf");
    expect(accept).not.toContain("text/");
    expect(acceptAttribute(["text"])).toContain(".md");
    expect(acceptAttribute([])).toBe("");
  });
});

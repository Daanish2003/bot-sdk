import { describe, expect, it } from "vitest";

import { artifactFileName, extensionOf } from "../../../../core/shared/chat/artifact";

describe("an Artifact's download file name", () => {
  it.each([
    [{ title: "Landing page", kind: "html" as const, language: null }, "Landing page.html"],
    [{ title: "Notes", kind: "markdown" as const, language: null }, "Notes.md"],
    [{ title: "Logo", kind: "svg" as const, language: null }, "Logo.svg"],
    [{ title: "Flow", kind: "mermaid" as const, language: null }, "Flow.mmd"],
    [{ title: "Sorter", kind: "code" as const, language: "python" }, "Sorter.py"],
    [{ title: "Sorter", kind: "code" as const, language: "TypeScript" }, "Sorter.ts"],
    [{ title: "Dump", kind: "code" as const, language: "klingon" }, "Dump.txt"],
    [{ title: "Dump", kind: "code" as const, language: null }, "Dump.txt"],
  ])("is the title and the extension of %j", (version, fileName) => {
    expect(artifactFileName(version)).toBe(fileName);
  });

  it("drops the characters a file name can't hold, and falls back when nothing is left", () => {
    expect(artifactFileName({ title: 'a/b:c*"d"', kind: "html", language: null })).toBe(
      "a b c d.html",
    );
    expect(artifactFileName({ title: "  ", kind: "svg", language: null })).toBe("Artifact.svg");
  });

  it("uses the kind's extension for a code Artifact without a known language", () => {
    expect(extensionOf("code", null)).toBe("txt");
  });
});

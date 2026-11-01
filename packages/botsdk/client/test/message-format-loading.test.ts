import { readFileSync } from "node:fs";

import { expect, it, vi } from "vitest";

// Loading `marked` from anywhere fails the import, so only an entry that needs it can load it.
vi.mock("marked", () => {
  throw new Error("marked was loaded");
});

const { exports: entries } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { exports: Record<string, string> };

it("loads `marked` only through the message-format entry", async () => {
  const others = Object.keys(entries).filter(
    (entry) => entry !== "./package.json" && entry !== "./message-format",
  );
  expect(others).toContain(".");
  for (const entry of others) {
    await expect(import(/* @vite-ignore */ `@botsdk/client${entry.slice(1)}`)).resolves.toBeTypeOf(
      "object",
    );
  }
  await expect(import("@botsdk/client/message-format")).rejects.toThrow();
});

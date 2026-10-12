import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConsoleSender } from "../src/console";
import { renderTemplate } from "../src/templates";

const LINK = "https://chat.example.com/reset?token=xyz789";
const FROM = "Acme Chat <no-reply@example.com>";

describe("console sender", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "email-console-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("logs recipient, subject and link, and writes the HTML to a file", async () => {
    const logger = { info: vi.fn() };
    const sender = createConsoleSender({ from: FROM, outDir, logger });
    const message = await renderTemplate("reset-password", "person@example.com", {
      appName: "Acme Chat",
      url: LINK,
    });

    await sender.send(message);

    const logged = logger.info.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain("person@example.com");
    expect(logged).toContain(message.subject);
    expect(logged).toContain(LINK);

    const files = await readdir(outDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.html$/);
    const html = await readFile(join(outDir, files[0]!), "utf8");
    expect(html).toContain("<html");
    expect(html).toContain(LINK);
  });
});

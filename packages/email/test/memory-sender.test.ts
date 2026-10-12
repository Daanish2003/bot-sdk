import { describe, expect, it } from "vitest";

import { createMemorySender } from "../src/memory";
import { renderTemplate } from "../src/templates";

describe("in-memory sender", () => {
  it("records every message and returns the link of the last one sent to an address", async () => {
    const sender = createMemorySender();
    const first = await renderTemplate("verify-email", "a@example.com", {
      appName: "Acme Chat",
      url: "https://chat.example.com/verify?token=first",
    });
    const second = await renderTemplate("verify-email", "a@example.com", {
      appName: "Acme Chat",
      url: "https://chat.example.com/verify?token=second",
    });
    const other = await renderTemplate("reset-password", "b@example.com", {
      appName: "Acme Chat",
      url: "https://chat.example.com/reset?token=other",
    });

    await sender.send(first);
    await sender.send(other);
    await sender.send(second);

    expect(sender.messages).toHaveLength(3);
    expect(sender.lastLinkTo("a@example.com")).toBe("https://chat.example.com/verify?token=second");
    expect(sender.lastLinkTo("b@example.com")).toBe("https://chat.example.com/reset?token=other");
    expect(sender.lastLinkTo("nobody@example.com")).toBeUndefined();
  });
});

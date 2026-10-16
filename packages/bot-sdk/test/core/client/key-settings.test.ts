import { describe, expect, it } from "vitest";

import { providerRows } from "../../../core/client/key-settings";

describe("providerRows", () => {
  it("lists all 14 Providers, every one available", () => {
    const rows = providerRows([]);

    expect(rows).toHaveLength(14);
    expect(rows.filter((row) => row.status === "coming_soon")).toEqual([]);
    expect(rows.find((row) => row.id === "gemini")).toMatchObject({
      label: "Google Gemini",
      status: "missing",
      service: "gemini",
    });
  });

  it("marks Providers without credentials as missing", () => {
    const [anthropic] = providerRows([]);

    expect(anthropic).toMatchObject({ id: "anthropic", status: "missing", hint: null });
  });

  it("shows the hint and verified state of saved credentials", () => {
    const rows = providerRows([
      { service: "anthropic", hint: "…1234", verified: true },
      { service: "openai", hint: "…abcd", verified: false },
    ]);

    expect(rows[0]).toMatchObject({ id: "anthropic", status: "verified", hint: "…1234" });
    expect(rows[1]).toMatchObject({ id: "openai", status: "unverified", hint: "…abcd" });
  });
});

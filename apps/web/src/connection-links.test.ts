import { describe, expect, it } from "vitest";

import { unlinkConnection } from "./connection-links";

describe("disconnecting a Connection", () => {
  it("unlinks only the Connection's own rows, not the GitHub sign-in's", async () => {
    const unlinked: string[] = [];

    await unlinkConnection(
      [
        { id: "a1", providerId: "github" },
        { id: "a2", providerId: "github-connection" },
        { id: "a3", providerId: "google" },
      ],
      "github",
      async (id) => {
        unlinked.push(id);
      },
    );

    expect(unlinked).toEqual(["a2"]);
  });

  it("unlinks Gmail without touching Google Calendar", async () => {
    const unlinked: string[] = [];

    await unlinkConnection(
      [
        { id: "a1", providerId: "google-calendar" },
        { id: "a2", providerId: "gmail" },
      ],
      "gmail",
      async (id) => {
        unlinked.push(id);
      },
    );

    expect(unlinked).toEqual(["a2"]);
  });

  it("unlinks Notion and no other account", async () => {
    const unlinked: string[] = [];

    await unlinkConnection(
      [
        { id: "a1", providerId: "github" },
        { id: "a2", providerId: "notion" },
      ],
      "notion",
      async (id) => {
        unlinked.push(id);
      },
    );

    expect(unlinked).toEqual(["a2"]);
  });

  it("does nothing for a key the Host doesn't declare", async () => {
    await unlinkConnection([{ id: "a1", providerId: "github-connection" }], "outlook", async () => {
      throw new Error("should not unlink");
    });
  });
});

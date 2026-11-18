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

  it("does nothing for a key the Host doesn't declare", async () => {
    await unlinkConnection([{ id: "a1", providerId: "github-connection" }], "gmail", async () => {
      throw new Error("should not unlink");
    });
  });
});

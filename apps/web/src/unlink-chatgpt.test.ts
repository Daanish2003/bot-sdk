import { describe, expect, it } from "vitest";

import { unlinkChatgpt } from "./unlink-chatgpt";

describe("disconnecting ChatGPT", () => {
  it("unlinks every chatgpt row and no other account", async () => {
    const unlinked: string[] = [];

    await unlinkChatgpt(
      [
        { id: "a1", providerId: "github" },
        { id: "a2", providerId: "chatgpt" },
        { id: "a3", providerId: "chatgpt" },
      ],
      async (id) => {
        unlinked.push(id);
      },
    );

    expect(unlinked.sort()).toEqual(["a2", "a3"]);
  });

  it("does nothing when nothing is linked", async () => {
    await unlinkChatgpt([{ id: "a1", providerId: "github" }], async () => {
      throw new Error("should not unlink");
    });
  });
});

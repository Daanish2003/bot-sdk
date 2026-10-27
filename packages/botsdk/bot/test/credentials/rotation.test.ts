import { describe, expect, it } from "vitest";

import { rotateInPasses } from "../../src/credentials/rotation";

describe("rotateInPasses", () => {
  it("scans again while a scan races a concurrent write, summing the re-encrypted rows", async () => {
    const scans = [
      { reencrypted: 5, raced: 1, unreadable: 2 },
      { reencrypted: 1, raced: 0, unreadable: 1 },
    ];
    let calls = 0;

    const result = await rotateInPasses(async () => scans[calls++]!);

    expect(calls).toBe(2);
    // The last scan saw every row, so its unreadable count is the one returned.
    expect(result).toEqual({ reencrypted: 6, unreadable: 1 });
  });

  it("gives up after three scans when every scan races", async () => {
    let calls = 0;

    const result = await rotateInPasses(async () => {
      calls += 1;
      return { reencrypted: 1, raced: 1, unreadable: 0 };
    });

    expect(calls).toBe(3);
    expect(result).toEqual({ reencrypted: 3, unreadable: 0 });
  });
});

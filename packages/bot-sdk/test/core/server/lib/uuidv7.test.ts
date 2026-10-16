import { describe, expect, it } from "vitest";

import { uuidv7 } from "../../../../core/server/lib/uuidv7";

describe("uuidv7", () => {
  it("is a version 7 RFC 9562 uuid", () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("starts with the millisecond timestamp", () => {
    expect(uuidv7(0x0190_1234_5678).slice(0, 13)).toBe("01901234-5678");
  });

  it("sorts by creation time", () => {
    expect(uuidv7(1_000) < uuidv7(2_000)).toBe(true);
  });
});

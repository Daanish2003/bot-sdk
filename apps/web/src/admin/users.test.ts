import { describe, expect, it } from "vitest";

import { type AdminUser, formatUsd, selectUsers, windowStart } from "./users";

function user(fields: Partial<AdminUser> & { email: string }): AdminUser {
  return {
    id: fields.email,
    name: "Someone",
    createdAt: "2026-10-01T00:00:00.000Z",
    signInMethods: ["Password"],
    role: "user",
    banned: false,
    spentMicros: 0,
    budgetMicros: null,
    ...fields,
  };
}

const users = [
  user({ email: "carol@example.com", spentMicros: 500_000, budgetMicros: 1_000_000 }),
  user({ email: "alice@example.com", spentMicros: 2_000_000, budgetMicros: 2_000_000 }),
  user({ email: "bob@example.com", spentMicros: 9_000_000, budgetMicros: null }),
];

describe("selectUsers", () => {
  it("sorts by email, or by this window's spend, highest first", () => {
    expect(selectUsers(users, { sort: "email", atQuota: false }).map((u) => u.email)).toEqual([
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
    ]);
    expect(selectUsers(users, { sort: "spend", atQuota: false }).map((u) => u.email)).toEqual([
      "bob@example.com",
      "alice@example.com",
      "carol@example.com",
    ]);
  });

  it("searches by email, ignoring case", () => {
    expect(
      selectUsers(users, { search: "  BOB@ex", sort: "email", atQuota: false }).map((u) => u.email),
    ).toEqual(["bob@example.com"]);
  });

  it("keeps only users whose spend has reached their Quota, and never an unlimited user", () => {
    expect(selectUsers(users, { sort: "email", atQuota: true }).map((u) => u.email)).toEqual([
      "alice@example.com",
    ]);
  });
});

describe("windowStart", () => {
  it("is the UTC day or calendar month the instant falls in", () => {
    const now = new Date("2026-10-10T18:30:00Z");
    expect(windowStart("day", now)).toEqual(new Date("2026-10-10T00:00:00Z"));
    expect(windowStart("month", now)).toEqual(new Date("2026-10-01T00:00:00Z"));
  });
});

describe("formatUsd", () => {
  it("shows micros as dollars with cents", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1_234_567)).toBe("$1.23");
    expect(formatUsd(2_000_000)).toBe("$2.00");
  });
});

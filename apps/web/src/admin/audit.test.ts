import { describe, expect, it } from "vitest";

import { quotaChangeEvent } from "./audit";

describe("quotaChangeEvent", () => {
  it("names the actor, the action, the target and the reason of a Quota change", () => {
    expect(
      quotaChangeEvent({
        actor: "admin-1",
        target: "user-2",
        mode: "amount",
        budgetUsd: 0,
        reason: "  Abuse review ",
      }),
    ).toEqual({
      action: "admin.user.quota",
      message: "User Quota changed by an Admin",
      actor: "admin-1",
      target: "user-2",
      reason: "Abuse review",
      mode: "amount",
      budgetUsd: 0,
    });
  });

  it("logs no reason as null, and an unlimited Quota with no budget", () => {
    expect(
      quotaChangeEvent({ actor: "admin-1", target: "user-2", mode: "unlimited", reason: " " }),
    ).toMatchObject({ reason: null, mode: "unlimited", budgetUsd: null });
  });
});

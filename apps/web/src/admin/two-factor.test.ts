import { createMemorySender } from "@ai-chat/email";
import { isNotFound } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { turnOffUserTwoFactor, twoFactorOffInput, type TwoFactorOffDeps } from "./two-factor";

const admin = { id: "admin-1", role: "admin" as const };
const input = { userId: "user-1", reason: "Lost phone and backup codes, confirmed by email" };

/** Fake deps that record each effect in order, so a test can see what ran and what didn't. */
function fakeDeps(options: { on?: boolean; sendFails?: boolean } = {}) {
  const events: string[] = [];
  const log: Array<Record<string, unknown>> = [];
  const sender = createMemorySender();
  if (options.sendFails) {
    sender.send = async () => {
      throw new Error("provider down");
    };
  }
  const deps: TwoFactorOffDeps = {
    disable: async (userId) => {
      events.push(`disable:${userId}`);
      return options.on === false ? null : { email: "lost@example.com" };
    },
    revokeSessions: async (userId) => {
      events.push(`revoke:${userId}`);
    },
    sender,
    appName: "Acme Chat",
    log: {
      info: (entry) => {
        events.push("audit");
        log.push(entry);
      },
      error: (entry) => log.push({ level: "error", ...entry }),
    },
  };
  return { deps, events, log, sender };
}

describe("twoFactorOffInput", () => {
  it("refuses a blank reason", () => {
    expect(twoFactorOffInput.safeParse({ userId: "u1", reason: "   " }).success).toBe(false);
  });

  it("refuses a missing reason", () => {
    expect(twoFactorOffInput.safeParse({ userId: "u1" }).success).toBe(false);
  });

  it("trims the reason it keeps", () => {
    const parsed = twoFactorOffInput.parse({ userId: "u1", reason: "  Lost phone, emailed  " });
    expect(parsed.reason).toBe("Lost phone, emailed");
  });

  it("caps the reason at 500 characters", () => {
    expect(twoFactorOffInput.safeParse({ userId: "u1", reason: "x".repeat(501) }).success).toBe(
      false,
    );
  });
});

describe("turnOffUserTwoFactor", () => {
  it("turns the user's two-factor off, revokes their sessions, writes one audit event and sends the notice", async () => {
    const { deps, events, log, sender } = fakeDeps();

    await turnOffUserTwoFactor(deps, admin, input);

    expect(events).toEqual(["disable:user-1", "revoke:user-1", "audit"]);
    expect(log).toEqual([
      expect.objectContaining({
        action: "admin.user.two-factor-off",
        message: expect.any(String),
        actor: "admin-1",
        target: "user-1",
        reason: input.reason,
      }),
    ]);
    expect(sender.messages).toEqual([
      expect.objectContaining({ to: "lost@example.com", template: "two-factor-disabled" }),
    ]);
  });

  it("refuses anyone who isn't an Admin with a 404, before any change", async () => {
    const { deps, events, sender } = fakeDeps();

    const error = await turnOffUserTwoFactor(deps, { id: "u2", role: "user" }, input).catch(
      (caught: unknown) => caught,
    );

    expect(isNotFound(error)).toBe(true);
    expect(events).toEqual([]);
    expect(sender.messages).toHaveLength(0);
  });

  it("refuses a user without two-factor sign-in on, before any change", async () => {
    const { deps, events, sender } = fakeDeps({ on: false });

    await expect(turnOffUserTwoFactor(deps, admin, input)).rejects.toThrow(
      "Two-factor sign-in isn't on for this user",
    );

    expect(events).toEqual(["disable:user-1"]);
    expect(sender.messages).toHaveLength(0);
  });

  it("keeps the change and logs a failed notice rather than failing the action", async () => {
    const { deps, events, log } = fakeDeps({ sendFails: true });

    await turnOffUserTwoFactor(deps, admin, input);

    expect(events).toEqual(["disable:user-1", "revoke:user-1", "audit"]);
    expect(log).toContainEqual(
      expect.objectContaining({
        level: "error",
        action: "email.send",
        message: expect.any(String),
      }),
    );
  });
});

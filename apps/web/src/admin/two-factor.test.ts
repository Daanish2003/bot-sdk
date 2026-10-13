import { createMemorySender } from "@ai-chat/email";
import { isNotFound } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { turnOffUserTwoFactor, twoFactorOffInput, type TwoFactorOffDeps } from "./two-factor";

const admin = { id: "admin-1", role: "admin" as const };
const input = { userId: "user-1", reason: "Lost phone and backup codes, confirmed by email" };

/** Fake deps that record each effect in order, so a test can see what ran and what didn't. */
function fakeDeps(options: { on?: boolean; sendFails?: boolean; revokeFails?: boolean } = {}) {
  const events: string[] = [];
  const log: Array<Record<string, unknown>> = [];
  const sender = createMemorySender();
  if (options.sendFails) {
    sender.send = async () => {
      throw new Error("provider down");
    };
  }
  // The user's two-factor state, as the DB holds it: `disable` really turns it off.
  const state = { on: options.on !== false, revokeFails: options.revokeFails === true };
  const deps: TwoFactorOffDeps = {
    disable: async (userId) => {
      events.push(`disable:${userId}`);
      if (!state.on) return null;
      state.on = false;
      return { email: "lost@example.com" };
    },
    revokeSessions: async (userId) => {
      events.push(`revoke:${userId}`);
      if (state.revokeFails) throw new Error("session store down");
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
  return { deps, events, log, sender, state };
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
  it("revokes their sessions, turns the user's two-factor off, writes one audit event and sends the notice", async () => {
    const { deps, events, log, sender, state } = fakeDeps();

    await turnOffUserTwoFactor(deps, admin, input);

    expect(events).toEqual(["revoke:user-1", "disable:user-1", "audit"]);
    expect(state.on).toBe(false);
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

  it("refuses a user without two-factor sign-in on, with no audit event or notice", async () => {
    const { deps, events, log, sender } = fakeDeps({ on: false });

    await expect(turnOffUserTwoFactor(deps, admin, input)).rejects.toThrow(
      "Two-factor sign-in isn't on for this user",
    );

    expect(events).toEqual(["revoke:user-1", "disable:user-1"]);
    expect(log).toHaveLength(0);
    expect(sender.messages).toHaveLength(0);
  });

  it("when the session revoke throws, leaves two-factor on with no audit event or notice, so a retry succeeds", async () => {
    const { deps, events, log, sender, state } = fakeDeps({ revokeFails: true });

    await expect(turnOffUserTwoFactor(deps, admin, input)).rejects.toThrow("session store down");

    expect(events).toEqual(["revoke:user-1"]);
    expect(state.on).toBe(true);
    expect(log).toHaveLength(0);
    expect(sender.messages).toHaveLength(0);

    state.revokeFails = false;
    await turnOffUserTwoFactor(deps, admin, input);

    expect(state.on).toBe(false);
    expect(events).toEqual(["revoke:user-1", "revoke:user-1", "disable:user-1", "audit"]);
    expect(log).toHaveLength(1);
    expect(sender.messages).toHaveLength(1);
  });

  it("keeps the change and logs a failed notice rather than failing the action", async () => {
    const { deps, events, log } = fakeDeps({ sendFails: true });

    await turnOffUserTwoFactor(deps, admin, input);

    expect(events).toEqual(["revoke:user-1", "disable:user-1", "audit"]);
    expect(log).toContainEqual(
      expect.objectContaining({
        level: "error",
        action: "email.send",
        message: expect.any(String),
      }),
    );
  });
});

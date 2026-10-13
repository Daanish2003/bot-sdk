import { type EmailSender, renderTemplate } from "@ai-chat/email";
import { notFound } from "@tanstack/react-router";
import { z } from "zod";

/** What an Admin sends to turn a user's two-factor sign-in off (spec #277). The reason is required. */
export const twoFactorOffInput = z.object({
  userId: z.string().min(1),
  reason: z.string().trim().min(1, "Give a reason").max(500),
});

export type TwoFactorOffInput = z.infer<typeof twoFactorOffInput>;

/** What the action reaches outside itself, injected so the rules can be tested without a server. */
export type TwoFactorOffDeps = {
  /** Turns the user's two-factor off by a direct write; `null` when it wasn't on (nothing changed). */
  disable: (userId: string) => Promise<{ email: string } | null>;
  /** Ends every session the user has, through Better Auth. */
  revokeSessions: (userId: string) => Promise<void>;
  sender: EmailSender;
  appName: string;
  log: {
    info(entry: Record<string, unknown>): void;
    error(entry: Record<string, unknown>): void;
  };
};

/**
 * Turns off a user's lost two-factor sign-in (spec #277): the direct write, then every session ends,
 * then one evlog event (actor, action, target, reason), then the "2FA turned off" notice. Admin only,
 * and a user who isn't on is refused. A notice that fails to send is logged; the change stands.
 */
export async function turnOffUserTwoFactor(
  deps: TwoFactorOffDeps,
  actor: { id: string | undefined; role: string | null | undefined },
  input: TwoFactorOffInput,
): Promise<void> {
  if (actor.role !== "admin") throw notFound();

  const target = await deps.disable(input.userId);
  if (!target) throw new Error("Two-factor sign-in isn't on for this user");

  await deps.revokeSessions(input.userId);
  deps.log.info({
    action: "admin.user.two-factor-off",
    message: "Two-factor sign-in turned off by an Admin",
    actor: actor.id,
    target: input.userId,
    reason: input.reason,
  });

  try {
    await deps.sender.send(
      await renderTemplate("two-factor-disabled", target.email, { appName: deps.appName }),
    );
  } catch (error) {
    deps.log.error({
      action: "email.send",
      message: "two-factor disabled email failed to send",
      error,
    });
  }
}

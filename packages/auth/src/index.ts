import type { Database } from "@ai-chat/db";
import * as schema from "@ai-chat/db/schema/auth";
import { type EmailMessage, type EmailSender, renderTemplate } from "@ai-chat/email";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { betterAuth } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { admin, twoFactor } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { tanstackStartCookies } from "better-auth/tanstack-start";

// The Admin role holds only what the Admin view needs (spec #277). Impersonation, role changes
// (`admin:grant` is the only way), password and email changes and user deletion are left out, so the
// plugin's endpoints for them refuse every role, Admins included. `user` gets no admin permissions.
const accessControl = createAccessControl(defaultStatements);
const adminRole = accessControl.newRole({
  user: ["list", "get", "ban"],
  session: ["list", "revoke"],
});
const userRole = accessControl.newRole({ user: [], session: [] });

export type AuthConfig = {
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  APP_NAME: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
};

// Social sign-in. Better Auth links to an existing account only when the provider reports the email
// as verified (its default); neither provider is in `trustedProviders`, so an unverified provider
// email never links. A user created here is verified, whatever the provider reports.
const SOCIAL_CREATE_PATHS = ["/callback/:id", "/sign-in/social"];

// Where a failed background send is reported. evlog's `log` fits this shape.
export type AuthLogger = {
  error(entry: { action: string; message: string; error: unknown }): void;
};

// The step a Better Auth verification token was minted for. The token is signed by Better Auth
// a moment before it reaches the callback, so its payload is read without checking the signature.
function verificationPurpose(token: string): string | undefined {
  const [, body = ""] = token.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as {
    requestType?: string;
  };
  return payload.requestType;
}

// What the Host does when a user is deleted, injected so this package never depends on the Chat SDK
// (ADR 0005). It runs before the user's rows go: if it throws, the account delete is aborted and
// the user can ask again, so it must be idempotent.
export type AuthHooks = {
  deleteChatData(userId: string): Promise<void>;
};

// Set by the caller, never defaulted: Better Auth enables rate limits in production only.
export type AuthOptions = {
  rateLimit: boolean;
  // Redis, when the Host has one: the rate-limit counters are shared across processes. Unset,
  // limits are counted in memory per process. Only the counters go there, never sessions: Better
  // Auth's secondary storage would list and revoke sessions from Redis alone.
  rateLimitCounter?: RateLimitCounter;
};

/** A fixed-window counter: adds one at `key` and returns the count, opening the window at 1. */
export type RateLimitCounter = {
  increment(key: string, ttlSeconds: number): Promise<number>;
};

export function createAuth(
  env: AuthConfig,
  database: Database,
  sender: EmailSender,
  logger: AuthLogger,
  hooks: AuthHooks,
  options: AuthOptions,
) {
  const counter = options.rateLimitCounter;
  // Sends run without being awaited, so a slow or failing provider never holds the request up
  // (a timing signal, per Better Auth's guidance). A failure is logged, never thrown.
  function sendInBackground(message: Promise<EmailMessage>, what: string) {
    void message
      .then((rendered) => sender.send(rendered))
      .catch((error: unknown) =>
        logger.error({
          action: "email.send",
          message: `${what} email failed to send`,
          error,
        }),
      );
  }

  return betterAuth({
    database: drizzleAdapter(database, {
      provider: "pg",
      schema,
    }),
    trustedOrigins: [env.BETTER_AUTH_URL],
    // The TOTP issuer an authenticator app shows (spec #277).
    appName: env.APP_NAME,
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // Better Auth adds its own default scopes unless told not to, which would repeat these.
        disableDefaultScope: true,
        scope: ["openid", "email", "profile"],
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            if (!ctx || !SOCIAL_CREATE_PATHS.includes(ctx.path)) return;
            return { data: { ...user, emailVerified: true } };
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      // The user object a sign-up answers with, whether or not the email is new (the answer must not
      // reveal which). It carries the admin plugin's fields the same as a stored user.
      customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
        ...coreFields,
        role: "user",
        banned: false,
        banReason: null,
        banExpires: null,
        ...additionalFields,
        id,
      }),
      sendResetPassword: async ({ user, url }) => {
        sendInBackground(
          renderTemplate("reset-password", user.email, { appName: env.APP_NAME, url }),
          "password reset",
        );
      },
      // Runs once the new password is saved, before the other sessions are revoked.
      onPasswordReset: async ({ user }) => {
        sendInBackground(
          renderTemplate("password-changed", user.email, { appName: env.APP_NAME }),
          "password changed",
        );
      },
    },
    user: {
      changeEmail: {
        enabled: true,
        // The confirmation goes to the current address; only its link sends the verification
        // on to the new one.
        sendChangeEmailConfirmation: async ({ user, url }) => {
          sendInBackground(
            renderTemplate("change-email-confirm", user.email, { appName: env.APP_NAME, url }),
            "change email confirmation",
          );
        },
      },
      deleteUser: {
        enabled: true,
        // Everyone gets the link, OAuth-only users included: they have no password to prove who they are.
        sendDeleteAccountVerification: async ({ user, url }) => {
          sendInBackground(
            renderTemplate("delete-account-confirm", user.email, { appName: env.APP_NAME, url }),
            "account deletion confirmation",
          );
        },
        // Runs before the user's rows are deleted: a throw aborts the delete, so no chat rows are
        // left behind without their owner.
        beforeDelete: async (user) => {
          await hooks.deleteChatData(user.id);
        },
        afterDelete: async ({ email }) => {
          sendInBackground(
            renderTemplate("account-deleted", email, { appName: env.APP_NAME }),
            "account deleted",
          );
        },
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      // The same callback sends the sign-up link and, after the confirmation, the link to the new
      // address; the token tells them apart.
      sendVerificationEmail: async ({ user, url, token }) => {
        const newAddress = verificationPurpose(token) === "change-email-verification";
        sendInBackground(
          newAddress
            ? renderTemplate("verify-new-email", user.email, { appName: env.APP_NAME, url })
            : renderTemplate("verify-email", user.email, { appName: env.APP_NAME, url }),
          newAddress ? "new email verification" : "verification",
        );
      },
    },
    hooks: {
      // Changing a password while signed in (`/change-password`) doesn't run `onPasswordReset`,
      // so its notice is sent from here. Only a successful change has a `user` in its response.
      // The two-factor steps below send their notices, and turning 2FA on signs out the other sessions.
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        if (isAPIError(returned)) return;
        if (ctx.path === "/change-password") {
          const user = (returned as { user?: { email: string } } | undefined)?.user;
          if (!user) return;
          sendInBackground(
            renderTemplate("password-changed", user.email, { appName: env.APP_NAME }),
            "password changed",
          );
          return;
        }
        // The first code confirms a new 2FA setup: a signed-in user's verify call, which rotates
        // the session. A sign-in verifies with the challenge cookie and has no session here.
        if (ctx.path === "/two-factor/verify-totp") {
          const session = ctx.context.session;
          const rotatedSession = ctx.context.newSession;
          if (!session || !rotatedSession) return;
          const others = (await ctx.context.internalAdapter.listSessions(session.user.id)).filter(
            (other) => other.token !== rotatedSession.session.token,
          );
          await Promise.all(
            others.map((other) => ctx.context.internalAdapter.deleteSession(other.token)),
          );
          sendInBackground(
            renderTemplate("two-factor-enabled", session.user.email, { appName: env.APP_NAME }),
            "two-factor enabled",
          );
          return;
        }
        if (ctx.path === "/two-factor/disable" && ctx.context.session) {
          sendInBackground(
            renderTemplate("two-factor-disabled", ctx.context.session.user.email, {
              appName: env.APP_NAME,
            }),
            "two-factor disabled",
          );
        }
      }),
    },
    rateLimit: {
      enabled: options.rateLimit,
      storage: "memory",
      // Better Auth's own keys (IP and path) and rules; only where the count lives changes.
      ...(counter && {
        customStorage: {
          async consume(key, rule) {
            const allowed = (await counter.increment(key, rule.window)) <= rule.max;
            return { allowed, retryAfter: allowed ? null : rule.window };
          },
        },
      }),
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    plugins: [
      admin({ ac: accessControl, roles: { admin: adminRole, user: userRole } }),
      // TOTP with backup codes (spec #277): optional, for password accounts only, no email OTP.
      twoFactor({ allowPasswordless: false }),
      tanstackStartCookies(),
    ],
  });
}

export type Session = ReturnType<typeof createAuth>["$Infer"]["Session"];

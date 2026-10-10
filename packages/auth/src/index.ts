import type { Database } from "@ai-chat/db";
import * as schema from "@ai-chat/db/schema/auth";
import { type EmailMessage, type EmailSender, renderTemplate } from "@ai-chat/email";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { betterAuth } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { tanstackStartCookies } from "better-auth/tanstack-start";

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

export function createAuth(
  env: AuthConfig,
  database: Database,
  sender: EmailSender,
  logger: AuthLogger,
  hooks: AuthHooks,
) {
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
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        if (ctx.path !== "/change-password" || isAPIError(returned)) return;
        const user = (returned as { user?: { email: string } } | undefined)?.user;
        if (!user) return;
        sendInBackground(
          renderTemplate("password-changed", user.email, { appName: env.APP_NAME }),
          "password changed",
        );
      }),
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    plugins: [tanstackStartCookies()],
  });
}

export type Session = ReturnType<typeof createAuth>["$Infer"]["Session"];

import type { Database } from "@ai-chat/db";
import * as schema from "@ai-chat/db/schema/auth";
import { type EmailMessage, type EmailSender, renderTemplate } from "@ai-chat/email";
import { passkey } from "@better-auth/passkey";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { admin, genericOAuth, twoFactor } from "better-auth/plugins";
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
  // ChatGPT is registered only when both are set: the public PKCE client id, and the fixed
  // `ext_agent_host_id` it was registered under (ADR 0023).
  CHATGPT_CLIENT_ID?: string;
  CHATGPT_HOST_ID?: string;
};

// ChatGPT sign-in endpoints, scopes and audience (spec #638).
const CHATGPT_PROVIDER = "chatgpt";
const CHATGPT_RESOURCE = "https://api.openai.com/v1";

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

// What the Host does when a user is deleted, injected so this package never depends on the Bot SDK
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
  // Headers Better Auth reads the client IP from, in order (TRUSTED_IP_HEADERS). Unset, Better Auth
  // reads x-forwarded-for. Only list headers a proxy you run sets: a client can send any header.
  trustedIpHeaders?: string[];
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

  const chatgpt =
    env.CHATGPT_CLIENT_ID && env.CHATGPT_HOST_ID
      ? genericOAuth({
          config: [
            {
              providerId: CHATGPT_PROVIDER,
              clientId: env.CHATGPT_CLIENT_ID,
              authorizationUrl: "https://auth.openai.com/api/accounts/authorize",
              tokenUrl: "https://auth.openai.com/api/accounts/oauth/token",
              scopes: [
                "openid",
                "profile",
                "email",
                "offline_access",
                "resource.invoke",
                "chatgpt.tokens.use.direct",
              ],
              pkce: true,
              // The client is registered with the 127.0.0.1 form of the app's origin; apps/web's
              // `/auth/callback` bounces it back to `/api/auth/callback/chatgpt` on BETTER_AUTH_URL.
              redirectURI: `${env.BETTER_AUTH_URL.replace("//localhost", "//127.0.0.1")}/auth/callback`,
              // Link-only (the `hooks.before` below also refuses sign-in): no user is ever created.
              disableSignUp: true,
              authorizationUrlParams: {
                resource: CHATGPT_RESOURCE,
                ext_agent_host_id: env.CHATGPT_HOST_ID,
              },
              tokenUrlParams: { resource: CHATGPT_RESOURCE },
              refreshTokenParams: { resource: CHATGPT_RESOURCE },
            },
          ],
        })
      : undefined;

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
    account: {
      // Tokens at rest are encrypted, GitHub and Google included; plaintext rows written before
      // this was on are still read as they are, and are encrypted when next refreshed.
      encryptOAuthTokens: true,
      accountLinking: {
        // A user links ChatGPT on purpose, under another email than their own. Better Auth has
        // no per-provider switch, so this applies to GitHub and Google links too: a signed-in
        // user may link either under a different email. Linking still needs the provider to
        // report the email as verified.
        allowDifferentEmails: true,
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
      // ChatGPT is link-only. `disableSignUp` alone would still sign in an existing user whose
      // email matches, so every social sign-in for it is refused, the ID-token form included.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-in/social" && ctx.body?.provider === CHATGPT_PROVIDER) {
          throw new APIError("BAD_REQUEST", {
            message: "ChatGPT can only be linked, not signed in with",
          });
        }
      }),
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
        // A passkey added from a signed-in session (spec #277): the notice goes to that session's owner.
        if (ctx.path === "/passkey/verify-registration" && ctx.context.session) {
          sendInBackground(
            renderTemplate("passkey-added", ctx.context.session.user.email, {
              appName: env.APP_NAME,
            }),
            "passkey added",
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
      // Passkey sign-in gets the same limit as `/sign-in*` (Better Auth's default for that path).
      customRules: {
        "/passkey/generate-authenticate-options": { window: 10, max: 3 },
        "/passkey/verify-authentication": { window: 10, max: 3 },
      },
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
    // Better Auth's default IP headers apply unless the Host names its own (advanced.ipAddress).
    ...(options.trustedIpHeaders && {
      advanced: { ipAddress: { ipAddressHeaders: options.trustedIpHeaders } },
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    plugins: [
      admin({ ac: accessControl, roles: { admin: adminRole, user: userRole } }),
      // TOTP with backup codes (spec #277): optional, for password accounts only, no email OTP.
      twoFactor({ allowPasswordless: false }),
      // Passkeys for password-free sign-in (spec #277). The relying party id defaults to the
      // hostname of `baseURL` (BETTER_AUTH_URL).
      passkey({ rpName: env.APP_NAME }),
      ...(chatgpt ? [chatgpt] : []),
      tanstackStartCookies(),
    ],
  });
}

export type Session = ReturnType<typeof createAuth>["$Infer"]["Session"];

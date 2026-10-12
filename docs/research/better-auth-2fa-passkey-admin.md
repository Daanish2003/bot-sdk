# Better Auth twoFactor, passkey and admin plugins on 1.7

Research for [#171](https://github.com/Daanish2003/ai-chat/issues/171) (child of map [#166](https://github.com/Daanish2003/ai-chat/issues/166)). Researched 2026-10-12 against the installed **better-auth 1.7.7** (`pnpm-lock.yaml`; `packages/auth/package.json` pins `@better-auth/core` and `@better-auth/drizzle-adapter` at 1.7.7). The matching docs line is v1.7, which is "latest" in [better-auth.com/llms.txt](https://better-auth.com/llms.txt). Facts were checked in the installed source under `node_modules/.pnpm/better-auth@1.7.7_*/node_modules/better-auth/dist/plugins/{two-factor,admin}/`. The passkey package is not installed; its 1.7.7 tarball from npm was read instead (`@better-auth/passkey@1.7.7`, `dist/index.mjs`).

This note reports facts and implications. The decisions belong to [#172](https://github.com/Daanish2003/ai-chat/issues/172) and [#173](https://github.com/Daanish2003/ai-chat/issues/173).

Sources:

- [2FA] https://better-auth.com/docs/plugins/2fa
- [PK] https://better-auth.com/docs/plugins/passkey
- [AD] https://better-auth.com/docs/plugins/admin
- [TS] https://better-auth.com/docs/integrations/tanstack
- [SRC] installed source, paths given inline

## Summary

|                      | twoFactor                                                                                  | passkey                                                                                                            | admin                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Package              | `better-auth/plugins` (installed)                                                          | **`@better-auth/passkey`, a new dependency** (pulls in `@simplewebauthn/server` and `@simplewebauthn/browser` ^13) | `better-auth/plugins` (installed)                                          |
| Schema               | `user.twoFactorEnabled`; new `twoFactor` table                                             | new `passkey` table                                                                                                | `user.role`, `banned`, `banReason`, `banExpires`; `session.impersonatedBy` |
| Gates OAuth sign-in? | **No.** Only `/sign-in/email`, `/sign-in/username`, `/sign-in/phone-number` are challenged | n/a (its own sign-in)                                                                                              | Yes: a banned user can't get a session by any method                       |
| Rate limit           | Plugin rule: `/two-factor/*` 3 per 10 s, plus per-account lockout                          | No plugin rule: falls under the global 100 per 10 s                                                                | No plugin rule                                                             |
| TanStack Start       | None beyond keeping `tanstackStartCookies()` **last** in `plugins`                         | Same                                                                                                               | Same                                                                       |

## How migrations work here (all three plugins)

This repo doesn't run `auth migrate`. Better Auth's tables are the Drizzle schema in `packages/db/src/schema/auth.ts`; `drizzle-kit generate` (`packages/db` script `db:generate`) writes SQL into `packages/db/src/migrations/`, and `apps/web/scripts/migrate.ts` applies that folder with Drizzle's migrator before `migrateChatSchema()` (the Chat SDK's `migrate()`). So adding a plugin means:

1. Add the plugin to `createAuth`, then run `pnpm dlx auth@latest generate` to see the Drizzle columns and tables it wants (or write them from the field lists below).
2. Add them to `packages/db/src/schema/auth.ts`, including the new tables in `authRelations` (the adapter is `@better-auth/drizzle-adapter/relations-v2` and receives `schema` from that file), then `pnpm --filter @ai-chat/db db:generate`.
3. `pnpm db:migrate` applies it, still before `chat.migrate()`.

Every one of these is a schema change, which AGENTS.md section 6 reserves for a human.

## twoFactor

**Server config** [2FA]: `twoFactor({ issuer?, otpOptions?: { sendOTP, period, digits, storeOTP }, totpOptions?: { digits, period, disable }, backupCodeOptions?: { amount, length, storeBackupCodes }, skipVerificationOnEnable?, allowPasswordless?, trustDeviceMaxAge?, twoFactorCookieMaxAge?, accountLockout?: { enabled, maxFailedAttempts, durationSeconds } })` (option list from `two-factor/types.d.mts`). The TOTP issuer defaults to `appName`. **`createAuth` doesn't set `appName` today** (it has `env.APP_NAME` but only uses it for email), so authenticator apps would show "Better Auth" unless `appName` or `issuer` is set.

**Client config**: `twoFactorClient({ onTwoFactorRedirect({ twoFactorMethods }) })` or `twoFactorPage` (full page reload) from `better-auth/client/plugins`. `apps/web/src/lib/auth-client.ts` is currently `createAuthClient({})`.

**Schema** (`two-factor/schema.mjs`):

- `user.twoFactorEnabled` boolean, default false.
- `twoFactor` table: `id`, `secret` (string, indexed), `backupCodes` (string), `userId` (FK to user, indexed), `verified` (boolean, default true), `failedVerificationCount` (number, default 0), `lockedUntil` (date, nullable).

**Methods** (defaults from source):

- **TOTP**: 6 digits, 30 s period, one period of drift each way. `twoFactor.enable({ password, method: "totp" })` returns `totpURI` and `backupCodes`; 2FA only turns on after the first `verifyTotp` unless `skipVerificationOnEnable`. The secret is stored encrypted with the auth secret (`symmetricEncrypt`). The docs warn to render the QR code locally, since the URI is the shared secret.
- **OTP by email**: needs `otpOptions.sendOTP({ user, otp })`, which this repo would implement with the same `sendInBackground` + email template pattern. 6 digits, valid 3 minutes, stored `"plain"` by default (`"hashed"` and `"encrypted"` exist). `method: "otp"` turns 2FA on immediately, without proving the channel works. When `sendOTP` is configured, `"otp"` is offered to _every_ 2FA user at sign-in, alongside TOTP when they have it.
- **Backup codes**: 10 codes of 10 characters (`xxxxx-xxxxx`), stored encrypted by default, single use, regenerating replaces them all. `viewBackupCodes` is server-only.
- **Trusted devices**: `trustDevice: true` on any verify sets a signed `trust_device` cookie backed by a `verification` row; 30 days (`trustDeviceMaxAge`), rotated on each sign-in that uses it. Disabling 2FA clears it.

**Sign-in flow**: the plugin's after-hook on the credential sign-in paths deletes the session that was just created, sets a 10-minute signed `two_factor` cookie, and returns `{ twoFactorRedirect: true, twoFactorMethods }`. `ctx.context.newSession` is `null` during the challenge, so any of our own after-hooks on sign-in must null-check it (our current after-hook only handles `/change-password`, so it is unaffected).

**Can 2FA be enforced?** Not with an option: there is no "require 2FA" setting in `types.d.mts`. Enforcement would be our own code (for example, a route guard that sends users with `twoFactorEnabled: false` to enrolment). And even when enabled, 2FA **doesn't challenge OAuth, passkey, magic-link or email-OTP sign-ins** [2FA]. In this app that means a GitHub or Google sign-in skips 2FA entirely; covering it needs custom hooks on `/callback/:id` that the docs only sketch.

**OAuth-only users**: `enable`/`disable`/`getTotpUri`/`generateBackupCodes` require a password by default, so users who only signed in with GitHub or Google can't enable 2FA unless `allowPasswordless: true` (password is still required when a credential account exists) [2FA].

**Email verification**: no interaction of its own. With `requireEmailVerification: true` an unverified credential sign-in is rejected with 403 before a session exists, so the 2FA hook never runs for it.

**Sessions**: enabling or disabling 2FA replaces the current session with a new one (`two-factor/index.mjs`). Existing sessions on other devices stay signed in.

**Rate limits**: the plugin adds `/two-factor/*` at 3 per 10 s (`two-factor/index.mjs`), keyed like core rules by IP and path. Our `rateLimit.customStorage` (Redis counter) receives plugin rules too: the limiter picks the matching rule, core or plugin, and passes it to `consume` (`api/rate-limiter/index.mjs`). On top of that, **account lockout is on by default**: 10 failed verifications across TOTP, OTP and backup codes lock the account's 2FA for 15 minutes, returning 429 `ACCOUNT_TEMPORARILY_LOCKED` (`verify-two-factor.mjs`). The 3-per-10-s rule is off whenever `options.rateLimit` is false (dev and tests); the lockout is not, because it is counted in the `twoFactor` row rather than by the limiter.

## passkey

**Package**: `@better-auth/passkey` 1.7.7 (npm `latest`), not part of `better-auth`. Its dependencies are `@simplewebauthn/server` and `@simplewebauthn/browser` ^13.3, plus peers `better-auth`, `@better-auth/core`, `@better-auth/utils@0.4.2`, `better-call@1.4.0`, `@better-fetch/fetch@1.3.2` and `nanostores` (`pnpm view @better-auth/passkey@1.7.7`). **Adding it is a new-dependency decision (AGENTS.md section 6).** The WebAuthn library is SimpleWebAuthn [PK].

**Server config**: `passkey({ rpID?, rpName?, origin?, authenticatorSelection?, registration?: { requireSession, resolveUser, afterVerification, extensions }, authentication?: { extensions }, advanced?: { webAuthnChallengeCookie } })`. **Client**: `passkeyClient()` from `@better-auth/passkey/client`; `authClient.passkey.addPasskey`, `authClient.signIn.passkey({ autoFill })` (Conditional UI needs `autocomplete="username webauthn"` on an input) [PK].

**RP ID and origin with a custom domain** (from source, `getRpID` and the verify handlers):

- `rpID` defaults to the hostname of `baseURL` (our `BETTER_AUTH_URL`), or `"localhost"` if unset. It can be a registrable parent (`app.example.com` may use `example.com`) but not an eTLD. A passkey is bound to its RP ID, so **changing the domain later orphans existing passkeys**; picking the RP ID is a one-way choice.
- `origin` defaults to `null`, and the verify step then uses the request's `Origin` header as `expectedOrigin`. Setting `origin` explicitly to the public URL (no trailing slash) is the stricter choice; `http://localhost:PORT` is valid in dev.
- `rpName` defaults to `appName` (unset here, see twoFactor).
- Defaults: `attestationType: "none"`, `residentKey: "preferred"`, `userVerification: "preferred"`; challenges live 5 minutes in the `verification` table, referenced by the `better-auth-passkey` cookie.

**Schema** (`src/schema.ts` in the package): `passkey` table with `id`, `name` (nullable), `publicKey`, `userId` (FK, indexed), `credentialID` (indexed), `counter` (number), `deviceType`, `backedUp` (boolean), `transports` (nullable), `createdAt` (nullable), `aaguid` (nullable). No user column.

**Registration needs a fresh session by default**: `/passkey/generate-register-options` and `/passkey/verify-registration` use `freshSessionMiddleware` when `registration.requireSession` is true (the default), so the session must be younger than `session.freshAge` (default 1 day; not set in `createAuth`), else 403 `SESSION_NOT_FRESH`.

**Can a passkey be the only sign-in method?** Yes. With `registration.requireSession: false` plus `resolveUser` (and optionally `createSession: true` on `addPasskey`), a user can be created and signed in with only a passkey [PK]. The `user` table still requires `email` and `name`, so `resolveUser` must supply them and decide how the email is verified. Facts that follow from the other plugins: such a user has no credential account, so twoFactor needs `allowPasswordless`; and losing the device leaves only whatever email-based recovery we build (not verified: whether password reset creates a credential account for a user who never had one).

**OAuth, verification, sessions**: passkey sign-in (`/passkey/verify-authentication`) creates a normal session with `createSession` (so admin's ban check applies) and doesn't check `emailVerified` or 2FA. With the default `requireSession`, a user can only register a passkey after a session exists, which in this app already means a verified email or an OAuth sign-in.

**Rate limits**: the passkey endpoints are under `/passkey/*`, so the core `/sign-in*` rule (3 per 10 s) does **not** match them and the plugin declares no rule: they get the global 100 per 10 s unless `rateLimit.customRules` adds one. Replay is handled by the WebAuthn signature counter.

## admin

**Server config** [AD]: `admin({ defaultRole?, adminRoles?, adminUserIds?, ac?, roles?, impersonationSessionDuration?, defaultBanReason?, defaultBanExpiresIn?, bannedUserMessage? })`. **Client**: `adminClient({ ac?, roles? })` from `better-auth/client/plugins`.

**Schema** (`admin/schema.mjs`): `user.role` (string, nullable), `user.banned` (boolean, default false), `user.banReason` (nullable), `user.banExpires` (date, nullable); `session.impersonatedBy` (nullable). None accept client input.

**Roles**: `admin` and `user` by default; a user's roles are a comma-separated string. New users get `defaultRole` (`"user"`) through a `user.create.before` hook the plugin adds. That merges with our own `user.create.before` (the social `emailVerified: true` hook); both run. Permissions: `user: create, list, set-role, ban, impersonate, impersonate-admins, delete, set-password, set-email, get, update` and `session: list, revoke, delete`; custom roles come from `createAccessControl` (import from `better-auth/plugins/access`). The first admin is made with `pnpm dlx auth@latest create-admin --email … --role admin` or by listing IDs in `adminUserIds`.

**Listing users**: `listUsers({ searchValue, searchField: email|name, searchOperator, limit (default 100), offset, sortBy, sortDirection, filterField, filterValue, filterOperator })` returns `{ users, total, limit, offset }`.

**Ban** (`admin/routes.mjs`): `banUser({ userId, banReason?, banExpiresIn? (seconds) })` sets `banned`, `banReason` (fallback `defaultBanReason`, then `"No reason"`) and `banExpires` (null means forever), then **deletes all of the user's sessions** (`deleteUserSessions`). An admin can't ban themself. Because `createAuth` doesn't enable `session.cookieCache` and doesn't use secondary storage for sessions, a deleted session is rejected on the next request; with a cookie cache it would live until the cache expired.

**Ban enforcement** (`admin/admin.mjs`): a `session.create.before` hook throws 403 `BANNED_USER` for any banned user, so it covers email, OAuth, passkey and the post-verification auto sign-in alike. An OAuth sign-in by a banned user is redirected to the error URL with `?error=BANNED_USER&error_description=<message>` (`api/routes/callback.mjs`). An **expired ban is lifted lazily** at the next session creation (the hook clears the three fields); nothing runs at expiry itself.

**Impersonation**: `impersonateUser({ userId })` creates a session for the target with `impersonatedBy` set, lasting `impersonationSessionDuration` (default 1 hour), and keeps the admin's token in a signed `admin_session` cookie; `stopImpersonating` restores it. Impersonating an admin needs the `impersonate-admins` permission. Impersonation sessions are hidden from the target's own `/list-sessions`. An impersonating admin sees everything the user sees, chats included, which matters for the app's privacy promise.

**Email verification gotcha**: this repo sets `requireEmailVerification: true`, which makes sign-up return a synthetic user for existing emails. The synthetic user fills plugin fields from their defaults (`db/schema.mjs` `buildSyntheticUserOutput`), so `banned` becomes false but `role` becomes null where a real new user gets `"user"`: a detectable difference. The admin docs say to set `emailAndPassword.customSyntheticUser` to include `role: "user"`, `banned: false`, `banReason: null`, `banExpires: null` [AD]. (`twoFactorEnabled` has a default, so twoFactor needs nothing extra.)

**Rate limits**: no plugin rule; `/admin/*` gets the global 100 per 10 s. Calls made server-side with `auth.api` are not rate limited at all.

## TanStack Start

None of the three needs TanStack Start-specific setup beyond what exists. The one rule: `tanstackStartCookies()` must stay **last** in `plugins`. Better Auth warns at startup when a plugin with `hooks.after` comes after it (`integrations/cookie-plugin-guard.mjs`), and both twoFactor (sign-in hook that sets the `two_factor` and `trust_device` cookies) and admin (`/list-sessions` hook) have after-hooks [TS]. Server-side `auth.api` 2FA calls need the incoming request headers passed through so the 2FA cookies are read and set [2FA].

## Not verified

- Whether `pnpm dlx auth@latest generate` output for the drizzle adapter matches the field lists above exactly (names and nullability were read from the plugin schema objects, not from generated SQL).
- How password reset behaves for a passkey-only user with no credential account.
- Behaviour of `impersonateUser` against a banned target (its `createSession` call passes override flags whose effect on the ban hook wasn't traced).

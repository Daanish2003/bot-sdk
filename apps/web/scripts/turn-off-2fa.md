# Turning off a user's lost two-factor sign-in

Spec #277 lets an Admin turn off two-factor sign-in for a user who has lost their authenticator and
backup codes. The app does it from the Admin users table ("Turn off 2FA"). Before that, the request
must be confirmed outside the app, as below. Admins are granted with `pnpm --filter web admin:grant <email>`
(and revoked with `admin:revoke`); that is the only way to become an Admin.

## Steps

1. **The request comes from the account's email address.** If the request arrives from any other
   address, or not by email, refuse it and don't act on it.
2. **Confirm by email reply.** Reply to that address, asking the user to confirm that they lost the
   authenticator and backup codes, and that they want two-factor sign-in turned off. Wait for their
   reply that confirms it. Don't act on a request you haven't had confirmed.
3. **Only then, turn it off.** Sign in as an Admin, open `/admin`, find the user's row, click
   "Turn off 2FA", and enter a reason. Put the date of the confirming reply in the reason, for example
   `Lost authenticator and backup codes; confirmed by reply on 2026-10-13`.
4. **Check the result.** The user's sessions end, and they get the "Two-factor sign-in was turned
   off" email. If they don't get it, check the evlog output for `email.send` errors.
5. **Keep the confirming reply.** The email thread is the record that the request was confirmed.
   The audit event in evlog (`admin.user.two-factor-off`) holds the actor, target and reason.
6. **Tell the user** to sign in with their password, and to turn two-factor sign-in on again from
   the Account page once they have a new authenticator.

Users who can still reach a linked GitHub or Google account, or a passkey, don't need this runbook.

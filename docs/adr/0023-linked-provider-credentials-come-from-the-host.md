---
Status: accepted
---

# Linked Provider credentials come from the Host through a hook

A user can link a ChatGPT plan as Provider credentials for OpenAI (#636). They get it by signing in to ChatGPT, not by pasting a key. The Bot SDK has no auth (it knows users only by id), so the OAuth link belongs to the Host. In apps/web it is a Better Auth Generic OAuth provider (`chatgpt`), linked only and never a sign-in method. Its tokens live encrypted in Better Auth's `account` table, and Better Auth refreshes them.

The models plugin takes an optional Host hook, `linkedCredentials(userId, service)`, which returns Credentials or nothing. When the user has no stored credentials for a service, credential resolution asks the hook. apps/web answers with the refreshed access token as OpenAI's `apiKey`. A Host without the hook has no linked credentials.

- **Precedence:** stored credentials (an API key) win, and a linked plan is used only when there are none. Linked credentials are still Provider credentials. They obey the Host's `byok` switch, skip the Quota, and are never replaced by Host credentials, even when the plan is exhausted or the link is broken.
- **Models:** the list of Models a ChatGPT plan offers is a fact about OpenAI, so it lives in the SDK next to the OpenAI service. The hook returns only credentials.
- **UI:** `KeySettingsPage` takes an optional Host prop for linked credentials (linked state, connect, disconnect), and shows it on the OpenAI row.

## Considered Options

- **The SDK runs the OAuth flow and stores the tokens in `user_credentials`**: this keeps all Provider credentials in one table. But it puts an OAuth client, callback routes and token refresh into an SDK that has no auth, and the Host's auth library already does all three.
- **The Host copies the token into `user_credentials` on link**: this needs no hook. But the copy goes stale when the token is refreshed, so the Host would have to re-copy it on every refresh.

## Consequences

- Provider credentials now have two sources, the SDK's own store and the Host's hook. Credential resolution must consult both everywhere it runs (chat, titles, Memory, Bots, Routines, Check-ins).
- Enabling Better Auth's `encryptOAuthTokens` also encrypts GitHub and Google tokens. Rows written in plaintext before the flag was on may need re-linking.
- Allowing a different email on link is safe for `chatgpt` only because it is never a sign-in method.

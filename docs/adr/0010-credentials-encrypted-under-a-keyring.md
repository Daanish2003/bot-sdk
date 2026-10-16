---
Status: accepted
---

# Stored secrets are encrypted under a keyring and rotated with `chat.rotateKeys()`

ADR 0003 encrypted Provider credentials under one `KEY_ENCRYPTION_SECRET` and accepted that changing it locks every user out of their stored secrets. In production the same secret also protects Tool credentials and Connection tokens, and a leak or a departing operator must be survivable. So `createChat` takes `keyEncryptionSecrets: string[]`: the first entry encrypts, every entry decrypts. Each ciphertext is `v2.<kid>.<iv>.<tag>.<ciphertext>`, where `kid` is a short fingerprint (an HMAC) of the derived key, so the Host never names keys. Each kind of secret (Provider and Tool credentials, Connection tokens) gets its own key derived from the same secret through a different HKDF info string.

- **Rotating** is a runbook, not a schedule: on a suspected leak or when someone with access leaves. Add the new secret first and deploy, run `chat.rotateKeys()` once the new keyring is live everywhere, then remove the old secret and deploy again.
- `chat.rotateKeys()` is a one-off command, never a pre-deploy step: during pre-deploy the old version is still running with only the old key and still writing under it. It works in batches, can be re-run, and returns `{ reencrypted, unreadable }`.
- A row under a key no longer in the keyring reads as missing, as in ADR 0003: users re-enter credentials or reconnect. The `kid` tells a removed key from a corrupt row, so both `rotateKeys()` and decrypt failures log how many rows are affected.
- `apps/web` maps it from two env vars, `KEY_ENCRYPTION_SECRET` and an optional `KEY_ENCRYPTION_SECRET_PREVIOUS`, so it holds at most two keys at once.
- The `v1` format is dropped, not read: v1 data is dev-only and its tables are dropped with the new baseline.

## Considered Options

- **Lazy re-encryption on read**: never reaches dormant users, so an old key could never be removed safely.
- **Named keys** (`[{ id, secret }]`): one more thing for the Host to manage, for nothing a fingerprint doesn't already give.
- **Refusing to start while rows sit under an unknown key**: too harsh when the fix is the user re-entering a key.

## Consequences

- Replaces ADR 0003's "No key rotation in v1".
- Host credentials live in env and aren't covered; `BETTER_AUTH_SECRET` rotation is a separate `apps/web` question.

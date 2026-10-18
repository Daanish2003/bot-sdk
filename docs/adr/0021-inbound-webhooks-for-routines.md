---
Status: proposed
---

# Routines accept inbound webhooks at a secret URL, handled by the Bot SDK

A Routine runs "on a schedule or webhook" (lecture slide 14). So the Bot SDK takes its first public inbound HTTP request. It exports a webhook handler that a Host mounts at `/api/routines/webhook/<token>`, the same way it mounts the chat handler. The handler looks up the Routine by its token, deduplicates the call, and hands a Trigger to the Router. Then it answers `202 Accepted` without waiting for the Turn.

- **Authentication is the URL.** The token is 256 random bits and is stored only as a hash. Rotating it issues a new URL. Any sender can call a secret URL (Zapier, curl, GitHub), but only some senders can produce an HMAC signature.
- **Dedup.** When the sender sends an `Idempotency-Key` header, the Trigger's ID is `routine:<id>:<key>`, so a retried delivery is dropped. Without the header, each call is a new Trigger.
- **The body** is JSON or text of at most 64 KB. A bigger one gets `413`. The payload reaches the Turn after the Routine's prompt, labelled as untrusted data from a webhook, not as instructions (slide 29).
- **Nothing is revealed.** A token that matches no active Routine, including a pending or paused one, gets `404`.
- **The model never sees the token.** The user sees the URL in the app once they approve the Routine.

This amends ADR 0017 ("no public HTTP contract yet") for this one route. ADR 0018 stays as it is: it covers outbound hooks.

## Considered Options

- **HMAC signing secret**: stronger against a leaked URL, but many senders can't sign.
- **A Host recipe, like outbound webhooks (ADR 0018)**: every Host would write the same verification, dedup and Router hand-off, and the Router is the SDK's.
- **No webhook Routines yet**: but the lecture defines a Routine as either a schedule or a webhook.

## Consequences

- The route's path, status codes and the `Idempotency-Key` header become a contract that callers depend on.
- A leaked URL lets anyone wake the Routine until the user rotates it. There's no rate limit yet (step 9 or a real need), but the Conversation queue batches a flood into few Turns.

---
Status: proposed
---

# Outbound webhooks are a Host recipe on the event hooks, not an SDK feature

`createChat` takes server-side event hooks (`hooks.onRunEnd`, `onUsage`, `onConversationCreated`, `onConversationDeleted`, `onSharedLinkChanged`), which fire after each write with ids and metadata only, at most once. Everything an outbound webhook carries is already in those events. So the Chat SDK ships **no webhooks**: no subscriptions, no signing, no retries and no delivery log. A Host that wants webhooks signs and POSTs from its hooks and retries through its own queue, following a recipe in the SDK's README.

User-configured webhooks (a user enters a URL in settings) are rejected for now. They would need a settings UI, a subscription table, protection against requests to internal addresses and a way to prove who owns an endpoint, and they only make sense once there are user API keys, which ADR 0017 defers.

**What would change this:** a second Host that needs the same delivery and retry code. The SDK would then take it over, with deliveries as background jobs on the Durable runner (ADR 0011).

## Considered Options

- **SDK-owned webhooks** (HMAC signing, retries, a delivery log table): a schema and a retry worker for one Host that can already do it with a few lines on `onRunEnd`.
- **User-configured webhooks**: a public surface with its own security work, and no caller asking for it.

## Consequences

- The event hooks are the SDK's only outbound surface, so their payloads are the contract a Host's webhooks build on, and changing them is a breaking change for those Hosts.
- Delivery stays at most once unless the Host adds its own durable queue.

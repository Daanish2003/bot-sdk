---
Status: accepted
---

# User API keys stay with the Host, and the SDK publishes no public HTTP contract yet

Considered as an amendment to ADR 0005, which keeps oRPC internal "with no OpenAPI reference and no public contract". A user API key would let something other than the UI (a CLI, a mobile app, an automation) call the Chat SDK. Most of that needs nothing from the SDK: auth comes from the Host, so a Host can already accept API keys in `getUser(request)` (for example Better Auth's `apiKey` plugin reading an `Authorization: Bearer` header). The key, its scopes, its revocation on a Ban, and its rate limits and Quota (a key is just its user, ADR 0007) all stay the Host's. The only thing left for the SDK to decide is whether to publish a **versioned public HTTP contract** (an OpenAPI reference, a stable surface, deprecation rules).

**Not yet.** No caller outside the UI exists, and a public contract would freeze an RPC layer that every current map is still changing. ADR 0005 stands unchanged until a real outside caller appears. When one does, the contract starts minimal: create a Conversation, send a Message and stream its Run, and list and read Conversations.

## Considered Options

- **SDK-owned API keys** (a key table, a keys page, a check before `getUser`): contradicts ADR 0005's "auth comes from the Host" and duplicates what a Host's auth library already does.
- **Publish the contract now**: every map's changes to the RPC layer would become versioned, breaking changes, with no caller to benefit.

## Consequences

- No schema, no keys page and no new dependency in the SDK.
- A Host that wants keys today wires them into `getUser` and calls the internal handler at its own risk: the routes may change on any copy of the SDK.

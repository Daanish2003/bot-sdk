---
Status: accepted
---

# A Run ends while a tool call waits for Approval

MCP tools need the user's Approval before they run, and Host tools may ask for it too. TanStack AI pauses a run at `needsApproval` with an interrupt and resumes it when the decision comes back. We don't keep that pause open. The Run **ends** at the interrupt: the assistant Message gets a new `awaiting_approval` status, and the pending call is stored as a `tool_call` part in state `awaiting_approval`. Approving or denying starts a **new Run** on the same Message, which rebuilds the history from the Message tree (ADR 0001) and passes TanStack's `resume`.

- Nothing waits in a process. A deploy's drain (ADR 0006) and the 5-minute Run cap (ADR 0002) only ever cover live generation, never a user thinking.
- The waiting state lives in the Message tree, so it survives restarts, shows on every device, and is what joining or reloading the Conversation finds.
- The choices are approve, deny, or allow this tool for the rest of the Conversation, stored on the Conversation. There is no user-wide "always allow".
- Stored parts gain a generic `tool_call` part (`toolCallId`, `name`, `source`, `args`, `result`, `state`), so `schemaVersion` goes up. `web_search` keeps its own part.

## Considered Options

- **Keep the run open while it waits**, as TanStack's examples do: holds a process and its stream, counts against the Run cap, and dies on every deploy.
- **Let the browser send history and the decision back** (TanStack's default resume): contradicts ADR 0001, where the server builds history from the Message tree.

## Consequences

- A schema change: the `awaiting_approval` Message status and the `tool_call` part.
- Whether `chat({ resume })` works with history rebuilt on the server is unverified. The spec needs a spike first.
- A Message can span several Runs; usage and Quota accounting sum across them.
- The new Run is planned by the same module as a send (`planRun` in `core/server/chat/run-plan.ts`), so it offers the same tools, prompts, replay and compaction as the Run that asked (#379). A send's web-search choice isn't stored, so `chat.decide` takes the user's choice as they decide (`webSearch`, as on a send). A decision without it, such as a Stop, offers the Web tools when the waiting reply already holds a `web_search` or `fetch_url` call.

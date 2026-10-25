---
Status: accepted, amended by ADR 0029 (the plugin list becomes a Bot core plus features)
---

# The platform is Bot-only: the assistant chat product goes, and the capabilities Bots can use move to plugins

The SDK had two products side by side: the general chat **assistant** (`plugins/assistant`) and **Bots**, the always-on agents built step by step from the lecture. The owner decided on 2026-10-20 to keep only Bots. The assistant's Memory went first (#650, ADR 0013 superseded).

**The keep rule.** The assistant's chat product goes. A capability a Bot could use as a tool, and that the lecture names, is pulled out into its own plugin (or core) and wired into Bots, Helpers and Routines. Anything that only makes sense inside assistant chat goes, with no Bot replacement.

**What Bots get:**

- **Connector tools** from a new `mcp` plugin: a user's Connections (MCP sign-ins) are shared by all their Bots. Their tools are Deferred tools, listed each Turn and never removed. A broken Connection returns an error telling the Bot to ask the user to reconnect. Every call is checked by Auto-review, except tools the server marks approval-free. The General Helper gets them too, and the connector is rung 2 of the cheapest-first ladder. Lecture slides 10, 16, 22, 25, 27 and 42 call for this. It reverses "connectors out of scope" (#573).
- **Image generation**: a deferred `generate_image` tool in the bot plugin, using the models plugin's image adapters and the user's Image Model. It writes the image to the Bot's Computer, and the Bot sends it like any other file (slide 22).
- **Web search** moves into the bot plugin, the only place that uses it.
- **Attachments** become Bot files. A user can send a Bot files from the web or by email. They are stored like the files a Bot sends, shown in the thread, and copied onto the Bot's Computer. The core attachment tables go.

**What goes:** Projects, Instructions, saved prompts, Artifacts, Shared links, Ratings, Branches and regenerate, Temporary Conversations, `fetch_url`, past-chat search, the assistant's Run, run plan and approval, its compaction, read aloud, and the command palette. Existing assistant data is dropped with no export, because the repo is never deployed. `examples/next-prisma` is deleted, so `apps/web` is the only Host. A signed-in user lands on `/bots`.

**Order:** three specs, each its own branch and PR:

1. **Expand seam**, a pure refactor. `createBotSdkOver` moves to core, core owns the `message.parts` envelope, `UserExport` gets one section per plugin, and the Host composes the Keys page.
2. **Bot capabilities.**
3. **Contract**: delete the plugin, its routes, tables and columns, and its tests.

This decision was charted in Wayfinder #781.

## Consequences

- Supersedes ADR 0002 (Runs outlive the client), 0004 (Shared link points at the tree), 0008 (Approval ends the Run) and 0016 (Artifact versions). Each now has `Status: superseded by ADR 0027`.
- ADR 0001 still holds for Bot Conversations, which append to the same Message tree and never branch.
- ADR 0006's `RunStreams` goes with the assistant. PubSub stays as amended by ADR 0026.
- ADR 0020's plugin list loses `assistant` and gains `mcp`.
- The channel email code (`plugins/channel/server/email-text.ts`) names attachments ("Attachments (not kept)") instead of keeping them. That changes: the owner's email attachments are kept as Attachments. ADR 0026 is marked amended.
- `message_status` keeps an unused `awaiting_approval` value, because Postgres can't drop an enum value without rebuilding the type.
- The Turns, Routines and Skills that `UserExport` leaves out today stay out of the export. Adding them is a later effort.

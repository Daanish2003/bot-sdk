---
Status: superseded by ADR 0027
---

# Artifact versions follow the Message tree and live in their own table

An Artifact version belongs to the assistant Message whose `create_artifact` or `update_artifact` call wrote it, so a Branch shows only the versions on its path, numbered along that path. Editing a Message before v2 gives a Branch that sees only v1, and regenerating the reply that created an Artifact makes a new Artifact. The content lives in an `artifact` table (id, Conversation, kind) and an `artifact_version` table (Artifact, `messageId` cascading on delete, number, title, full content). The Message's parts hold only a slim `artifact` part that points at the version. Each version stores its whole content, never a diff, so any version renders on its own.

## Considered Options

- **Versions as one timeline per Conversation**: a sibling Branch would show versions written by replies that aren't on its path, and the panel would no longer match what the Model sees.
- **Full content in `message.parts`**: least code, but every Conversation load reads every version of every Artifact (a 50 KB page over 20 versions is 1 MB of jsonb).
- **Storing diffs**: smaller, but rendering a version, a Shared link or an export would mean replaying a chain.

## Consequences

- Messages stay immutable (ADR 0001). Deleting a Message, Conversation or user removes its versions by cascade, so `deleteUser` needs no new step for them.
- History is rebuilt with Artifact calls replayed as stubs (no content), and the latest version of each Artifact on the path is sent fresh with each Run, so compaction never drops it.
- A Shared link serves versions through a route that checks the version's Message is on the shared path (ADR 0004).

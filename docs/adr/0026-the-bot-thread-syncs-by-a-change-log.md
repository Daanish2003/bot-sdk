---
Status: accepted, amended by ADR 0027 (the owner's email attachments are kept as Attachments)
---

# The Bot thread syncs by a per-Conversation change log; pub/sub carries only data-less hints

Every app the user opens must show the same Bot Conversation (lecture, slide 19). Notifications only say "something changed", and the database always has the real data. Until now the Bot thread got there in three ways:

- `bot.send` streamed the sending tab's Turn.
- Every other tab polled `bot.get` every 2 seconds.
- A 15-second refresh caught background work.

None of these had an order or a way to notice a missed update.

Every change to what the Bot thread shows now gets a **sequence number**:

- a Message appended
- a Turn's status
- a Rich control's state

The number comes from one counter per Conversation, `conversation.last_seq`, bumped under the Conversation's row lock in the same transaction as the change. Each change also writes a row `(conversation_id, seq, kind, ref_id, at)` to `chat.conversation_change`, which keeps the last 500 per Conversation.

The PubSub of ADR 0006 carries only the data-less `changed` hint on `conversation:<id>`, which reaches the browser over the SSE `/events` route. On a hint, on (re)connect and on focus, a tab fetches the changes after its cursor and applies them in order. A cursor older than the log, or a first number that isn't the next one, gets a full reload. A tab with a running Turn also fetches every 30 seconds, because PubSub is at-most-once and a lost last hint would otherwise leave "Working…" up. The lecture is silent on that fallback, so this is a recorded deviation.

This amends ADR 0006 for Bot Conversations: PubSub stays the control-signal seam, but a Bot app never takes data from it. `RunStreams` stays the assistant's.

## Considered Options

- **A Postgres sequence or timestamps as the number**: no lock, but values can commit out of order, so a reader can skip a change for good (#750).
- **Numbers stamped on each row, with no change log**: there's no single place to read "everything after 41", and Turn and card state changes have no row of their own to stamp.
- **Data in the signal (push the change itself)**: a lost or reordered push then corrupts the view, which is the failure slide 19's design avoids.
- **Postgres LISTEN/NOTIFY as the signal**: ADR 0006 already rejected it, because it fails behind transaction pooling.

## Consequences

- Writes to one Conversation queue behind its row lock. That is fine at one user's volume, and the Conversation already locks for Messages.
- Every code path that changes the Bot thread must write its change in the same transaction, or other tabs never hear of it. The spec makes this one helper.
- `bot.send` returns only the saved user Message. The follow stream and all Bot polling, except the 30-second fallback, are removed.
- Email and later Channels need no change log. They get deliveries, not a view.

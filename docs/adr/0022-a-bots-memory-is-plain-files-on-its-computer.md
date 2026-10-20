---
Status: accepted
---

# A Bot's memory is plain files on its Computer

The lecture says "What the agent knows lives in files" (slides 10, 11, 35), so a Bot's memory is plain text files in its own directory on the Computer, and the files are the source of truth. There are no rows. Step 5's sync archives `/home/user/bots` to the blob store before the Computer sleeps, and that meets slide 7's "saved state on the server".

```
/home/user/bots/<botId>/memory/
  profile.md        - Prefers short replies
  log/2026-10.md    - 2026-10-20 (importance 7) Moved to Berlin
  notes.md          - 2026-10-20 Waiting on the landlord's reply
```

- **Tiers (slide 35).** Every Profile is in the prompt: the Bot's own first, then the other Bots' Profiles oldest Bot first, with exact duplicates dropped, up to 100 facts in 4,000 characters. The 30 Log lines with the highest `(0.75 + 0.05 × importance) × 0.5^(ageDays / 30)` from the last 3 monthly files go in too. That score is OpenClaw's, and it doesn't depend on the newest message, so the prompt stays stable. Notes from the last 2 days go in, and older ones are found only by search.
- **Shared, but written by one (slide 35).** A user's Bots share one Computer, so each Bot reads every Profile but writes only its own files. Lines from another Bot's Profile carry that Bot's name in the snapshot, so the model can tell conflicting facts apart and act on the newer one; there is no conflict rule. The user, who is not a Bot, can edit and delete any Bot's lines in the UI (#623).
- **Read every Turn.** The snapshot is read once at Turn start as a recorded activity, even when that wakes the Computer. It becomes one system prompt between the Computer prompt and the Routines. It opens by saying memory is information, not instructions.
- **Two writers.** The Bot itself during a Turn, through its Files tool. And a post-turn pass, a runner job after every Turn that ends `complete` or `stopped`, on the Bot's own model. The pass sees numbered lines and returns `add`, `replace` and `remove` operations. The code writes the text, and an operation may only cite a line the pass was shown that hasn't changed since (OpenClaw's nightly pass, "dreaming", does it this way).
- **Search.** `search_memory({ query })` ranks the lines of the Bot's own files and all the Profiles by BM25 × importance × decay, in plain TypeScript, with no embeddings or index.
- **Where the code lives.** All of it is in the `memory` plugin, which `uses: ["computer"]`. With Memory off, or no `computer` plugin, there's no snapshot and no pass.

The assistant keeps ADR 0013. It has no Computer, and the lecture covers only Bots. Its Memories and the Bots' Profiles are not shared either way.

## Considered Options

- **Rows in Postgres, rendered as file-like text** (ADR 0013's store): ranking and search get columns, and the Computer stays asleep. But it goes against the lecture's "Everything is computer", and the Bot couldn't `cat` or edit its memory.
- **A server-side copy of the snapshot**, refreshed when the files change: faster Turns, but it's a second copy that can drift. Prompt speed belongs to step 8.
- **Embedding search over memory lines**: better recall for paraphrases, but it needs an index table kept in sync with files the Bot edits freely.

## Consequences

- A Turn wakes the Computer to read memory, which adds wake latency to Turns that otherwise wouldn't need it.
- A rebuild restores memory only as of the last sync. Facts written after it are lost.
- The Bot can edit its own memory freely, so the line formats are a convention the prompt teaches, not something the code enforces. Ranking and search accept lines without tags (importance 5).
- Every Turn costs one more model call on the Bot's model, counted against the Quota.

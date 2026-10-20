---
Status: accepted
---

# A Bot's Approval waits up to 15 seconds inside the call

When Auto-review blocks a Bot's tool call, the user gets an Approval request, and no answer in 15 seconds means blocked (lecture, slide 29). The call **waits inside its own job**. A reviewed call runs as two recorded activities:

1. the review;
2. on a block, a wait for the Approval, up to 15 seconds from a recorded deadline, polling the Approval's row.

The tool then runs, or returns an error that says what to do next. A replay after a crash finds both activities in the history and doesn't repeat them. A Helper's call waits the same way inside the Helper's job. A late yes changes nothing, and Stop during the wait counts as no.

This differs from ADR 0008, where the assistant's Run ends at an Approval and approving starts a new Run. ADR 0008 keeps nothing waiting in a process while a user thinks, with no time limit. A Bot's wait has a hard 15-second cap, so holding the job is cheap. ADR 0008 stays for the assistant until the assistant is removed.

## Considered Options

- **End the Turn at the block and resume it in a new job** (ADR 0008's shape, with a timeout job 15 seconds out): no process waits. But the Turn needs a resume path it doesn't have, and the loop needs an interrupt branch.
- **TanStack's `needsApproval` with `chat({ resume })`**: TanStack has no timeout, its flag is per tool and not per verdict, and `runLoop` would need an interrupt branch and stable run ids for replay. Findings: #681.

## Consequences

- A blocked call holds its job's slot for up to 15 seconds. A deploy's drain waits for it or replays it.
- The Turn loop is unchanged. Review and wait live in the tool call's own activities.
- If the cap ever grows past seconds, this decision should be revisited for ADR 0008's shape.

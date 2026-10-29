---
Status: accepted
---

# An unanswered Approval stays pending, and a yes runs the stored call

Amends ADR 0024. Decided in [What happens when an Approval outlives the wait](https://github.com/Daanish2003/bot-sdk/issues/984), on the [Approval rules](https://github.com/Daanish2003/bot-sdk/issues/973) map.

ADR 0024 follows the lecture (slide 29): a blocked call waits 15 seconds inside its job, and silence counts as no. That makes a Bot useless for anything risky while the user is away, which is when an always-on Bot works most. ChatGPT dots and Claude Duet both keep an Approval open and carry on. By the owner's decision, this goes past the lecture.

- **The 15-second wait stays** as the fast path. A yes within it runs the call inside its job, as today.
- **Past it, the Approval stays pending** instead of counting as no. The call returns a result saying it waits for the user's Approval and that the Bot can carry on with anything that doesn't depend on it. The Turn continues.
- **A late yes runs the stored call** exactly as it was asked, with the input the user saw, in its own background job. Its result wakes the Bot as a Trigger. The Bot never makes the call again, so what runs is what was approved.
- **A late no wakes the Bot** too, so it doesn't go on assuming the call will run.
- **A pending Approval expires after 7 days**, a constant in the SDK. Expiry shows in the thread and wakes no one.
- **A pending Approval belongs to the Bot, not the Turn.** Stop during the 15-second wait still counts as no. A new Message during the wait ends the Turn but not the Approval, which goes pending: the user may not have seen it yet. After the wait, neither Stop nor a new Message touches it.
- **A Helper's blocked call** goes pending the same way. Its stored call's result wakes the Bot, since the Helper has usually finished.
- **Every browser or desktop action on a Screen** (a Computer-use Helper's acting calls, and the safety checks that always ask) keeps ADR 0024's strict 15 seconds with silence as no: a stored click on a live Screen means nothing days later. Pending covers shell commands and Connector tools.
- **A Routine's Approval** is unchanged.

## Considered Options

- **Keep ADR 0024** (silence is no): simple, and the lecture's design, but the Bot can't finish risky work while the user is away.
- **A yes wakes the Bot to make the call again**, and Auto-review passes it as approved: the Bot's second call could differ from what the user approved.
- **End the Turn at the block** (ADR 0008's shape) and resume it on the answer: the Turn would need a resume path, and the Bot couldn't get on with other work meanwhile.
- **No expiry**: a call approved weeks later would run in a world that has moved on.

## Consequences

- An Approval gains a `pending` state past its wait, an expiry, and a link from a yes to the job that runs its stored call. That is a schema change, so the spec needs the owner's yes on it.
- A stored call runs outside any Turn: it needs the Bot's tools without a model, and its result is a new kind of Trigger.

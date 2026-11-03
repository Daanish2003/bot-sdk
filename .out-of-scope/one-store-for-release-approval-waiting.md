# One store for a release Approval's waiting state

A release Approval's waiting state is held in two places: `representative.pending_approval` and the card. The owner accepted this (2026-11-03).

## Why this is out of scope

No user-visible bug remains: a Decline that finds no card clears the column once. Holding the state in one place would mean a wider `releaseApprovals` core service, an ADR 0029 amendment and a change to what the column holds, all to tidy something that works.

Look at this again if the two stores ever disagree in a way a user can see.

## Prior requests

- #1206: "Representative: hold a release Approval's waiting state in one place"

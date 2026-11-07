# A cache of each held Channel account's holder

Each inbound update on a held Channel account looks up its holder in a transaction, through every enabled feature's `channelAccountOwner`, and the Representative's stranger path reads `representative_channel_account` again. That is two SELECTs plus BEGIN/COMMIT per update, and `reconcile` repeats the lookup. The owner decided to leave this as it is (2026-11-07).

## Why this is out of scope

The lookups are correct, and no load has been measured. This repo is an experimental SDK lab that isn't deployed, so no burst of inbound messages is hitting it today.

A cache isn't free either. The holder changes on save and remove, which call `accountsChanged`, and that is published to every instance. But `accountsChanged` runs after commit and swallows publish failures, and enabling or disabling a feature changes the holder only at a restart. A cache would need a refresh in the 30-second `sync` or a TTL to cover those gaps, and a stale holder would send a Customer's message to the wrong place.

Look at this again before the packages are published, or if a Host measures the inbound path as a bottleneck.

## Prior requests

- #1342: "Channel accounts: cache each held account's holder on the inbound path"

# An incremental read for the web chat widget

Every hint makes each open widget tab re-run the full message read: the newest 200 rows, with two correlated subqueries per row. Up to five tabs per visitor session each run it. The owner decided to leave this as it is (2026-11-07).

## Why this is out of scope

The full re-read is correct, and no load has been measured. This repo is an experimental SDK lab that isn't deployed, so no crowd of visitors is reading the public route today.

An incremental read isn't a plain cursor. A read that only appends can't remove a message that delivery later drops or that a merge undo takes away, and it misses a reply that becomes visible after a newer visitor message. A correct design needs a way to tell the page that earlier rows changed, such as a version or count check that falls back to a full read, or remove events on the stream. That is a design to settle when there is load to settle it against.

Look at this again before the packages are published, or if a Host measures the widget's read as a load problem.

## Prior requests

- #1343: "Web chat: incremental read instead of a full re-read on every hint"

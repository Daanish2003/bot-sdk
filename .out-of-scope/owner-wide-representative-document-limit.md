# An owner-wide limit on Representative document text

Nothing caps how much Representative document text an owner can store. Each draft can hold 50 documents of up to 2 MiB of text, nothing caps how many drafts an owner has, and documents pinned by old Releases are kept when replaced. The owner decided to leave this as it is (2026-11-05).

## Why this is out of scope

A limit needs a number, and there's no real use to set one from. This repo is an experimental SDK lab that isn't deployed, so nobody's storage is at risk today. A limit would also need rules for what happens to an owner already past it, and to documents an old Release still pins.

The limits that do exist cover what a limit here would protect first: the per-document and per-draft caps bound a single upload, and the character limit on approval stops oversized text from reaching a Customer.

Look at this again before the packages are published, or if a Host reports storage growth from Representative documents.

## Prior requests

- #1274: "No owner-wide limit on Representative document text"

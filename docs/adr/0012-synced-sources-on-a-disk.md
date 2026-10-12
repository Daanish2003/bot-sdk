---
Status: accepted
---

# Synced sources live on a disk and are read with allowlisted shell commands

A Synced source (a GitHub repository, to start with) is cloned onto a disk the server can read, and the assistant searches it with read-only, allowlisted shell commands (`ls`, `find`, `grep`, `cat`, `head`, …) rather than with embeddings. This follows vercel-labs/knowledge-agent-template (MIT): its command policy is adapted with its notice kept, and its Vercel Sandbox, Workflow and AI Gateway are replaced by local child processes, the durable runner (ADR 0011) and our own Provider adapters.

Knowledge files, by contrast, are chunked and searched by meaning in Postgres. The two kinds answer different questions: code and docs reward exact names and whole files, while prose rewards meaning.

## Considered Options

- **Embed Synced sources like Knowledge files**: loses exact matches on identifiers and file structure, and re-embeds on every sync.
- **Keep the files in object storage**: `grep` can't run over it without copying everything down first.
- **A sandbox service per search** (Vercel Sandbox or a container): stronger isolation, but another paid service, for commands that only ever read.

## Consequences

- The web service needs a persistent disk, which on Render ties it to a single instance. ADR 0009 must account for this.
- The command policy is the security boundary: it is tested, and every argument is re-quoted and confined to the source's directory.

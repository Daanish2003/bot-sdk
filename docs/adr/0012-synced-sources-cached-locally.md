---
Status: superseded by ADR 0025
---

# Synced sources are cached locally at the synced commit and read with allowlisted shell commands

A Synced source (a GitHub repository, to start with) is searched by the assistant with read-only, allowlisted shell commands (`ls`, `find`, `grep`, `cat`, `head`, …) rather than with embeddings. This follows vercel-labs/knowledge-agent-template (MIT): its command policy is adapted with its notice kept, and its Vercel Sandbox, Workflow and AI Gateway are replaced by local child processes, the durable runner (ADR 0011) and our own Provider adapters.

The files are a throwaway cache, not stored data. A sync records in Postgres the commit the source was synced to. Whichever process runs a search makes sure it has that commit's files in a local folder, and on a miss shallow-clones that commit from GitHub. A deploy or restart that wipes the folder costs a re-clone, nothing more, so no persistent disk is needed and the choice of host is left open.

Knowledge files, by contrast, are chunked and searched by meaning in Postgres. The two kinds answer different questions: code and docs reward exact names and whole files, while prose rewards meaning.

_Amended 2026-10-12, the day it was accepted and before anything was built on it: it first put the files on a persistent disk, and a persistent disk turns off overlapping deploys and pins the service to one instance ([#168](https://github.com/Daanish2003/ai-chat/issues/168))._

## Considered Options

- **Embed Synced sources like Knowledge files**: loses exact matches on identifiers and file structure, and re-embeds on every sync.
- **Keep the files on a persistent disk**: every host we looked at then stops the old process before starting the new one on deploy and allows one instance, for files GitHub already holds.
- **A snapshot archive in the Chat SDK's file storage**: search keeps working without GitHub, but repository archives land in Postgres by default and bloat its backups. It can be added behind the cache later.
- **A sandbox service per search** (Vercel Sandbox or a container): stronger isolation, but another paid service, for commands that only ever read.

## Consequences

- The first search after a deploy, or on a new instance, waits for a clone, and needs GitHub and the source's stored GitHub credential to be working.
- The cache needs a size limit per Synced source and a rule for evicting old commits, since a host's temporary disk can be small (settled in the amendment below).
- The command policy is the security boundary: it is tested, and every argument is re-quoted and confined to the source's directory.

## Amendment: TanStack AI tools, and the policy alone isn't enough (2026-10-12, #197, #201)

- **The tools are ours.** `kb_shell` and `kb_shell_batch` are TanStack AI `toolDefinition(...).server(...)` tools. The template's `bash`/`bash_batch` use the `ai` package's `tool()` and a Vercel Sandbox, and neither comes with them.
- **More than the policy is needed once commands run as local processes.** The [shell-policy research](../research/knowledge-agent-shell-policy.md) found that the policy checks path text and never follows symlinks, and that a child process inherits the server's environment. A cloned repo with a symlink to `/proc/self/environ` would pass the check and expose secrets. So:
  - clones are symlink-safe (`core.symlinks=false`, or a check that real paths stay inside the source's folder);
  - commands get a minimal environment;
  - every command has a timeout, an abort and an output cap.

## Amendment: private repositories through a GitHub App (2026-10-12, #209)

The Host registers one GitHub App with read-only Contents and Metadata access, and passes it as `createChat({ github })`. A user's GitHub Connection is that App installed on the repositories they chose. Syncs and clones use one-hour installation tokens minted on demand, so no long-lived user token is stored, and any process can clone with nobody signed in. The install callback checks, through the user's own OAuth, that the user can see that installation before it's linked to them. Public repositories need no Connection.

- **A personal access token saved as a Tool credential**: needs no Host setup, but the user copies a long-lived secret by hand. It stays the fallback if a Host can't register an App.
- **The Host's GitHub sign-in token**: only works for users who signed in with GitHub, and needs the `repo` scope, which can also write.

## Amendment: tarballs instead of clones, and syncs record only the commit (2026-10-12, #210, #211)

"Shallow-clones" above is replaced. The production image (`node:24-slim`) has no `git`, and a Host's image may not have it either.

- **Downloaded as a tarball.** A process fetches the commit with GitHub's tarball endpoint, streams it through a byte cap and extracts it with the `tar` package. Extraction skips symlinks, files over 1 MB and binary files, so the symlink rule is enforced where the files arrive.
- **Size limits.** A source whose reported size is over 500 MB is refused when it's added, and extraction stops at 100 MB of text.
- **The cache.**
  - It lives under `os.tmpdir()` (or `createChat({ sourceCacheDir })`), capped at 1 GB per process.
  - Evicting goes least-recently-searched first, and an older commit is evicted once a newer one is cached.
  - Extraction is renamed into place when it's done, and searches in the same process wait for a download already under way.
- **A sync only records the commit.** The `sync_source` job, keyed per source, asks GitHub for the branch's head commit and stores it. It downloads nothing; a process downloads when a search needs that commit.
  - A daily `schedule` enqueues every source, and "Sync now" is limited to once a minute.
  - A failed sync keeps the last good commit.

## Amendment: real processes, and Shared links hide the output (2026-10-12, #212)

- **Commands run as real processes.** Each command runs as `bash -c` on the policy's re-quoted string, in the source's folder, with a minimal environment, a 10 s timeout and output caps counted while reading. The Host image needs `bash`; Windows dev uses Git Bash. `just-bash` (vercel-labs, Apache-2.0), a simulated bash in TypeScript, is the fallback for a Host without one. It isn't used now because of its heavy dependencies.
- **Files are cited with GitHub permalinks** at the synced commit, which the reply shows as Excerpt chips.
- **A Shared link shows the commands but not their output.**

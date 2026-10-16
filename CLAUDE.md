@AGENTS.md

## Claude Code

- Hooks in `.claude/settings.json` format and lint every file you edit (lint errors come back to you), block edits to the lockfile and `.env` files (`.env.schema` is allowed), block destructive git commands (force-push, push to `main`, `reset --hard`, `clean -f`, `--no-verify`) and `gh secret` / `gh workflow run`, and before you stop, when code changed, run the typecheck and lint on the changed files. Edits made through Bash bypass the edit hooks; prefer the Edit and Write tools.
- User-invoked skills (`disable-model-invocation: true`: `/workflow`, `/pr`, `/ship-spec`, and the plugin's `grill-with-docs`, `wayfinder`, `to-spec`, `to-tickets`, `implement`, `handoff`, `improve-codebase-architecture`) can only be started by the person typing them. Don't tell a subagent to use one; inline its steps in the brief.
- Personal permissions go in `.claude/settings.local.json` (gitignored), not the shared `settings.json`.

## Agent skills

### Issue tracker

Issues and specs live in this repo's GitHub Issues, through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

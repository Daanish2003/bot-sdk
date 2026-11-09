---
Status: accepted
---

# Coding agents are Helpers over ACP, on the user's own sign-in only when the user asked

Decided on the [Plans and coding-agent CLIs as providers](https://github.com/Daanish2003/bot-sdk/issues/978) map, in [Auto-review and Approvals for ACP permission requests](https://github.com/Daanish2003/bot-sdk/issues/1081), [Signing a coding-agent CLI in on the Computer](https://github.com/Daanish2003/bot-sdk/issues/1082) and [Which plan sign-ins become Provider credentials](https://github.com/Daanish2003/bot-sdk/issues/1083), then [Choosing which coding agent gets a task](https://github.com/Daanish2003/bot-sdk/issues/1085) and [How many coding agents run at once](https://github.com/Daanish2003/bot-sdk/issues/1086). Builds on ADR 0023 (linked Provider credentials) and ADR 0031 (Custom Rules).

A Bot can hand one complete coding task to a **Coding-agent Helper**: Claude Code, Codex, Gemini CLI or a custom agent, running on the user's Computer and driven over the Agent Client Protocol. A coding agent is never a Bot's Model; the Bot's own loop is unchanged.

- **Credentials.** Claude runs only on an Anthropic API key (its ACP adapter is started with `--hide-claude-auth`), and Gemini only on a Gemini API key. Both come from the user's Provider credentials, passed in when the agent starts. Codex can use the user's ChatGPT plan through its own sign-in, made once in Chrome on a Screen and kept on the Computer's disk. We never read or copy a plan credential. A plan sign-in is used only in a Turn the user's own Message woke. Routines, Check-ins, webhooks and other people in a group chat get the API-key route or a refusal.
- **Auto-review.** Every session starts in the agent's strictest ask mode, and the Helper switches back any change to a looser mode, or cancels. Each permission request goes through Auto-review like a General Helper's call. The only answers are allow once and reject once, so the agent never remembers a choice. A blocked request waits up to 30 minutes for the user's Approval, and silence counts as a reject. Look-only actions, which the agent runs without asking, are shown and logged but not reviewed.
- **Choosing and running.** The user sets a default coding agent, and their Message can name another Ready one. The Bot uses a Coding-agent Helper only to change code in a folder on the Computer, and falls back to a General Helper when no agent is Ready. Coding-agent Helpers share the General Helpers' limit of 3 per Bot, and only one coding agent at a time works in a folder.
- **Lifetime.** The ACP client runs inside the Helper's runner job and pipes the agent's input and output through the Computer's process API. Stopping the Helper, a Bot pause or a Bot reset cancels the session and ends the process. An interrupted job ends the agent too, and the Helper reports it was interrupted, with no resume.
- **No new plan sign-ins as Provider credentials.** The ChatGPT plan (ADR 0023) stays the only one.

## Considered Options

- **A coding agent as the Bot's Model**: it would bypass our loop, Memory, Skills and Auto-review.
- **Claude on the user's Claude plan**: the Claude Code terms allow hosting the unmodified Claude Code binary on a user's own subscription, but the ACP adapter is built on the Claude Agent SDK, whose docs forbid offering claude.ai login without Anthropic's approval.
- **Gemini on a Google AI Pro or Ultra plan**: Gemini CLI no longer serves those plans, and Google's terms forbid using them through a third-party product.
- **More plan tokens as Provider credentials**: only OpenAI documents such a route.
- **Native SDKs (Claude Agent SDK, Codex App Server)**: one seam for all agents, custom ones included, wins while every agent has a maintained ACP adapter.
- **A pending Approval that lasts 7 days, like other tool calls**: an ACP call can't be replayed outside its live session, so the agent has to wait, and that keeps the Computer awake.

## Consequences

- The ACP client (`@agentclientprotocol/sdk`) is a new dependency, which the owner approves in the spec.
- A Screen has a third use, a coding agent's sign-in.
- A user without an Anthropic or Gemini API key can't use Claude Code or Gemini CLI as a Helper.

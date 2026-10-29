---
Status: accepted
---

# Custom Rules are plain language, read by Auto-review

Decided in [What a Custom Rule is](https://github.com/Daanish2003/bot-sdk/issues/985), on the [Approval rules](https://github.com/Daanish2003/bot-sdk/issues/973) map. Research: [How Codex and dots express approval policy](https://github.com/Daanish2003/bot-sdk/issues/983).

A user's Custom Rule is a sentence in their own words, such as "Reply to emails from @acme.com without asking", with one of four modes. Auto-review reads the rules with the user's Messages, and a rule never lets a call skip the reviewer.

- **Without asking**: the rule is the user's permission, like their own Message, so a matching call passes.
- **If pre-approved**: a matching call passes only when the user's own Message, or a Routine they approved, asked for that action. Otherwise it waits for an Approval. This is the default today.
- **Ask before**: a matching call always waits for an Approval.
- **Hand off to you**: a matching call is blocked with no Approval offered. The Bot tells the user what to do, and a Computer-use Helper hands over its Screen.

The reviewer's built-in policy is the fallback for calls no rule covers. A rule can loosen or tighten any of it except a Never-allowed action. When rules conflict, the strictest wins: hand off, then ask, then pre-approved, then without asking. Rules belong to the user and apply to all their Bots. A Bot can propose one, which takes effect only after the user's Approval, as a Routine does. Rules are in the Bot's Prompt start.

## Considered Options

- **A structured matcher that code checks** (Codex: an exact command prefix with allow, prompt or forbidden): cheap and certain, but our risky calls are shell commands, browser and desktop actions and Connector tools, and a prefix can't say "emails from @acme.com" or "my bank's website" across them.
- **Rules that skip the reviewer when they match** (Codex): only a model can tell whether a plain-language rule matches a call, so the reviewer stays.
- **An "always allow" button on the Approval**: easy to click without reading what it grants. A rule the Bot proposes is a sentence the user reads and approves.

## Consequences

- Whether a rule applies is a model's judgment, so it can be wrong. Evals check that the reviewer follows rules.
- Rules reach only reviewed calls. A rule about a call the reviewer never sees, such as reading a file, does nothing, and the settings say so.
- Rules join what the reviewer is shown: at most 50 per user, of 500 characters each.

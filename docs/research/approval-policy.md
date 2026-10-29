# How Codex and dots express approval policy

Research for [#983](https://github.com/Daanish2003/bot-sdk/issues/983) (child of map [#973](https://github.com/Daanish2003/bot-sdk/issues/973)). Researched 2026-10-29.

## Question

How do Codex and ChatGPT dots express approval policy, and how does a rule combine with an automatic reviewer? What are Codex's approval modes and rules files (format, matching, precedence)? What are the dots Custom Rule modes, defaults and the limits on rules? Which actions does Claude Duet refuse even with approval, and how does its "bring the approval back later" flow work?

## Sources

Codex code is from [openai/codex](https://github.com/openai/codex) at commit **`588a277b301c3994455885d7f771d7d9db5d82b8`** (2026-10-29), read from a shallow clone. Nothing was run. Paths below are under `codex-rs/`.

| Ref | Source                                                                                                                                                                                          | What it is                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| CE  | [`execpolicy/README.md`](https://github.com/openai/codex/blob/588a277b301c3994455885d7f771d7d9db5d82b8/codex-rs/execpolicy/README.md)                                                           | Rules language: `prefix_rule`, `host_executable`, matching   |
| CP  | [`core/src/exec_policy.rs`](https://github.com/openai/codex/blob/588a277b301c3994455885d7f771d7d9db5d82b8/codex-rs/core/src/exec_policy.rs)                                                     | How rules, approval mode and heuristics give one decision    |
| CA  | [`protocol/src/protocol.rs`](https://github.com/openai/codex/blob/588a277b301c3994455885d7f771d7d9db5d82b8/codex-rs/protocol/src/protocol.rs) lines 1127-1200                                   | `AskForApproval` and `GranularApprovalConfig`                |
| CO  | [`core/src/tools/orchestrator.rs`](https://github.com/openai/codex/blob/588a277b301c3994455885d7f771d7d9db5d82b8/codex-rs/core/src/tools/orchestrator.rs) lines 140-224                         | Where a decision becomes skip, reject or an approval request |
| CG  | [`ext/guardian-reviewer/src/`](https://github.com/openai/codex/tree/588a277b301c3994455885d7f771d7d9db5d82b8/codex-rs/ext/guardian-reviewer/src) (`routing.rs`, `circuit_breaker.rs`, `lib.rs`) | Auto-review routing, timeout, denial circuit breaker         |
| CT  | [`prompts/templates/guardian/`](https://github.com/openai/codex/tree/588a277b301c3994455885d7f771d7d9db5d82b8/codex-rs/prompts/templates/guardian) (`policy_template.md`, `policy.md`)          | Auto-review's prompt: evidence, risk scoring, outcome rules  |
| CM  | [`config/src/mcp_types.rs`](https://github.com/openai/codex/blob/588a277b301c3994455885d7f771d7d9db5d82b8/codex-rs/config/src/mcp_types.rs), `core/src/mcp_tool_call.rs` lines 2545-2576        | Per-tool approval modes for MCP tools                        |
| CR  | [`config/src/requirements_exec_policy.rs`](https://github.com/openai/codex/blob/588a277b301c3994455885d7f771d7d9db5d82b8/codex-rs/config/src/requirements_exec_policy.rs)                       | Admin-enforced rules in `requirements.toml`                  |
| DR  | Docs, "Rules": https://learn.chatgpt.com/docs/agent-configuration/rules (redirect from developers.openai.com/codex/exec-policy)                                                                 | Public rules docs                                            |
| DA  | Docs, "Approvals and security": https://learn.chatgpt.com/docs/agent-approvals-security                                                                                                         | Public approval modes, sandbox and auto-review docs          |
| F   | Help Center, "Dots privacy, security, and safety FAQs": https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs                                                      | dots defaults and limits on rules                            |
| G   | Help Center, "Getting started with your dot": https://help.openai.com/en/articles/20001530-getting-started-with-your-dot                                                                        | dots Custom Rule modes and where to set them                 |
| S   | Help Center, "Get started with Claude Duet": https://support.claude.com/en/articles/17631495-get-started-with-claude-duet                                                                       | Duet approvals, refused actions, late approvals              |
| A   | Announcement, "Claude Duet": https://claude.com/resources/articles/claude-duet                                                                                                                  | Duet auto mode classifier, refused actions                   |

**F and G returned HTTP 403 to this session.** Their facts below come from the reading recorded in [`chatgpt-dots-inventory.md`](chatgpt-dots-inventory.md) (same URLs), and the four modes, the meaning of "pre-approved" and the mobile path were confirmed again from a search-engine extract of G. Nothing about dots here comes from a third party.

## Answer

- **Codex has three separate layers.** The **sandbox** sets what a command can technically do. The **approval policy** (`untrusted` / `on-request` / `granular` / `never`) sets when Codex stops to ask. **Rules** (`.rules` files of `prefix_rule(...)`) give a command `allow`, `prompt` or `forbidden`. **Auto-review** only replaces the human for requests that already reached "ask". [DA][CP][CG]
- **A Codex rule is a command prefix, not a description.** It matches an exact token prefix of argv. When several rules match, the strictest wins (`forbidden` > `prompt` > `allow`), across every file and layer. [CE][DR]
- **`forbidden` never reaches Auto-review or the user**: the call is rejected with the rule's `justification`. `allow` skips both, and runs outside the sandbox only if every part of the command is explicitly allowed. [CP 396-460][CO 166-224]
- **dots Custom Rules are free text with one of four behaviours**: take action without asking, take action if pre-approved (you asked for it in your prompt), ask before taking action, hand off to you. They come with defaults and can't override built-in safeguards or Auto-review. [G][F]
- **Duet has no user rules.** It always asks before it sends, pays, signs or deletes, and refuses a short fixed list (trading securities, moving money between accounts, acting on someone else's account) even with approval. If the user can't answer, it finishes the rest of the task and brings the approval back later. [S][A]

## Codex

### Approval modes

`AskForApproval` (CA lines 1145-1167; DA):

| Value        | What it does                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `untrusted`  | Every command asks unless a rule allows it. **DA says it is retired** ("no longer support"); the code keeps it as an internal policy for untrusted projects.             |
| `on-request` | Default. Commands the sandbox allows run without asking; the model asks when it needs to escalate.                                                                       |
| `granular`   | Per-category switches: `sandbox_approval`, `rules`, `skill_approval`, `request_permissions`, `mcp_elicitations`. A category set `false` is **auto-rejected**, not shown. |
| `never`      | Never asks. Anything that would have asked is rejected and returned to the model.                                                                                        |

Admins can restrict the allowed values with `allowed_approval_policies` and `allowed_approvals_reviewers`. [DA]

### Rules files

- **Where:** a `rules/` folder beside each active config layer, such as `~/.codex/rules/*.rules`; project rules in `<repo>/.codex/rules/` load only when that project is trusted. Layers are read low to high precedence and all files are merged into one policy. [DR][CP `load_exec_policy`, 664-718]
- **Format (Starlark):** `prefix_rule(pattern=[...], decision="allow"|"prompt"|"forbidden", justification="...", match=[...], not_match=[...])`. `decision` defaults to `allow`. Each pattern element is a literal or a list of alternatives. `match` / `not_match` are examples checked at load time, like unit tests. `justification` is shown in prompts and rejections; for `forbidden` the README suggests naming the alternative ("Use `jj` instead of `git`."). There are also `host_executable(name, paths)` (which absolute paths may match a bare-name rule) and `network_rule(host, protocol, decision)`. [CE][`execpolicy/src/parser.rs` 347-460]
- **Matching:** exact prefix of the argv tokens. A `bash -lc` / `sh -c` / `zsh -c` script made only of plain words joined by `&&`, `||`, `;` or `|` is split and each command is checked; a script with redirection, substitution, variables, wildcards or control flow is checked as one `["bash","-lc","<script>"]` call. [DR]
- **Precedence:** strictest decision across all matching rules, in all layers and all split commands. A higher layer can add rules but can't loosen a lower layer's `forbidden`. [CE][DR]
- **Admin rules:** `requirements.toml` `[rules]` can add only `prompt` or `forbidden`; `allow` is refused at load "because Codex merges these rules with other config and uses the most restrictive result". The config stack can also be set to skip user and project rules entirely (`ignore_user_and_project_exec_policy_rules`). [CR line 82][CP 185-203, 670-680]
- **Learned rules:** approving "always" in the TUI appends an `allow` rule to `~/.codex/rules/default.rules`. Codex may propose the prefix, but never one from a banned list of broad prefixes (`bash`, `python`, `node -e`, `git`, `rm`, `sudo`, `pnpm run`, ...), and never when a rule already matched. [DR][CP 56-146, 977-1016]

### When no rule matches

A fallback (CP `render_decision_for_unmatched_command_for_platform`, 777-862) decides:

- A built-in **dangerous-command heuristic** (currently `rm` with a force flag, also seen through `sudo`, `env` and `trap`) gives `prompt`, or `forbidden` under `never`. It can't be turned off by mode, only overridden by a matching rule. [CP 806-813][`shell-command/src/command_safety/is_dangerous_command.rs` 132-160]
- Otherwise it depends on the mode and sandbox: `never` allows (the sandbox protects); `untrusted` prompts; `on-request` and `granular` allow inside the sandbox and prompt only for an escalation.

### How rules combine with Auto-review

- `approvals_reviewer = "user"` (default) or `"auto_review"` (old name `guardian_subagent`). Auto-review runs only when the mode is `on-request` or `granular` and the reviewer is `auto_review`. [CG `routing.rs` 56-64][DA]
- Order for one command (CO 166-224): the rules decision comes first. **`forbidden` → rejected, no review.** **`prompt` → approval request**, which goes to Auto-review instead of the user. **`allow` → runs, no review**, except in "strict auto-review", which a user can switch on for the rest of a Turn when granting extra permissions; then even allowed calls are reviewed. [CO][`core/src/session/turn_context.rs` 495-517]
- Under `granular`, a `prompt` that came from a **rule** is rejected when `rules = false`, separately from `sandbox_approval`. [CP `prompt_is_rejected_by_policy`, 218-241]
- MCP tools have their own per-tool mode: `auto` (ask when annotations say destructive or open-world and not read-only), `prompt` (always), `writes` (ask unless read-only), `approve` (never). Combining two settings picks the stricter. [CM]
- **The reviewer:** a separate model with read-only tools and no network. Only user and developer messages, `AGENTS.md` and answers to its questions count as authorization; tool output, skills and the agent's own text are untrusted. It scores `risk_level` (low/medium/high/critical) and `user_authorization` (high/medium/low/unknown), then: low and medium allow; high allows only with at least medium authorization and narrow scope; **critical always denies, and a user's re-approval can't override it**. The security policy is text slotted into `{{ tenant_policy_config }}`, plus `auto_review.policy` / `extra_policy` in config (admins can set these too). Its outcome rules cover data exfiltration, credential probing, persistent security weakening and destructive actions. [CT]
- **Limits:** 90-second budget (`auto_review.timeout_ms`); timeouts and errors fail closed. Three denials in a row, or ten recent ones, interrupt the Turn (one for the cyber model). After a denial the user can approve **one retry** of that exact action (`ApproveGuardianDeniedAction`). [CG `lib.rs` 87, `circuit_breaker.rs` 3-6][CA line 900-903][DA]

## ChatGPT dots

- **Four behaviours per rule:** Take action without asking; Take action if pre-approved (you explicitly asked for it in your prompt); Ask before taking action; Hand off to you. [G]
- **What a rule names:** you describe the action in your own words and pick a behaviour; there is no structured action list or syntax in the docs. On mobile: Customize → Custom rules, to review the defaults or add a rule. G warns a dot can make mistakes, including when following your rules. [G]
- **Built-in defaults:** changing a password or transferring money requires you to take over; deleting data permanently or installing software asks each time; recurring messages can be pre-approved. [F]
- **Approval scope:** approving one message gives no ongoing permission, and asking for a draft doesn't authorise sending it. [F][G]
- **What rules can't do:** rules can't override built-in safeguards or Auto-review. [F] Auto-review checks planned actions against your instructions, Custom Rules and safety requirements before they run; when it blocks, the dot asks, tries an allowed alternative, or stops. [F] Rules also apply to work it delegates. [F]
- **Not stated** in the pages read: how two conflicting rules resolve, and an exhaustive list of which defaults are locked.

## Claude Duet

- **Always asks** before it "sends a message, makes a payment, signs a document, or deletes anything", and before each purchase (a one-time card per purchase). [S][A]
- **Refused even with approval:** "trading securities, moving money between accounts, or accessing someone else's account." [S] (A names the first two.) A separate classifier rejects sharing the strictest data tier (card and government ID numbers); health and finance data is shared only on explicit instruction. [A]
- **Late approvals:** "If you can't approve right away, Claude Duet finishes the rest of the task and brings the approval back to you later." Pending items show in the Tasks tab and the thread. Neither page says how long an approval stays open. [S]
- **Reviewer:** "Actions are approved by our auto mode classifier", the same one as Claude Code's auto mode; no further detail. [A] There are no user-written rules.

## Our side, for comparison

`packages/botsdk/bot/src/bot/safety/review.ts` holds one fixed reviewer prompt (ADR 0024): only the user's Messages or an approved Routine authorize; payments and transfers are always blocked to an Approval; when in doubt about a destructive or outward step, block. A block becomes an Approval that waits 15 seconds inside the Turn, and silence is no (CONTEXT: Approval, Auto-review). There are no rules, no refused-outright class, and no decision before Auto-review.

## What this means for our decisions

For **What a Custom Rule is** ([#985](https://github.com/Daanish2003/bot-sdk/issues/985)), the open choices:

- **What a rule matches:** a structured matcher (Codex: command prefix; MCP tool name + mode) that code checks before the reviewer, or a plain-language description (dots) that only a model can apply.
- **Which outcomes:** Codex's three (allow / prompt / forbidden), or dots' four, which add "if pre-approved" and "hand off to you". "Hand off" assumes takeover of the Computer, which we have.
- **Where a rule sits relative to Auto-review:** before it and binding (Codex: forbidden and allow skip the reviewer), or as input to it (dots: the reviewer checks against Custom Rules and can still block an allowed action).
- **Conflicts:** strictest wins (Codex) is the only documented rule; dots doesn't say.
- **Learned rules:** whether an Approval can offer "always allow this", and which broad prefixes it must never offer (Codex's banned list).
- **"Pre-approved"** depends on telling the user's explicit ask apart from a general goal, which our reviewer already does.

For **Never-allowed action classes** ([#986](https://github.com/Daanish2003/bot-sdk/issues/986)):

- **Who can't override:** Codex has two hard layers, `forbidden` rules (admin ones can't be loosened) and the reviewer's "critical always denies, even after re-approval". dots and Duet have built-in safeguards no rule or approval overrides.
- **Which classes:** Duet's list is trading securities, moving money between accounts and acting on someone else's account, plus the strictest data tier. dots forces a takeover (not a refusal) for password changes and money transfers. Codex's critical class is secret exfiltration to untrusted places and major irreversible destruction.
- **Refuse or hand off:** a class can be refused outright (Duet) or handed to the user to do themselves (dots). Our Auto-review today blocks payments to an Approval, which is neither.
- **How it's checked:** by code on a structured class (Codex rules and heuristics) or by the reviewer model (Codex critical, Duet classifier).
- **Late approvals** (Duet's "finish the rest, ask later") is a separate choice from both tickets: our Approval ends with the Turn.

# Plan terms per vendor for third-party use

Research for [#1079](https://github.com/Daanish2003/bot-sdk/issues/1079) (child of map [#978](https://github.com/Daanish2003/bot-sdk/issues/978)). Researched 2026-10-30 against each vendor's own terms and docs. Every page was read on that date. Pages that carry no date of their own say so. This is a reading of public terms for a lab repo, not legal advice.

## Question

For Anthropic (Claude plans), OpenAI (ChatGPT plans), Google (Gemini / Google AI Pro and Ultra) and xAI (Grok), what do the current terms allow a third-party product to do with a user's plan?

- **(a)** Drive the vendor's own CLI (Claude Code, Codex, Gemini CLI), logged in with the user's plan, on the user's machine, as an automated agent. For us that machine is the user's own cloud Computer.
- **(b)** Call the vendor API directly with the plan's OAuth token, as our Sign in with ChatGPT does today (ADR 0023).
- **(c)** Let other people (Room members) trigger work that runs on the owner's plan.

## Verdict

| Vendor                 | (a) CLI with plan login                                                                                                                                                                      | (b) API with plan OAuth token                                                                                                                                                         | (c) Others trigger the owner's plan                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Anthropic** (Claude) | **Allowed, with conditions**: unmodified Claude Code binary, the user signs in through Anthropic's own flow, and we accept the Commercial Terms [A1]. Unattended use is **unclear** [A1][A2] | **Not allowed** [A1]                                                                                                                                                                  | **Not allowed** [A1][A2]                                                                                                    |
| **OpenAI** (ChatGPT)   | **Allowed**: Codex app-server is documented for apps using the user's plan token [O2] and for VMs [O3]. Unattended use is **unclear** [O1]                                                   | **Allowed, through the Sign in with ChatGPT open-source flow only** [O2][O4]. Reusing Codex's own client ID would be **not allowed** (by our reading of [O6])                         | **Not allowed** (account sharing ban, quoted only from secondary copies [O6])                                               |
| **Google** (Gemini)    | **Unclear, leaning allowed**: Gemini CLI documents ACP mode for third-party clients [G2]. Its terms forbid third-party software that uses Gemini CLI OAuth to reach the backend [G1]         | **Not allowed** [G1][G3]                                                                                                                                                              | **Unclear, leaning not allowed** (Google ToS makes you responsible for your account [G4]; no explicit sharing clause found) |
| **xAI** (Grok)         | **Unclear**: no Grok CLI terms found                                                                                                                                                         | **Allowed in practice for named partners**: xAI promotes SuperGrok OAuth in OpenCode, Kilo Code and Hermes Agent [X1][X2]. No public client registration found, so **unclear** for us | **Unclear, leaning not allowed** (account sharing ban, quoted only from secondary sources [X3])                             |

**Gist.** Driving the vendor's own unmodified CLI on the user's own Computer, signed in by the user, is the one path every vendor documents or tolerates. Calling a vendor API with a plan token is allowed only by OpenAI (through its registered Sign in with ChatGPT flow) and, informally, xAI. Letting Room members spend the owner's plan is forbidden or unsupported everywhere.

## Anthropic

### What the terms say

**Claude Code: Legal and compliance** ([A1], https://code.claude.com/docs/en/legal-and-compliance, no date on the page; read 2026-10-30).

On hosting Claude Code in a product:

> Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with the conditions below:
>
> - **The Claude Code binary must not be modified.** Claude Code must be installed and run as published by Anthropic, and customers may not remove, disable, or restrict any authentication method built into it (including methods that permit signing in with a Claude account or the user's own API key).
> - **Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf.** Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential (...). That usage is billed directly to the end user under their own agreement with Anthropic (...).

On plan usage:

> Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK.

On authentication:

> **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.
>
> **Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.
>
> (...) Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under _Can customers offer Claude Code in their products?_ above.
>
> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

The same page names which terms cover plan users: "Consumer Terms of Service - for Free, Pro, Max, and Ultra users".

**Consumer Terms of Service** ([A2], https://www.anthropic.com/legal/consumer-terms, effective Oct 8, 2025 per the page header; read 2026-10-30).

Section 2:

> You may not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may not make your Account available to anyone else.

Section 3, item 7 (things you may not do):

> Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise.

**Claude Code: Authentication** ([A3], https://code.claude.com/docs/en/authentication, no date; read 2026-10-30). It documents `claude setup-token`, a one-year subscription OAuth token, "For CI pipelines, scripts, or other environments where interactive browser login isn't available". It also says unattended sessions exist: "A background session in agent view or a Remote Control session that outlives the login stops making progress once the credential expires".

### Our reading

- **(a) Allowed, with conditions.** [A1] explicitly allows a platform to host the unmodified Claude Code binary while the end user signs in with their own subscription. For us that means: install the published `claude` binary on the user's Computer, let the user complete `/login` (or `claude setup-token`) themselves through Anthropic's flow, and never read, copy or store the resulting credential in our database. The hosting clause also says this "requires agreeing to our Commercial Terms of Service". The owner would need an Anthropic Console account under the Commercial Terms to do this as a product.
- **Ambiguous: unattended runs.** Consumer Terms item 7 bans automated access except "where we otherwise explicitly permit it". Claude Code's own headless mode, `setup-token` for "CI pipelines, scripts" [A3], and the "ordinary, individual usage of Claude Code and the Agent SDK" line [A1] read as that explicit permission for the user's own scripts. A Bot Routine that fires Claude Code on a schedule for the owner is close to "a script" the owner runs. It is still our product deciding when to run it. Not clearly allowed or forbidden.
- **Ambiguous: does the Computer count as "collecting or storing" the token?** The `claude` binary writes `~/.claude/.credentials.json` on the Computer's disk, which our platform hosts. [A1] says "including where a platform hosts Claude Code", which covers that file. Pulling the token out (for example `setup-token` pasted into our settings and injected as `CLAUDE_CODE_OAUTH_TOKEN`) is storing a session token in our product, which [A1] forbids.
- **(b) Not allowed.** "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through ... plan credentials on behalf of their users." A Claude plan cannot become a Provider credential the way a ChatGPT plan did in ADR 0023.
- **(c) Not allowed.** "You also may not make your Account available to anyone else" [A2], and plan limits "assume ordinary, individual usage" [A1]. Room members triggering the owner's Claude Code would make the owner's account available to them.

## OpenAI

### What the terms say

**Codex: Authentication** ([O1], https://developers.openai.com/codex/auth, which now redirects to https://learn.chatgpt.com/docs/auth; no date; read 2026-10-30):

> Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs.
>
> API keys are still the recommended default for automation.
>
> Access tokens are intended for trusted scripts, schedulers, and private CI runners.

On headless machines it documents copying `~/.codex/auth.json` from a machine with a browser, and warns: "Treat `~/.codex/auth.json` like a password: it contains access tokens." and "Don't expose Codex execution in untrusted or public environments."

**Sign in with ChatGPT (SIWC)**, OpenAI's developer program for apps that use a user's plan ([O4], https://developers.openai.com/siwc, no date; read 2026-10-30):

> Let users sign in with ChatGPT and use their ChatGPT plan for eligible AI requests in your app.

Under "In your open-source app": "Let eligible users use their ChatGPT plan for AI requests in your app."

**SIWC: Codex app-server** ([O2], https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server, no date; read 2026-10-30). Apps supply "an OAuth access token authorized for the user's ChatGPT plan" to the app-server process: "Set `ACCESS_TOKEN` in the app-server child process's environment" and "No separate Codex sign-in is required." The app names itself, and "Codex uses this as the request originator for attribution."

**SIWC: Self-hosted VMs** ([O3], https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms, no date; read 2026-10-30):

> Use this guide when you run an open-source app on a remote virtual machine (VM).
>
> Complete OAuth locally with the same tool/client for the same user and workspace you will use on the VM.
>
> Host-specific usage attribution and revocation of ChatGPT plan access for transferred sessions are not yet available.

**SIWC: Request a client ID** ([O5], https://developers.openai.com/siwc/request-client-id, no date; read 2026-10-30): "Sign in with ChatGPT is currently offered to a select group of commercial partners." The open-source flow ([O7], https://developers.openai.com/siwc/token-sharing-open-source/sign-in) instead registers its own client dynamically: "`dynamic_agent_client` is the first-time registration entrypoint" and "this OSS flow remains a public client without a secret".

**SIWC: Accounts and sessions** ([O8], https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions, no date): "For ChatGPT Plus users, the five-hour usage limit is shared across all apps where they use their ChatGPT plan."

**Terms of Use.** openai.com returned HTTP 403 to our fetcher, so the clauses below come from secondary copies and were **not read on the primary page** ([O6], https://openai.com/policies/row-terms-of-use/; copies: https://open.windriver.com/info/uni-license-list/licenses/openai-tou-20241211.html, the December 11, 2024 version). A secondary source reports a newer global version effective January 1, 2026 that keeps these clauses; not confirmed.

> You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account.

Under "What you cannot do":

> Automatically or programmatically extract data or Output.
>
> Interfere with or disrupt our Services, including circumvent any rate limits or restrictions or bypass any protective measures or safety mitigations.

### Our reading

- **(b) Allowed, through SIWC only.** OpenAI documents an open-source flow in which an app registers its own client (`dynamic_agent_client`), gets a plan token with the user's consent, and calls `https://api.openai.com/v1/responses` with it [O2][O4][O7]. Our `CHATGPT_CLIENT_ID` / `CHATGPT_HOST_ID` (`apps/web/src/chatgpt-link.ts`) and the `ext_agent_host_id` in [O3] match that flow. This is the only vendor with a documented, sanctioned path for (b). Using Codex's own OAuth client ID instead would be impersonating Codex; no page allows it.
- **Ambiguous: commercial vs open source.** The plan-token path is filed under "token-sharing-open-source", while the hosted program "is currently offered to a select group of commercial partners" [O5]. Our repo is public and never deployed, which fits "open-source app". A hosted product built on it would likely need the partner track.
- **(a) Allowed.** [O2] documents an app running Codex app-server with the user's plan token, and [O3] documents doing that on a remote VM for "the same user and workspace". That fits a Codex Helper on the user's own Computer.
- **Ambiguous: unattended runs.** [O1] recommends API keys "for automation" and reserves non-interactive ChatGPT access tokens for Enterprise workspaces ("trusted scripts, schedulers, and private CI runners"). It is a recommendation, not a ban, but a Routine firing Codex on a personal plan is outside what OpenAI documents.
- **(c) Not allowed.** "make your account available to anyone else" [O6] (secondary copy). SIWC is framed throughout as "the user's plan" for that user's own requests.

## Google

### What the terms say

**Gemini CLI: Terms of Service and Privacy Notice** ([G1], https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md, last changed 2026-04-10 in commit e09410b6; read 2026-10-30):

> Directly accessing the services powering Gemini CLI (for example, the Gemini Code Assist service) using third-party software, tools, or services (for example, using OpenClaw with Gemini CLI OAuth) is a violation of applicable terms and policies. Such actions may be grounds for suspension or termination of your account.

The same page says Google AI Pro or Ultra users are covered by the "Google Terms of Service", "Google One Additional Terms of Service" and "Google Privacy Policy".

**Gemini CLI: FAQ** ([G3], https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/faq.md; read 2026-10-30):

> **Why can't I use third-party software like Claude Code, OpenClaw, or OpenCode with Gemini CLI?**
>
> Using third-party software, tools, or services to harvest or piggyback on Gemini CLI's OAuth authentication to access our backend services is a direct violation of our applicable terms and policies. Doing so bypasses our intended authentication and security structures, and such actions may be grounds for immediate suspension or termination of your account. If you would like to use a third-party coding agent with Gemini, the supported and secure method is to use a Vertex AI or Google AI Studio API key.

**Gemini CLI: ACP mode** ([G2], https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md; read 2026-10-30):

> ACP (Agent Client Protocol) mode is a special operational mode of Gemini CLI designed for programmatic control, primarily for IDE and other developer tool integrations.

It lists the ACP Agent Registry and IDEs "like JetBrains and Zed" as clients. Gemini CLI also documents a headless mode (`-p`, JSON output) for "a programmatic interface" (`docs/cli/headless.md`).

**Google Terms of Service** ([G4], https://policies.google.com/terms, effective July 30, 2026; read 2026-10-30): "You're responsible for what you do with your Google Account"; you must not use "automated means to access content from any of our services in violation of the machine-readable instructions". No explicit account-sharing clause was found.

**Google One Additional Terms** ([G5], https://one.google.com/terms-of-service, last modified October 1, 2026; read 2026-10-30): "You may not sell or transfer AI credits to another user or account". Benefits can be shared with a family group only by the plan manager.

### Our reading

- **(b) Not allowed.** [G1] and [G3] forbid exactly this: third-party software using Gemini CLI's OAuth to reach Google's backend. Google's named alternative is an API key.
- **(a) Unclear, leaning allowed.** Running the real `gemini` binary, signed in by the user, in ACP or headless mode is what [G2] advertises for "IDE and other developer tool integrations". Our software would not touch the OAuth token; the CLI would. But the [G1] wording ("Directly accessing the services ... using third-party software") does not spell out whether a third-party _client_ of the unmodified CLI is fine, and the FAQ names "Claude Code, OpenClaw, or OpenCode" as forbidden, which are tools that took the token. A Bot product driving Gemini CLI is further from an IDE than Zed is. Not confirmed either way.
- **(c) Unclear, leaning not allowed.** No explicit ban was found, but [G4] makes the owner responsible for all account use, AI credits cannot be transferred [G5], and sharing is only through the family group.

## xAI

### What the terms say

**xAI news: Use Grok in OpenCode** ([X1], https://x.ai/news/grok-opencode, May 21, 2026; read 2026-10-30): "Use your SuperGrok or X Premium subscription inside OpenCode." It offers "xAI Grok OAuth (SuperGrok Subscription)" and "xAI Grok OAuth (Headless / Remote / VPS)", and says "More open-source agents and integrations are coming soon."

**xAI news: Connect Grok to Hermes Agent** ([X2], https://x.ai/news/grok-hermes, May 15, 2026; read 2026-10-30): "Connecting Grok to your Hermes agent is available on every tier." Hermes Agent "can connect to messaging services such as WhatsApp, Discord, Telegram, and Signal". A similar page covers Kilo Code (https://x.ai/news/grok-kilocode).

**Consumer Terms of Service** ([X3], https://x.ai/legal/terms-of-service): returned HTTP 403 to our fetcher, so **not read**. Secondary sources report an account-sharing ban close to OpenAI's wording and, in the December 20, 2024 version, a ban on automated tools that send more requests than a normal user. Several 2026 versions exist (archived pages dated April 10, June 26, September 1 and September 11, 2026). No Grok CLI terms page and no public OAuth client registration were found.

### Our reading

- **(b) Allowed in practice for named partners; unclear for us.** xAI itself promotes plan OAuth in third-party open-source agents [X1][X2], which is the opposite of Google's stance. We found no way for an unlisted app to get its own client; reusing another tool's client ID is not something xAI documents.
- **(a) Unclear.** We found no xAI document about a Grok CLI driven by another product.
- **(c) Unclear, leaning not allowed**, on the reported account-sharing clause. Verify on the live terms before relying on it.

## What this means for the map

- **The coding-agent Helper survives**, in one shape: install each vendor's unmodified CLI on the user's own Computer, have the user sign in through the vendor's own flow inside that Computer, and keep the credential on the Computer. The SDK never reads or stores it. For Claude Code, hosting it as a product also requires the owner's Commercial Terms acceptance [A1].
- **Only the Computer owner's own turns may use their plan.** (c) is forbidden or unsupported for every vendor, so a Room member's message must not start a Helper run on the owner's plan login. They would need their own plan or an API key.
- **Plan sign-in as a Provider credential (b)** is possible only for ChatGPT (already shipped, ADR 0023) and maybe xAI. It is forbidden for Claude and Gemini.
- **Unattended runs (Routines, Check-ins) on a plan login are a grey area** for Anthropic and OpenAI. Both point automation at API keys.

## Sources

- [A1] Claude Code, Legal and compliance: https://code.claude.com/docs/en/legal-and-compliance (no date; read 2026-10-30)
- [A2] Anthropic Consumer Terms of Service: https://www.anthropic.com/legal/consumer-terms (effective Oct 8, 2025; read 2026-10-30)
- [A3] Claude Code, Authentication: https://code.claude.com/docs/en/authentication (no date; read 2026-10-30)
- [O1] Codex, Authentication: https://developers.openai.com/codex/auth → https://learn.chatgpt.com/docs/auth (no date; read 2026-10-30)
- [O2] SIWC, Codex app-server: https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server (no date; read 2026-10-30)
- [O3] SIWC, Self-hosted VMs: https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms (no date; read 2026-10-30)
- [O4] SIWC overview: https://developers.openai.com/siwc (no date; read 2026-10-30)
- [O5] SIWC, Request a client ID: https://developers.openai.com/siwc/request-client-id (no date; read 2026-10-30)
- [O6] OpenAI Terms of Use: https://openai.com/policies/row-terms-of-use/ (primary returned 403; quoted from the December 11, 2024 copy at https://open.windriver.com/info/uni-license-list/licenses/openai-tou-20241211.html)
- [O7] SIWC, Registration and sign-in: https://developers.openai.com/siwc/token-sharing-open-source/sign-in (no date; read 2026-10-30)
- [O8] SIWC, Accounts and sessions: https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions (no date; read 2026-10-30)
- [G1] Gemini CLI, Terms of Service and Privacy Notice: https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md (last changed 2026-04-10; read 2026-10-30)
- [G2] Gemini CLI, ACP mode: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md (read 2026-10-30)
- [G3] Gemini CLI, FAQ: https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/faq.md (read 2026-10-30)
- [G4] Google Terms of Service: https://policies.google.com/terms (effective July 30, 2026; read 2026-10-30)
- [G5] Google One Additional Terms of Service: https://one.google.com/terms-of-service (last modified October 1, 2026; read 2026-10-30)
- [X1] xAI, Use Grok in OpenCode: https://x.ai/news/grok-opencode (May 21, 2026)
- [X2] xAI, Connect Grok to Hermes Agent: https://x.ai/news/grok-hermes (May 15, 2026)
- [X3] xAI Consumer Terms of Service: https://x.ai/legal/terms-of-service (primary returned 403; not read)

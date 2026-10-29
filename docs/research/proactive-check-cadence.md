# Proactive check cadence and cost

Research for #1014 (map #975 "Proactive defaults"), 2026-10-30. Question: how often should a proactive check of a user's Connections run, and what does one check cost? Specifically: the cadence Claude Duet and ChatGPT dots use and how they avoid repeating themselves; how a generic check can tell what is new using only MCP tools (no per-app adapters, no server cursors); and a rough token and money cost of one check Turn with 1–3 Connections, against a Quota in money per day or month.

Owner decisions this builds on: watching means polling on a cadence of every few hours, generic over any MCP Connection with no per-app adapters, and only the user's first Bot is proactive.

## Sources

- **[DA]** Claude Duet announcement: https://claude.com/resources/articles/claude-duet (read 2026-10-30)
- **[DS]** Help Center, "Get started with Claude Duet": https://support.claude.com/en/articles/17631495-get-started-with-claude-duet (read 2026-10-30)
- **[DI]** Our Duet inventory, `docs/research/claude-duet-inventory.md` (#954)
- **[OI]** Our dots inventory, `docs/research/chatgpt-dots-inventory.md` (#955). It quotes the OpenAI Help Center pages "Getting started with your dot" and "Dots privacy, security, and safety FAQs". Both returned HTTP 403 to my fetches on 2026-10-30, so dots claims below are **second-hand via [OI]**.
- **[MT]** MCP spec 2026-07-28, Tools: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- **[MR]** MCP spec 2026-07-28, Resources: https://modelcontextprotocol.io/specification/2026-07-28/server/resources
- **[MS]** MCP spec 2026-07-28, Subscriptions: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions
- **[MP]** MCP spec 2026-07-28, Pagination: https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination
- **[MX]** MCP spec 2026-07-28, Schema reference (`ToolAnnotations`): https://modelcontextprotocol.io/specification/2026-07-28/schema
- **[AP]** Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing (read 2026-10-30)
- **[AC]** Anthropic prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- **[Code]** `packages/botsdk/bot/src/bot/context/warm.ts`, `packages/botsdk/bot/src/bot/context/tool-search.ts` on `main` (469a7e4b)

---

## Answer

1. **Cadence: every 3 hours, during the user's waking hours, is a defensible default.** Duet checks "every few hours" [DA] / "at set intervals" [DS], and says the interval exists to keep background work from using up the user's limits [DS]. Neither Duet nor dots documents an exact interval. 3 hours over a 08:00–22:00 day is 5 checks a day; round the clock is 8.
2. **Neither product documents how it avoids repeating itself.** Duet only says it posts when a task is done, needs a decision, or something needs attention, and that the main thread "stays quieter" [DS][DA]. Dots' proactive research "may read sources and save private notes" and forms memories from connected apps [OI]. So both lean on the agent's own judgment plus memory; there is no published dedupe rule to copy.
3. **MCP gives a generic poller no "what's new" signal.** There is no data cursor or "since" parameter in the protocol: pagination cursors exist only for `tools/list`, `resources/list`, `resources/templates/list` and `prompts/list`, and are opaque [MP]. Resource subscriptions need a long-lived `subscriptions/listen` stream; when it closes the server keeps no state, and nothing is replayed [MS]. Both are optional per server [MR]. So "new" has to be worked out by us.
4. **Tell what's new with a time window plus a seen-set, both kept by us.** Each check asks the Connection's read tools for items since the last check (minus an overlap margin), which most list/search tools take as an argument the Model can fill from the tool's `inputSchema` [MT]; then it drops items whose id (or content hash) it already reported. The overlap closes the gap Duet admits to ("something urgent can arrive between checks" [DS]); the seen-set stops repeats. `lastModified` annotations help when a server sends them, but they are optional [MR].
5. **One check Turn costs roughly $0.13–0.19 on Claude Sonnet 5.5, about twice that on Opus 5.5, and about $0.01 on Haiku 5.5** (1–3 Connections, cold cache; table below). The prompt cache is always cold: the Bot writes 1-hour breakpoints [Code], and a check runs hours after the last activity, so every check pays a full cache write of its prompt start [AC].
6. **Per day that is about $0.65–1.50 on Sonnet 5.5 (5–8 checks), up to ~$3 on Opus 5.5, and under $0.10 on Haiku 5.5.** Against a Quota of, say, $5 a day, Sonnet checks alone take 13–30% of it, every day, even when nothing happened. Checks spend from the Quota like any Turn (CONTEXT, Quota), as Duet's do from plan limits [DS].
7. **The biggest lever is not paying for a Model when nothing is new.** Options, cheapest first (our proposals, not from any source): a code-only gate that re-runs a watch recipe the Bot wrote (tool + arguments) and wakes the Bot only when unseen ids appear; or run the check on a cheap Model and wake the Bot's own Model only with findings; or skip quiet hours. Each is generic over MCP (no per-app adapter).
8. **Only call tools a check may safely repeat.** `readOnlyHint` would mark them, but annotations are hints and "Clients should never make tool use decisions based on `ToolAnnotations` received from untrusted servers" [MX]. Since the Host curates its MCP servers, the Host can trust its own servers' annotations; otherwise the check relies on Auto-review as every Connector tool call does.
9. **Unverified:** the Bot's real prompt-start size and how many Steps a check takes. The cost table uses assumptions (below); a one-off eval that runs a check Turn and reads the `botsdk.usage` rows would replace them with measurements.

---

## 1. What Duet and dots do

| Question                 | Claude Duet                                                                                                                                                                                                                                        | ChatGPT dots                                                                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cadence                  | "Claude Duet checks your connected accounts every few hours" [DA]; "checks your accounts at set intervals" [DS]. No exact number in either. A fixed morning brief over email and calendar [DS].                                                    | Not stated in the pages [OI] quotes. It "can research in the background and suggest ways to help" and reviews connected apps without being asked [OI].                                                                           |
| Why that cadence         | "to keep that background work from using up your limits" [DS]; "keeps usage down" [DA].                                                                                                                                                            | Not stated.                                                                                                                                                                                                                      |
| User control             | The announcement: "You can also tell it what you want to hear about and how often" [DA]. The Help Center describes no such setting [DS][DI].                                                                                                       | Users can schedule recurring checks themselves (e.g. a morning calendar review) [OI].                                                                                                                                            |
| Avoiding repeats / noise | Posts to the main thread "when a task is done or needs a decision from you" [DS]; messages "only when something needs your attention" [DA]. No dedupe mechanism documented. Admits it can misjudge urgency and miss items between checks [DS][DI]. | Proactive research "may read sources and save private notes" and forms memories [OI]. Its proactive tools can't send messages or change content; follow-ups go through normal action rules [OI]. No dedupe mechanism documented. |
| Cost to the user         | Uses the plan's five-hour and weekly limits; "Work it does in the background, like the morning brief and check-ins, also counts", so "you may reach your limits sooner" [DS].                                                                      | Chatting with the dot doesn't count toward ChatGPT limits; Codex and Work tasks it starts do [OI]. Whether proactive research counts is not stated.                                                                              |

Takeaway: both keep the agent quiet by default and rely on its memory of what it has seen. Duet's cadence is explicitly a cost trade-off, and its known failure mode (missing items between checks) is what an overlap window addresses.

## 2. Telling what's new with MCP tools only

What the protocol offers, and why each falls short for a generic poller:

| Mechanism                                         | What the spec says                                                                                                                                                                                                                                                                                               | Fit for polling                                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Pagination cursors                                | Only `resources/list`, `resources/templates/list`, `prompts/list`, `tools/list`. Cursors are opaque; clients "MUST NOT" parse them [MP].                                                                                                                                                                         | None: they page a list of tools/resources, not app data.                                                                       |
| Resource subscriptions                            | `subscriptions/listen` "opens a long-lived notification stream"; it replaces `resources/subscribe` and the HTTP GET endpoint [MS]. It ends when the transport closes (HTTP timeout, TCP drop) [MS]; on reconnect "the server holds no subscription state" (stated for stdio) [MS]. `subscribe` is optional [MR]. | Poor: needs a held-open stream per Connection, nothing is replayed after a drop, and few app servers expose data as resources. |
| `lastModified` annotation                         | Optional ISO 8601 timestamp on resources and on tool result content blocks [MR][MT].                                                                                                                                                                                                                             | Useful when present; cannot be relied on.                                                                                      |
| `structuredContent` / `outputSchema`              | Optional JSON result matching the tool's declared schema [MT].                                                                                                                                                                                                                                                   | Helps extract stable ids when present.                                                                                         |
| Stateful handles                                  | Non-normative: "MCP has no protocol-level session"; state across calls is an explicit handle the server returns [MT].                                                                                                                                                                                            | Confirms the client must carry any "since" state itself.                                                                       |
| `ToolAnnotations.readOnlyHint` / `idempotentHint` | Hints only; never decide on them for untrusted servers [MX].                                                                                                                                                                                                                                                     | Usable to pick safe-to-repeat tools on Host-curated servers.                                                                   |

A generic recipe that needs no per-app adapter (our proposal):

1. **Last-check time per Connection**, stored by us. Each check passes `since = lastCheck − overlap` (e.g. 15 minutes) to whatever date/time argument the read tool's `inputSchema` offers; the Model fills it, as it fills any argument.
2. **Seen-set per Connection**: ids (or a hash of each item's text when no id is visible) of items already reported, with a cap or expiry. The overlap re-fetches a few items; the seen-set drops them. This is what stops repeats, and it lives with us, not on the server.
3. **Report only unseen items that need attention**, otherwise end the Turn quiet (send nothing), matching Duet's and dots' quiet-by-default behaviour.
4. **Tools with no time argument** fall back to "latest N" plus the seen-set.

Where the seen-set lives (Memory Notes vs a table) is a schema decision for the owner; this note doesn't pick.

## 3. Cost of one check Turn

### Prices used [AP]

Per million tokens, USD. Cache hits on Opus 5.5 and Sonnet 5.5 are 0.05× base; others 0.1× [AP].

| Model                             | Base input | 5m cache write | 1h cache write | Cache hit | Output |
| --------------------------------- | ---------- | -------------- | -------------- | --------- | ------ |
| Claude Opus 5.5                   | $4         | $5             | $8             | $0.20     | $20    |
| Claude Sonnet 5.5                 | $2         | $2.50          | $4             | $0.10     | $10    |
| Claude Haiku 5.5 (prompts ≤ 100k) | $0.10      | $0.125         | $0.20          | $0.01     | $0.50  |

Cache lifetime is 5 minutes by default, 1 hour as an option, refreshed on each hit [AC]. The Bot sets 1-hour breakpoints for Anthropic (`cacheLifetimeMs`, `warm.ts`) [Code], so a check 3 hours after the last activity always starts cold.

### Assumptions (unverified, to be measured)

- **Prompt start ≈ 20k tokens**: instructions, the direct tools (`send_to_user`, `web_search`, `search_memory`, `shell`, `read`, `write`, `edit`, `list`, `start_helper`, `describe_tool`, `run_tool`) [Code], deferred-tool names, Profile and Memory, recent history. Not measured.
- **4 Steps**: `describe_tool` for each Connection's read tool; `run_tool` calls in parallel; one follow-up read; a final Step that records what was seen and ends quiet or sends one Message. Connector tools are deferred, reached through `describe_tool`/`run_tool` [Code].
- **Tool output**: ~1k tokens per tool description, ~4k per list result (about 20 items' metadata).
- **Output**: ~500 tokens per Step including reasoning (1.5k for 1 Connection, 3k for 3).
- Every new token is written to cache once (1-hour price) and read back as a cache hit on later Steps.

| Connections | Cache write | Cache read | Output |
| ----------- | ----------- | ---------- | ------ |
| 1           | ~26k        | ~70k       | ~1.5k  |
| 3           | ~37k        | ~85k       | ~3k    |

### Result

| Model      | 1 Connection | 3 Connections | Per day, 5 checks (3 Conn.) | Per day, 8 checks (3 Conn.) | Per 30 days, 8 checks |
| ---------- | ------------ | ------------- | --------------------------- | --------------------------- | --------------------- |
| Opus 5.5   | ~$0.25       | ~$0.38        | ~$1.90                      | ~$3.00                      | ~$90                  |
| Sonnet 5.5 | ~$0.13       | ~$0.19        | ~$0.95                      | ~$1.50                      | ~$46                  |
| Haiku 5.5  | ~$0.007      | ~$0.01        | ~$0.05                      | ~$0.08                      | ~$2.40                |

The cache write of the prompt start is most of the cost (on Sonnet 5.5, 37k × $4/M ≈ $0.15 of the $0.19). Two cheap savings follow:

- **Write the check's prompt at the 5-minute price, not the 1-hour one.** A check Turn lasts minutes and the next is hours away, so the 1-hour TTL buys nothing; on Sonnet 5.5 that cuts a 3-Connection check from ~$0.19 to ~$0.13.
- **Don't wake a Model when nothing is new.** If most checks find nothing, a code-only gate (re-run the read tools the Bot chose last time, compare ids to the seen-set, wake the Bot only on unseen ones) makes an empty check cost only the MCP calls. A cheaper-Model first pass is the middle option. Both are proposals, not measured.

Against a Quota: at $5/day, Sonnet 5.5 checks every 3 hours round the clock use ~30% of it with nothing to show; waking-hours only, ~19%. On Opus 5.5 that becomes 37–60%. A Host whose Quota is small should either default checks to a cheap Model or gate them in code.

## Not verified

- Dots' cadence and dedupe: the OpenAI Help Center pages returned 403; claims come via [OI] only, and those pages state no cadence.
- Duet's exact interval: neither Duet page gives a number.
- Our prompt-start size and Step count for a check Turn (assumptions above).
- OpenAI and Gemini prices: not checked; only Anthropic's table was read.
- Whether real Host-offered MCP servers (Gmail, Calendar, Slack, …) expose time-window arguments or stable ids in their read tools: not surveyed.

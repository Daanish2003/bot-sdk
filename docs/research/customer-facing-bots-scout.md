# Scout report: customer-facing Bots

Status: provisional. A starting point for grilling, not a decision.

## The idea

Today a Bot belongs to one signed-in user and talks only to that user. This lets any Bot create a restricted customer-facing agent which, once the owner approves it, runs on the server, talks to the business's customers, and reports back to the Bot.

**Main scenario:** an HVAC owner, a user of this app, runs several Bots. One of them drafts an after-hours line and the owner approves it. A customer calls or messages about a broken AC. The deployed agent answers from published knowledge and its memory of that customer, then hands the work to the Bot as a tracked task. The Bots decide, the agent tells the customer, and the owner steps in only when needed.

The owner wrote "HWA company". This report assumes HVAC. "Deployed agent" is a placeholder name, because `CONTEXT.md` lists "Agent" as a term to avoid for a Bot.

## Chosen route

A deployed agent in an optional plugin, owned by a Bot. Scope for now is a lab feature, built so that a real deployment doesn't need a redesign.

```
owner
   | approves each release, can take over a thread, can switch off
   v
any Bot (existing, unchanged)
   |  ^
   |  | tracked tasks and exceptions, not every message
   |  |
   |  | customer-visible fields only, on the way back down
   v  |
new deployed agent (optional plugin), immutable releases
   | no Computer, tools only from a code-defined list
   | customer memory rows, published knowledge
   |
new outbound gate
   | ^
   v |
customers (call / SMS / chat)
```

**Walkthrough**

1. A Bot drafts an agent: job text, tools from the code-defined list, chosen Knowledge and Channels. The owner can also create or edit one in the UI.
2. The owner approves, which publishes an immutable release.
3. A customer texts "my AC died". The adapter finds or creates their customer record and thread.
4. The agent reads published facts and documents, and that customer's memory. Code sets the customer id, so the model can't ask for anyone else's.
5. Code checks the required fields, and the agent hands the work to its Bot as a tracked task. It tells the customer "I'll confirm by text".
6. The Bot works with other Bots through tracked tasks and records a decision. Only customer-visible fields come back.
7. The agent's message passes the outbound gate, which checks who owns the thread, opt-outs, quiet hours, caps and draft or auto-send mode.
8. After the conversation, a pass saves facts and a summary to that customer's memory.

**Most likely failure:** the customer is left waiting or gets a wrong relay. [Relaying adds errors](https://www.langchain.com/blog/benchmarking-multi-agent-architectures), and [Cognition warns the setup fails when the front agent is much weaker](https://cognition.com/blog/multi-agents-working). So the agent can't be a much weaker model, and a stalled task needs a timer that escalates to the owner.

**Biggest new risk (reasoned, no incident found):** customer words or a poisoned file steer a Bot into drafting a bad agent. The defences are owner approval on each release, tools only from the code-defined list, and no agent deploying other agents.

## Routes not taken

- **The CSR Bot talks to customers directly:** the only thing between a customer and a shell with unwalled paths would be Auto-review, a model's judgement, and [published defenses of this kind fell to adaptive attacks](https://arxiv.org/abs/2510.09023).
- **A hosted contact centre in front:** the fastest way to reach real customers, but this is a lab feature for now, and it puts the customer experience outside the product. Reconsider it if a real business lines up.
- **One built-in Front Desk with a CSR Bot behind it:** too fixed. The owner wants any Bot to be able to run customer-facing work.
- **A fixed role per Bot:** enforceable, but rejected by the owner as too rigid.
- **A wall per Conversation, where any Bot serves customers itself:** the most flexible on paper, but it pushes "who is speaking" through the core (Prompt start, memory pass, `list_check_ins`), and one missed fix exposes owner context.

## Load-bearing decisions

| Decision                | Answer                                                                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lab or real             | Lab for now, built so a real deployment doesn't need a redesign                                                                                                                                                                              |
| Shape                   | A Bot drafts a deployed agent, the owner approves, it runs as an optional plugin and reports to that Bot. The owner can also create or edit one                                                                                              |
| Releases                | Each publish is immutable, with one-step rollback                                                                                                                                                                                            |
| Bot deleted             | The agent moves to the owner rather than dying with its Bot                                                                                                                                                                                  |
| Bot-to-Bot and handover | One tracked task concept with id, status and budget, shown to the owner as a log. Only allowlisted customer-visible fields come back, enforced in code                                                                                       |
| Reporting up            | A shared record the Bot can read, plus tasks and exceptions, not every message                                                                                                                                                               |
| Memory                  | Three layers per customer: typed profile with source, status and date; expiring summaries linked to transcripts; jobs and invoices read live, never copied. Unverified caller ID unlocks nothing. Cross-customer lessons need owner approval |
| Knowledge               | Typed facts quoted by code, plus an immutable document snapshot whole in the prompt, with no search index at first. Code checks citations. No source means refuse, hand off and log the gap. Test paraphrases before adding search           |
| Rules                   | One code-owned outbound gate, required-field checks, a fixed emergency script, no flow engine. Autonomy starts at drafts, then auto-send by topic                                                                                            |
| Rule tiers              | SDK rules always on; owner switches checked by code; owner guidance for tone and phrasing only. Auto-review and Custom Rules do not apply to the agent                                                                                       |
| Skills                  | Read-only procedures published with a release. The agent cannot write them or run code from them, and they grant no permission. A Bot can draft from its own Skills or Custom Rules, and the owner approves                                  |
| What is versioned       | Job text, rules, Skills, documents and tools go through a release. Facts edit live and are logged, and a change a Bot proposes needs owner approval                                                                                          |
| Memory scope            | Shared across one owner's agents, never across owners. An agent only sees the customer it is talking to                                                                                                                                      |
| Testing                 | A release is blocked until its test conversations pass. The owner can override, and the override is logged                                                                                                                                   |
| Runtime                 | Not serverless. No new platform or adapter: TanStack AI for model calls, `runLoop` for the loop, a `defineJob` job with its own `concurrency` budget on the existing Postgres runner                                                         |
| Licences and Providers  | No new open-source rule. Provider support stays as it is                                                                                                                                                                                     |

## Constraints

Paths are under `packages/botsdk/bot/src/` unless shown otherwise.

**Why this stays outside the Bot core**

- One Conversation per Bot: `storage/bot/bot.ts:16-19`, `CONTEXT.md:16`.
- Auto-review treats a `user` Message as the owner's permission and blocks messaging anyone else without the owner's ask: `bot/safety/review.ts:71,77,938`.
- A Turn's paths resolve anywhere on the Computer: `bot/conversation/bot-folder.ts:12-18`.
- The system prompt is frozen per Bot: `bot/context/prompt-start.ts:222-224` (per the survey).

**Why it isn't a Helper**

A Helper belongs to a Bot, runs its own prompt and tools (`bot/helpers/helper.ts:565-600`), and its report wakes the Bot. But it does one task within 50 Steps and 30 minutes (`helper.ts:71-77`), has no Conversation, needs a Turn to start it (`storage/bot/bot-helper.ts:52-56`) and gets Computer tools. The deployed agent is a new sibling that should reuse the same loop.

**Other code that shapes this**

- Strangers are dropped silently unless they send a link code: `bot/turn/messaging-inbound.ts:118`. This is the branch to route customers to an agent.
- Bots reach each other only by Room mentions, with a stop after three hops: `bot/triggers/handoff.ts:32-35,71`. Tracked tasks replace this for company work.
- A spent Quota drops the message silently: `bot/turn/messaging-inbound.ts:154-156`.
- The default runner handles 2 jobs per process (`runner/jobs/in-process.ts:37`, per the survey), so 50 customer threads would mostly queue unless the Host raises it.
- A new Routine already needs the owner's Approval: `CONTEXT.md:138`. Releases can follow that precedent.
- `MessagingAdapter` (`channel/messaging.ts`) is the seam for new Channels.

**ADRs**

| ADR        | Status   | Effect                                                                                                   |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------- |
| 0029       | accepted | Core plus adapters and features, the shape the plugin should take                                        |
| 0033       | accepted | Strangers get no reply and one Channel account belongs to one Bot. Needs an amendment                    |
| 0025       | accepted | Knowledge is files with no index and needs a Computer. The published snapshot needs an amendment         |
| 0022       | accepted | Covers a Bot's memory, so customer rows don't strictly contradict it, but they depart from its reasoning |
| 0007       | accepted | Quota is per user, so the owner pays for customer traffic                                                |
| 0024, 0030 | accepted | Approvals go to the owner and stay pending. Precedent for release approval                               |
| 0031, 0032 | accepted | Custom Rules and Never-allowed apply to Bots, and assume one owner speaking                              |
| 0021       | accepted | Webhook payloads never count as the user's word, a precedent for customer text                           |

ADRs 0007, 0021, 0024, 0030 and 0031 were checked by status line, title and code comments only, not read in full. `AGENTS.md` section 6 makes the schema, public API and any new dependency a human decision.

**Related open issues:** #979 Voice calls, whose plan rejects non-owner callers. #1073 Who may call a Bot. #976 Messaging Channels.

## Fog

- **Runtime gaps to fix:** `runLoop` spills long tool results to the owner's Computer whenever the Host has one (`packages/botsdk/bot/src/bot/agent-loop/loop.ts:651-660`, #1148). It needs a new `usageKind` and a per-customer key, because any kind but `helper` shares the Bot's thread and cache key (`loop.ts:306-307`, #1149). It also requires `owner.botId`. Turn latency hasn't been measured.
- **Scaling:** no load test exists for the Postgres runner. A test decides whether a later Executor is needed: [graphile-worker](https://github.com/graphile/worker/blob/main/LICENSE.md) or [pg-boss](https://github.com/timgit/pg-boss/blob/master/LICENSE) for wake-up delay, [Hatchet](https://github.com/hatchet-dev/hatchet/blob/main/LICENSE) for job-table load. [KEDA](https://keda.sh/docs/latest/scalers/postgresql/) on backlog is a deployment recipe with at least one worker running, not an SDK requirement.
- **Identity:** how a customer verifies before memory is revealed. Numbers can be [recycled](https://recyclednumbers.cs.princeton.edu/assets/recycled-numbers-05-03-2021.pdf) or [spoofed](https://www.transunion.com/blog/what-are-the-attestation-levels-for-stir-shaken). Web chat needs [expiring JWTs](https://www.intercom.com/help/en/articles/10807823-migrating-from-identity-verification-to-messenger-security-with-jwts) or similar.
- **Spending:** caps per customer and per conversation, and what a customer hears when the Quota runs out. No source was found on that last point.
- **Escalation:** how the owner gets paged. [A ticket wakes nobody](https://pagertree.com/docs/escalation-policies), and [single-number transfers hit voicemail](https://help.servicetitan.com/release-hub/docs/ensure-escalated-voice-agent-calls-reach-right-person-department).
- **Lifecycle:** thread states, separate agent and customer labels, and when a Bot's silence times out. [Pause rules vary by product](https://help.beside.com/en/articles/12117952-enable-and-manage-your-ai-text-receptionist).
- **Tracked tasks:** the state machine, budget size, and how they sit next to Rooms.
- **Voice:** how it joins the agent, given that #979 assumes the owner is the caller and OpenAI SIP is a gated alpha. Research concludes a realtime talker must consult slower work. Calls [hold a process for the whole session](https://docs.pipecat.ai/pipecat/deployment/running-bots-in-production), so they can't run as short jobs. [LiveKit](https://github.com/livekit/livekit/blob/master/LICENSE) is the strongest open-source option but would reopen #979, and TanStack AI 1.0 has no SIP or Live support.
- **Before any real deployment:** [A2P 10DLC](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc), [recording consent](https://ktslaw.com/en/Insights/Alert/2024/7/Wiretap-Laws-in-the-United-States), [opt-out rules effective 2026-11-25](https://www.recordinglaw.com/news/fcc-tcpa-consent-revocation-order/), [AI disclosure laws](https://verlingo.com/blog/chatbot-disclosure-laws-are-coming-for-customer-service-the-2026-state-map), and [deletion across every store](https://www.reedsmith.com/our-insights/blogs/viewpoints/102mm9l/edpb-report-on-the-right-to-erasure-key-takeaways-from-the-2025-coordinated-enfo/). All from secondary legal summaries, not legal advice.
- **Language:** `CONTEXT.md` needs terms for the customer, the deployed agent, and the tracked task.

## Sources

Dates are given where the field moves fast. Vendor pages are the vendor's own claims.

**Agents deploying agents**

- [OpenClaw multi-agent](https://raw.githubusercontent.com/openclaw/openclaw/main/docs/concepts/multi-agent.md): agents request, the operator approves, orphans move to the root.
- [Fin Operator](https://www.intercom.com/help/en/articles/14786093-fin-operator-faqs): proposes, never publishes.
- [Agentforce Trailhead](https://trailhead.salesforce.com/content/learn/modules/headless-360-use-a-conversation-to-build-an-agent/activate-the-agent): a coding agent deploys, preview afterwards. Conflicts with the approval precedent; a separate activate step is unconfirmed.
- [Sierra, Aug 2026](https://sierra.ai/blog/release-governance-guardrails-for-agents-at-scale), [Fin Releases, 2026](https://www.intercom.com/blog/announcing-evals-and-releases): immutable releases and rollback.
- [Entra Agent ID](https://learn.microsoft.com/entra/agent-id/best-practices-agent-id): sponsors and orphan reviews.
- [Jobber](https://help.getjobber.com/en/articles/receptionistpowered-by-jobber-ai/): outcome tags and escalation texts. [OpenClaw #182797](https://github.com/openclaw/openclaw/issues/182797): dropped completions.

No product was found where an agent publishes a long-lived customer-facing agent unreviewed.

**Customer identity**

- [Chatwoot Contact](https://raw.githubusercontent.com/chatwoot/chatwoot/develop/app/models/contact.rb), [ContactInbox](https://raw.githubusercontent.com/chatwoot/chatwoot/develop/app/models/contact_inbox.rb): contact, per-inbox identity and conversation schema.
- [Twilio Conversations participants](https://www.twilio.com/docs/conversations-classic/api/conversation-participant-resource): external and business address pair.
- [OpenClaw sessions](https://raw.githubusercontent.com/openclaw/openclaw/main/docs/concepts/session.md): `dmScope`, `identityLinks`. [AWS, Apr 2026](https://aws.amazon.com/cn/blogs/china/openclaw-from-personal-assistant-to-customer-service-a-trust-model-flip/): no per-user memory partition.
- _Analysis Patterns_, [ch. 2](https://www.oreilly.com/library/view/analysis-patterns-reusable/9780134271453/ch02.html): Party. Its fit here is our inference.

**Shape of the agents**

- [Anthropic, Dec 2024](https://www.anthropic.com/engineering/building-effective-agents): start simple.
- [LangChain, Jun 2025](https://www.langchain.com/blog/benchmarking-multi-agent-architectures): swarm slightly beat supervisor on a modified benchmark.
- [Cognition, 2026](https://cognition.com/blog/multi-agents-working): keep writes single-threaded.
- [Decagon, Oct 2026](https://decagon.ai/blog/voice-3): fast talker with a stronger model.
- [A2A Tasks](https://a2a-protocol.org/latest/topics/life-of-a-task/): task lifecycle.
- [MAST](https://arxiv.org/html/2503.13657v3): multi-agent failure rates, not from customer-service systems.
- [Process Manager](https://www.enterpriseintegrationpatterns.com/patterns/messaging/ProcessManager.html), [Correlation Identifier](https://www.enterpriseintegrationpatterns.com/patterns/messaging/CorrelationIdentifier.html): _Enterprise Integration Patterns_.

**Trust boundary**

- [Adaptive attacks on 12 defenses, Oct 2025](https://arxiv.org/abs/2510.09023).
- [Design patterns for securing LLM agents, 2025](https://arxiv.org/html/2506.08837): Context Minimization, Action-Selector.
- [Willison, Nov 2025](https://simonwillison.net/2025/nov/2/new-prompt-injection-papers): disputes that untrusted input plus state change is safe.
- [OpenClaw security](https://github.com/openclaw/openclaw/blob/main/docs/gateway/security/index.md): not a hostile multi-tenant boundary.
- [Moffatt coverage](https://www.cbsnews.com/news/aircanada-chatbot-discount-customer): the business is liable for what its bot says. Commentary only, the ruling wasn't read.
- _Release It!_ 2nd ed., ch. 5, Bulkheads ([table of contents](https://www.gbv.de/dms/ilmenau/toc/898405874.PDF)).

**Memory**

- [Fin Memory, beta, Jul 2026](https://fin.ai/help/en/articles/16004462-fin-memory): 45 days for summaries, 180 for facts.
- [Decagon, Mar 2026](https://decagon.ai/blog/user-memory), [Sierra, Aug 2026](https://sierra.ai/blog/context-engine): records stay in source systems. Fin's memory is hidden from teammates and Decagon's has full API access, a conflict.
- [Arize, Oct 2026](https://arize.com/blog/indirect-prompt-injection-ai-agents.md): session-bound tools, lab result.
- [Mem0 #4573](https://github.com/mem0ai/mem0/issues/4573): lost identifiers and a 97.8% junk audit, from one reporter.
- [Street-name errors, Feb 2026](https://arxiv.org/abs/2602.12249): 44% on average.
- [Unit 42, Oct 2025](https://unit42.paloaltonetworks.com/indirect-prompt-injection-poisons-ai-longterm-memory/): poisoning through summarization. [MINJA](https://arxiv.org/html/2503.03704v5) versus [Sunil, Jan 2026](https://arxiv.org/html/2601.05504): conflicting attack success rates.
- [Presidio study](https://arxiv.org/pdf/2602.16571): a PII scrubber missed 159 names.

No independent production comparison of memory versus no memory was found.

**Knowledge**

- [Anthropic, Sep 2024](https://www.anthropic.com/news/contextual-retrieval): whole prompt under about 200K tokens. [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching): 5-minute default TTL.
- Retrieval conflicts: [Cursor, Nov 2025](https://cursor.com/blog/semsearch) versus [grep beating vectors, May 2026](https://arxiv.org/abs/2605.15184). No support-paraphrase benchmark was found.
- [Fin audiences](https://academy.fin.ai/setting-up-your-knowledge-for-an-ai-first-support-operation): content defaults to Everyone. [Fin Guidance](https://www.intercom.com/help/en/articles/10210126-provide-fin-ai-agent-with-specific-guidance): not enforced.
- [ServiceTitan knowledge base](https://help.servicetitan.com/release-hub/docs/train-voice-agents-with-the-knowledge-base-to-answer-common-questions): uploaded documents and test calls.
- Hallucination conflict: [Fin's ~0.01% claim](https://www.intercom.com/learning-center/fin-ai-agent-copilot-reduce-handle-time-boost-productivity) versus [17–33% in legal RAG](https://arxiv.org/abs/2405.20362).
- [Claude Citations](https://claude.com/resources/articles/introducing-citations-api): vendor and customer reported gains.
- [PoisonedRAG, 2025](https://www.usenix.org/conference/usenixsecurity25/presentation/zou): 90% with five texts, in research.

**Rules and operations**

- [Agent Script](https://architect.salesforce.com/docs/architect/fundamentals/guide/hybrid-reasoning-agentforce-builder-agent-script): write decidable logic as code. [Fin Procedures versus Guidance, Aug 2026](https://www.intercom.com/help/de/articles/14623785-wann-man-fin-guidance-vs-procedures-verwendet).
- [τ-bench, 2024](https://arxiv.org/abs/2406.12045): GPT-4o 35–61%, repeat-run consistency under 25%.
- [Gorgias rollout](https://www.saastr.com/rolling-out-ai-agents-to-16k-smb-brands-with-gorgias-cto): preview, sampling, then all traffic. [Gorgias agent loop, Sep 2024](https://status.gorgias.com/incidents/13t2334v7trg): an agent answered itself.
- [Chatwoot lifecycle](https://www.chatwoot.com/docs/product/others/agent-bots): pending means bot-owned.
- [Field-service job notes](https://www.trade2base.com/help/job-notes): private by default. [Zendesk threads](https://community.zendesk.com/fid-8/tid-15929): internal notes reported showing, cause unconfirmed.
- [Fin resolutions](https://www.intercom.com/help/en/articles/8205718-fin-resolutions-how-are-they-measured): billed on assumed resolutions, so report verified outcomes instead.

**Voice and trades**

- [Twilio ConversationRelay](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay), [OpenAI Chat-Supervisor](https://github.com/openai/openai-realtime-agents), [LiveKit async tools](https://docs.livekit.io/agents/logic/tools/async.md).
- Latency targets conflict: [800 ms](https://daily-co.github.io/voice-ai-primer-web) versus [1,115 ms, limit 1,400 ms](https://www.twilio.com/en-us/blog/developers/best-practices/guide-core-latency-ai-voice-agents).
- [Half-Sync/Half-Async](https://www.dre.vanderbilt.edu/~schmidt/POSA/POSA2/conc-patterns.html): POSA2 ch. 5.
- [ServiceTitan voice agent, Early Access](https://help.servicetitan.com/roofing/docs/configure-your-voice-agent-settings). [Sameday](https://sameday.ai/industries/hvac) and [Avoca](https://www.avoca.ai/integrations/servicetitan) are marketing.

**Unanswered:** evidence on owners missing after-hours emergencies, carrier-filtering postmortems, a verified denial-of-wallet incident, and first-party Sierra or Decagon docs on customer identity.

## Next step

**`/wayfinder`.** The route is clear, but it's too big for one session, and it took more than three rounds of load-bearing decisions. The plugin and its releases, customer records, tracked tasks, published knowledge, customer memory, the outbound gate and new Channels are separate pieces, each with schema or public API decisions for a human, and two ADRs need amending. Tracked tasks are useful without customers, so they are a candidate first piece.

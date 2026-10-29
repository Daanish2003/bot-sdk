# ai-chat

A personal app for always-on Bots: signed-in users have Bots that work for them and talk to them in a chat thread.

## Language

**Bot SDK**:
The reusable SDK others install to give their users Bots. Bots, their Conversations, Turns, Routines, Helpers, Channels and the Computer are its core. Memory, Skills, Knowledge and Connections are optional features a Host turns on, and anyone can write another. It knows users only by id.
_Avoid_: Chat SDK, agent SDK, library, chat module, plugin

**Host**:
An app that embeds the Bot SDK and supplies its users and a Postgres database. It signs its users in itself and decides whether, and where, the Bot SDK's routes are served. The web app in this repo is one Host.
_Avoid_: Consumer, client app, integrator

**Conversation**:
The chat thread between a user and one of their Bots, or several in a Room. A Bot has exactly one 1:1 Conversation with the user, and a Conversation only ever grows at the end.
_Avoid_: Chat, thread, session

**Room**:
A Conversation the user shares with several of their Bots. A Message goes to the Bots it @mentions, or to the Room's lead Bot when it mentions none; a Bot that mentions another wakes it, and a mention carrying a task is a handoff. Bot-to-Bot wake-ups stop after a few hops until the user speaks again. Every Bot in the Room sees everything said there and keeps its own memory and Skills; a new Message interrupts only the Bots it goes to. A group chat on another Channel is a Room too.
_Avoid_: Team, channel, group chat, workspace

**Message**:
One entry in a Conversation, written by the user or a Bot. A Bot's own model text is never a Message; only what it sends is.
_Avoid_: Reply, prompt

**Provider**:
An LLM vendor a user can chat through, one per TanStack AI chat adapter (Anthropic, OpenAI, Gemini, OpenRouter, Ollama, …).
_Avoid_: Vendor, backend

**Model**:
One specific LLM offered by a Provider. Each Bot has a selected Model, which does its Turns.
_Avoid_: Engine, LLM (as a noun for one choice)

**Provider credentials**:
What one user supplies to reach one Provider: usually an API key, sometimes with an account or region, or just a host for a local Provider. For OpenAI it can instead be a linked ChatGPT plan, made by signing in to ChatGPT, which reaches only the Models the plan offers and is used only when the user has no OpenAI API key. When a user has them for a Provider, their Bots' Turns and Helpers on it always use them and never count against their Quota.
_Avoid_: Provider key, API key (ambiguous), token, BYOK key, ChatGPT Connection

**Host credentials**:
Provider or Tool credentials the Host supplies for all its users, with the Models it offers on them. Turns and Helpers on them count against the user's Quota.
_Avoid_: Server key, free tier key, platform key

**Quota**:
How much a user may spend on Host credentials per window (a day or a month), set by the Host per user. It is measured in money, and unlimited when the Host sets none. A Bot's Turns and Helpers spend from it. It is checked before a Turn and before each paid tool call (a web search, a Generated image), never by cutting a reply off.
_Avoid_: Limit, allowance, credits, free tier

**Admin**:
A user of the Host who runs it for everyone else: sees each user's spend, changes a user's Quota, Bans and unbans users, and turns off a user's two-factor sign-in when they have lost every way to pass it. An Admin never reads another user's Conversations.
_Avoid_: Operator (that is the person; Admin is the role), superuser, moderator

**Ban**:
An Admin shutting a user out, for good or until a set date: the user is signed out everywhere, can't sign in by any method, their running Turns and Helpers stop, and no Routine, Check-in or Channel message of theirs starts a Turn until the Ban ends.
_Avoid_: Suspension, block, disable

**Tool credential**:
A user's own API key for a non-LLM service a tool needs, such as web search. Without it, that tool is unavailable to the user.
_Avoid_: Search key, Provider credentials (those are for Providers only)

**Connection**:
A user's sign-in to one of the MCP servers the Host offers. All of the user's Bots can use its tools. Signing in to a site in a Screen's Chrome is not a Connection.
_Avoid_: Integration, connector, MCP credential, Tool credential (that is an API key)

**Connector tool**:
A tool a Bot gets from one of its user's Connections. It is a Deferred tool, and a call to it is checked by Auto-review, except for tools the server marks approval-free. When its Connection is gone or broken, the tool stays listed and the call returns an error telling the Bot to ask the user to reconnect.
_Avoid_: MCP tool, integration tool

**Approval**:
A user's yes or no to one tool call before it runs, to a new Routine, or to a Custom Rule a Bot proposes. A Bot asks for one for a tool call only when Auto-review blocks it: the call waits inside its Turn for 15 seconds, then stays pending while the Bot carries on. A later yes runs the call exactly as it was asked and wakes the Bot with its result; a later no wakes it too. A pending Approval expires after 7 days. A browser or desktop action on a Screen waits only the 15 seconds, and there silence counts as no.
_Avoid_: Confirmation, consent, permission

**Attachment**:
A file a user sends their Bot with a Message, from the web or by email. It shows in the thread and is copied into the Bot's folder on its Computer. Its content is untrusted.
_Avoid_: Upload, file part, document

**Generated image**:
An image a Bot made with `generate_image` and the user's Image Model, saved as a file on its Computer. The user sees it only when the Bot sends it, like any other file. An edit makes a new image from earlier image files; it never changes them.
_Avoid_: Image attachment, picture, output image

**Knowledge**:
The documents a user keeps on their Computer for their Bots to look things up in, in folders of their own choosing. All of the user's Bots share it, and the user and the Bots can both add to it and edit it. It is not Memory: Memory is facts about the user a Bot picks up itself, while Knowledge is documents kept for reference.
_Avoid_: Knowledge base, RAG, documents, library

**Knowledge file**:
One file in Knowledge, which a Bot reads with its file tools and shell. It is not an Attachment: it belongs to the user's Knowledge, not to a Message.
_Avoid_: Document, upload, attachment

**Memory**:
What a Bot knows about the user and keeps between Turns: plain files in its own directory on the Computer, which it reads and edits itself, in three tiers (its Profile, its Log and its Notes), with everything older found by search. Every Bot reads all of the user's Profiles, but each Bot writes only its own files. A user can turn Memory off for all their Bots.
_Avoid_: Fact, saved memory

**Profile**:
A Bot's file of core facts about the user, one per line, always in its prompt. A Bot's prompt holds its own Profile first, then the other Bots' Profiles, up to 100 facts in 4,000 characters.
_Avoid_: User profile, about me

**Log**:
A Bot's dated record of events, one per line, kept in a file per month; the most relevant recent ones are in its prompt. Only that Bot's own Log is in its prompt.
_Avoid_: Journal, history, diary

**Note**:
A short-term detail a Bot keeps, dated, that is in its prompt for two days and after that is only found by search.
_Avoid_: Scratchpad, reminder, Check-in (that wakes the Bot)

**Image Model**:
The Model a user picks for Generated images, independent of their Bots' Models. When they pick none, the Host's default is used; with no default, a Bot's `generate_image` call returns an error asking the user to pick one.
_Avoid_: Image generator, image Provider

**Bot**:
An always-on agent a user has: it runs on the server, wakes on Triggers, keeps its memory and Skills, and talks to the user only through the Messages it sends. It has one Conversation with the user and can work across others, such as Rooms. A user can have many Bots; they share the Profiles and one Computer.
_Avoid_: Agent, assistant, persona

**Turn**:
One Bot working through a batch of what woke it, until it stops. It works on one batch at a time. In a 1:1 Conversation the user skips the line: a new Message interrupts the running Turn, which ends where it is and is followed by a new Turn that takes the Message with the first one's work in view; Stop ends it with nothing following until the user's next Message. What an interrupted or stopped Turn already sent stays sent. It can send any number of Messages, or none.
Staying quiet means replying with no text; plain text the Bot writes never reaches the user, so the first time a Step ends in plain text the Turn takes one more Step with a note saying it was not delivered, unless no Step is left, when the Turn ends quiet.
_Avoid_: Run, step, session

**Step**:
One model call within a Turn and the tools it calls. A Turn is one or more Steps; it ends when a Step calls no tool, or when a Message the Bot sends says it is the last.
_Avoid_: Turn, iteration

**Checkpoint**:
The saved result of one piece of a Turn's or a background job's work. A Turn saves a Checkpoint after each Step's model call and after each tool call, so a Message it sends is sent once even across a crash; work resumed after a crash or a deploy starts after its last Checkpoint instead of from the beginning.
A job's `ctx.step(name, fn)` saves one Checkpoint: the API takes durable execution's usual name, and it is not a Turn's Step.
_Avoid_: Step, activity, snapshot

**Trigger**:
One event that wakes a Bot to run a Turn: the user, a Routine, an outside service, another agent, background work finishing or a Check-in. It records where it came from, so the Bot can tell whether the user asked, a Routine ran or an outside service sent it. Each carries a unique ID from its source, and one whose ID the Bot has already seen is dropped: a resent Message is the same Message, never a second one.
_Avoid_: Event, wake-up, input

**Router**:
What every Trigger passes through on its way to a Bot: it drops duplicates and puts each Trigger in its Conversation's queue.
_Avoid_: Dispatcher, inbox

**Conversation queue**:
The Triggers a Conversation has received that no Turn has taken yet, in the order they arrived. A Turn waits a moment before it starts so quick Messages land in one batch, takes everything waiting, and when it ends the next Turn takes whatever has arrived since, so a Conversation runs one Turn at a time.
_Avoid_: Inbox, backlog, job queue (that is the runner's)

**Routine**:
A prompt one Bot runs on a schedule (days of the week at a time, in the user's time zone) or when an inbound webhook arrives. A Bot can create one from its Conversation, but it runs only after the user's Approval. Each run lands in the Bot's Conversation, marked as the Routine's, never as the user's; a run missed while nothing was running happens once, late.
_Avoid_: Cron job, schedule, automation

**Check-in**:
A single moment a Bot sets for itself to wake and check on something, with a note to its future self. It needs no Approval; anything that repeats is a Routine.
_Avoid_: Reminder, Routine (that is a prompt the user approved)

**Helper**:
An agent a Bot hands one complete task to, which works in its own fresh context, keeps going after the Turn that started it, and reports back briefly. It belongs to its Bot and is never a Bot itself. A General Helper works with the shell, files and web search; a Computer-use Helper works a Screen's browser and desktop, needs a model that can use a computer, and a Bot has at most one of those at a time. The user's Stop ends the Turn, not its Helpers; its report wakes the Bot as a Trigger like any other.
_Avoid_: Sub-agent, worker, child agent

**Skill**:
Written instructions for one kind of task, starting with when to use them, kept as a file in its Bot's own directory on the Computer, which the Bot reads only when it needs them. The Bot or the user writes one, or the Bot drafts one from a Demonstration. A Skill is never permission to act.
_Avoid_: Plugin, prompt

**Demonstration**:
A Bot watching the user do a task once in the browser on its Screen, from Start to Done, so it can save the task as a Skill. Unlike taking control, the Bot sees what the user does, except while paused.
_Avoid_: Recording, teach mode, takeover

**Computer**:
The one cloud machine a user's Bots share, with its files, installed tools and browser sign-ins, asleep whenever nothing needs it.
_Avoid_: Sandbox, VM, machine, desktop

**Screen**:
One display on the Computer, with its own Chrome and Chrome profile, for one active Bot. It is open only while that Bot's Computer-use Helper or a Demonstration uses it, never both, at most four at once per Computer; its Chrome sign-ins stay on the Computer and are lost if it is rebuilt.
_Avoid_: Display, desktop, browser

**Auto-review**:
A separate model's check of a Bot's risky tool call before it runs. Every shell command is risky, and so is every browser or desktop action that does more than look. A call it passes runs without asking; one it blocks waits for an Approval. It takes only the user's own Messages, a Routine the user approved, or their Custom Rules as permission, so text from a webhook or a web page can't talk it into anything.
_Avoid_: Guardrail, moderation, safety check

**Custom Rule**:
A user's standing instruction, in their own words, for one kind of action their Bots might take, with one of four modes: do it without asking, do it only when the user asked for it, ask before doing it, or hand it off to the user. Auto-review reads it as the user's permission or restriction; the strictest matching rule wins, and none can make a Never-allowed action possible. It applies to all the user's Bots. The user writes it, or a Bot proposes it and it applies after the user's Approval.
_Avoid_: Policy, permission rule, allowlist

**Never-allowed action**:
A kind of action a Bot never takes, such as moving money between accounts or changing a password: Auto-review blocks it with no Approval offered, and the Bot tells the user to do it themselves. No Custom Rule or Approval changes that. The Bot SDK sets the list, and a Host can add to it but not take away; the user can't change it.
_Avoid_: Forbidden action, blocked action, hard limit

**Secret**:
A value such as a password or token that the user typed into a secure entry field for their Bots. A command on the Computer can use it, but the model only ever sees its name. Each user's Secrets are shared by all their Bots.
_Avoid_: Credential (that is for a Provider or Tool), password, env var

**Channel**:
Anything that sends to a Bot or shows what it sends: the user's apps (web, desktop, mobile), Slack, email, webhooks, schedules or phone calls. Every app the user opens shows the same Conversation.
_Avoid_: App, surface, client, platform

**SendToUser**:
The one tool a Bot talks to the user with. A Message it sends is text plus at most one Rich control. The text is what every Channel can always show. A Bot that sends nothing stays quiet, and its own model text is never shown.
_Avoid_: Reply, respond, notify

**Rich control**:
A purpose-built control in a Bot's Message, such as a choice, files, a password entry or an Approval, that the Host draws with its own components and that each Channel shows in the simplest form it can. The user's answer to a choice wakes the Bot like any Trigger.
_Avoid_: Widget, card, generative UI, component

**Summary**:
A short account of a Conversation's older Messages that a Bot works from in their place. The Bot's last few Messages to the user stay word for word.
_Avoid_: Compaction, recap, digest

**Prompt start**:
The beginning of a Bot's prompt that stays exactly the same on every model call until the next Summary: its tools, its system prompt (including the memory snapshot and Routines as they were when it was built), and a first message with the Bot's environment and the names of its tools.
_Avoid_: Prefix, header, preamble

**Deferred tool**:
A Bot tool that is listed by name in the first message but not sent in `tools`, so the tool list never changes. The Bot loads its definition with `describe_tool` and calls it with `run_tool`. Routine, Check-in and Helper management tools are deferred, and so are any tools a deploy adds.
_Avoid_: Hidden tool, lazy tool

**Change note**:
A short line in the newest message telling a Bot what changed since its Prompt start was built, such as memory lines added or removed, a Routine created, or a tool changed by a deploy.
_Avoid_: Diff, update, notice

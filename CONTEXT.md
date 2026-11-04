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
A Conversation the user shares with two or more of their Bots, which they name, add Bots to and remove them from, and can delete. A Message goes to the Bots it @mentions, or to the Room's lead Bot when it mentions none; the lead is the first Bot added and only the user changes it. A Bot that mentions another wakes it, and a mention carrying a task is a handoff; a Bot's Message that mentions no one wakes no one. Bot-to-Bot wake-ups stop after three hops until the user speaks again. Every Bot in the Room sees everything said there, each Message marked with who wrote it, but only Messages addressed to it wake it; it keeps its own memory and Skills, and its Routines and Check-ins still land in its 1:1 Conversation. A new Message interrupts only the Bots it goes to; Stop ends every Turn running in the Room. A group chat on another Channel is a Room too.
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
A user's yes or no to one tool call before it runs, to a new Routine, to a Custom Rule a Bot proposes, to a Release a Bot drafted, or to a Published fact a Bot proposes. A Bot asks for one for a tool call only when Auto-review blocks it: the call waits inside its Turn for 15 seconds, then stays pending while the Bot carries on. A later yes runs the call exactly as it was asked and wakes the Bot with its result; a later no wakes it too. A pending Approval expires after 7 days, and deleting a Customer denies one from a Turn wholly on their Assignment. A browser or desktop action on a Screen waits only the 15 seconds, and there silence counts as no. A Release's Approval is answered only on the Representative's page, where the diff is: its card in the Conversation is a link, no Channel offers an answer, and when it expires the draft stays and can still be approved there. A Published fact's Approval is answered only on the Facts page, where the current and proposed values are side by side: its card is a link too, no Channel offers an answer, and when it expires the proposal can no longer change the fact.
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
The Triggers a Conversation has received that no Turn has taken yet, in the order they arrived. A Turn waits a moment before it starts so quick Messages land in one batch, takes everything waiting, and when it ends the next Turn takes whatever has arrived since, so a Conversation runs one Turn at a time. In a Room each Bot has its own queue, so each Bot there runs one Turn at a time, alongside the others and alongside its Turns elsewhere.
_Avoid_: Inbox, backlog, job queue (that is the runner's)

**Routine**:
A prompt one Bot runs on a schedule (days of the week at one or more times, in the user's time zone) or when an inbound webhook arrives. A Bot can create one from its Conversation, but it runs only after the user's Approval. Each run lands in the Bot's Conversation, marked as the Routine's, never as the user's; a run missed while nothing was running happens once, late. A read-only Routine's runs can look but not change anything: a call that would is refused, so the Bot drafts it and asks the user.
_Avoid_: Cron job, schedule, automation

**Morning brief**:
The Routine a Bot proposes when the user's first Connection appears: on weekdays at 8:00 it looks through the user's Connections and the Watch's Notes, tells the user what most needs attention with first steps drafted, and stays quiet when nothing does. It needs the user's Approval like any Routine.
_Avoid_: Daily digest, Summary (that shortens a Conversation)

**Watch**:
The read-only Routine a Bot proposes next to the Morning brief, which checks the user's Connections a few times a day. It messages the user only when something is done, needs a decision or is urgent; anything else waits for the Morning brief as a Note. Pausing it is how the user turns a Bot's proactive checking off.
_Avoid_: Polling, monitor, heartbeat

**Check-in**:
A single moment a Bot sets for itself to wake and check on something, with a note to its future self. It needs no Approval; anything that repeats is a Routine.
_Avoid_: Reminder, Routine (that is a prompt the user approved)

**Helper**:
An agent a Bot hands one complete task to, which works in its own fresh context, keeps going after the Turn that started it, and reports back briefly. It belongs to its Bot and is never a Bot itself. A General Helper works with the shell, files and web search; a Computer-use Helper works a Screen's browser and desktop, needs a model that can use a computer, and a Bot has at most one of those at a time. The user's Stop ends the Turn, not its Helpers; its report wakes the Bot as a Trigger like any other.
_Avoid_: Sub-agent, worker, child agent

**Representative**:
An agent that speaks for one user's business to its Customers and reports to one of that user's Bots, or to the user once that Bot is deleted. A Bot drafts it or the user creates it, and it serves Customers only once the user approves a Release of it. It has no Computer and no Conversation with the user, and it is never a Bot or a Helper.
_Avoid_: Deployed agent, front desk, CSR, Agent

**Release**:
One unchangeable version of a Representative that the user approved: what it's told to do, its tools, its documents and its tests. The user can go back to any earlier Release in one step. Published facts stay outside it and change live.
_Avoid_: Version, deployment, publish

**Document snapshot**:
The documents a Release holds whole in a Representative's prompt, copied as text into the database when the user chooses each one for a draft, then frozen and hashed at approval. It is a published copy: changing a Knowledge file later changes nothing in it, and a Bot goes on working on the files, which stay the source of truth for Bots. A Release's documents hold at most 100,000 characters, and a draft past that can't be approved.
_Avoid_: Knowledge, excerpt, embedding

**Published fact**:
One typed piece of business information a Representative can state, such as a price or opening hours, quoted exactly and never reworded. It has a key (unique to the user), a type (text, money, hours, phone or url, each value checked against it), a topic and optional valid dates, outside which it is not in effect. Every Representative of the user shares them. It changes live, each add, edit and delete goes in a log with the old value, the new value and the time, and a change a Bot proposes, or a Lesson, needs the user's Approval.
_Avoid_: Knowledge, FAQ

**Gap**:
A question a Representative could not confirm from any source, which it logs for the user after telling the Customer plainly that it can't confirm and offering a hand-off. It belongs to the user, records which Representative first logged it, and counts how often the same question (compared without case, spacing or punctuation) comes up. The user dismisses it or turns it into a Published fact, and either closes it: the same question asked again starts a new Gap. The Model wrote its wording, so only the user sees it, as plain text. A test conversation logs none.
_Avoid_: Unanswered question, missing answer, ticket

**Customer thread**:
The one running exchange between a Customer and a Representative across Channels, held either by the Representative or by the user who took it over. It runs one Turn at a time: a message that arrives during a Turn waits for the next one, and quick messages batch into one Turn. While the Representative holds it, it closes when idle, and a later message starts a new one. Taking over aborts the running Turn and sends the Customer one fixed note, and no model call runs until the user hands it back, which is always explicit. A thread the user holds never closes by itself.
_Avoid_: Conversation, ticket, case

**Outbound gate**:
The one set of checks every message to a Customer passes, which decides whether it's sent, held or dropped.
_Avoid_: Filter, guardrail, moderation

**Decision**:
What the Outbound gate logged for one message: sent, held or dropped, with the rule that decided and the Release in effect.
_Avoid_: Verdict, audit entry

**Held message**:
A message the Outbound gate stored rather than sent, which isn't in its thread and hasn't reached the Customer.
_Avoid_: Queued message, pending message

**Limit note**:
The one fixed message a Customer gets when a limit stops a Representative from answering their thread, with no model call: "Our team has your message and will reply". What they said stays owed. Once the limit lifts, what is under 24 hours old gets a Turn and what is older is left for the owner.
_Avoid_: Quota message, drop notice

**Reply draft**:
A Representative's reply the Outbound gate held because its topic isn't one the user lets go out by itself. It waits for the user to approve, edit or reject it, and the Customer gets one fixed holding note meanwhile. A new Customer message replaces it, so what is out of date can't be approved. It isn't a Release's working draft.
_Avoid_: Pending reply, suggestion

**Topic**:
A subject of the user's business that a Representative labels each reply with. Each is `draft` or `auto`, all start at `draft`, and a label the user doesn't have counts as `draft`.
_Avoid_: Category, intent

**Page**:
A direct alert that reaches the user outside the app when something needs them, such as an emergency or a stalled Assignment. It goes to web push and their Linked identities, then to email if nobody has acknowledged it, and acknowledging stops whatever is left.
_Avoid_: Notification, ticket, alert

**Customer**:
A person who deals with a user's business through a Representative. A Customer isn't a user and never signs in to the app, and belongs to that one user's business.
_Avoid_: Contact, end user, client

**Customer memory**:
What a user's business remembers of a Customer, across that user's Representatives and never beyond them: rows in Postgres, written by a pass after a Customer thread closes or by the user, never by a Representative during a Turn. It is not a Bot's Memory, which is files on its Computer.
_Avoid_: CRM

**Customer profile**:
A Customer's typed details, kept in the database: the fixed fields (name, language, preferred Channel, address) plus fields the user defines for all their Customers. Each value has a source, a date and a status: `confirmed` if the user set it or a verified Customer said it, otherwise `claimed`. It's a Bot's **Profile** only in name, which is a file about the user.
_Avoid_: Profile, on its own

**Lesson**:
A Published fact the Customer memory pass proposes after a closed Customer thread, with no identity in it: code refuses a phone or email shape and any known value of the thread's Customer. It reaches the user as an Approval on the Facts page only, with no Bot and no card in a Bot's Conversation, and answering it wakes no one. It never records which Customer or thread it came from. If approved it becomes a Published fact, logged as proposed by the pass.
_Avoid_: Insight

**Customer summary**:
The one summary of a closed Customer thread, part of Customer memory, linked to that thread's transcript. It finds its Customer through its thread, so it follows a Customer merge. Written once. A thread held by the user or waiting on a code hand-off has none, nor does one closed for holding two people's words when a merge was undone, nor one a deleted Customer's messages were taken from. When the pass can't write one, such as for a Release that names no Model, the skip is recorded.
_Avoid_: Summary (a Conversation's), thread summary

**Customer merge**:
Making two Customers one, which happens only when a sender passes a code sent to an identity on the other's record, or when the user does it by hand. The absorbed Customer's identities and threads move to the other, and where both have an open thread with a Representative, the absorbed one's closes. It is recorded, verifies nobody, and the user can undo it: each identity goes back, and a closed thread stays closed. Customer memory doesn't move: the survivor reads both profiles as one, summaries follow their threads, and a hand-off's Customer moves with the merge and back with its undo.
_Avoid_: Link, dedupe

**Verified identity**:
One of a Customer's identities whose sender passed its Channel's rule, within the last 90 days of contact. On a Channel whose rule is a code or a signed link, each pass vouches for its messages for an hour. A lapsed identity verifies again by a fresh enforcing DMARC pass on email, otherwise only by a code to another identity on record. A message whose sender isn't verified gets a prompt holding only what that identity said while unverified: nothing from the Customer's other identities, their memory or the identity's verified past.
_Avoid_: Trusted, authenticated Customer

**Assignment**:
One piece of work handed to a Bot by a Representative or another Bot, with a status and a budget, and a log the user can read. It can be split into child Assignments, which block it while open; a chain stops at 3 deep.
_Avoid_: Tracked task, task, ticket, work order

**Tasks view**:
One Bot's work in one place, in three sections: In progress (the running Turn, its live Helpers and the Assignments handed to it that have not ended), Scheduled (the Conversation queue, Routines and Check-ins) and Done (finished Helpers and Assignments, and fired Check-ins). It is a view over those things, not a thing of its own; "task" stays an ordinary word.
_Avoid_: Task list, to-do, activity feed

**Bot pause**:
The user holding one Bot still until they resume it: its Turn and Helpers stop, nothing wakes it, and what comes due meanwhile (a Routine run, a Check-in, a webhook call) is skipped, not run late. Assignments and answers are the exception: they aren't due at a set time, so open Assignments, results that arrived meanwhile and the user's answers to what the Bot asked wake it on resume. It is not a Routine's own pause, which holds only that Routine, nor a Ban, which the Host puts on a user.
_Avoid_: Suspend, sleep, disable

**Bot reset**:
The user giving one Bot a fresh start: it forgets its own Memory and drops its Routines, Check-ins, Helpers and pending Approvals, and its Conversation gets a reset mark at the end, so the Bot sees nothing from before it while the user can still scroll back. In a Room it leaves no mark for others to see; only that Bot stops seeing what was said there before. It keeps its Skills, its other files, the Assignments still open on it, which wake it afresh, and everything shared with the user's other Bots. It cannot be undone.
_Avoid_: Wipe, delete, clear

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

**Channel account**:
The bot one Bot is on a messaging Channel such as Telegram, Slack or SMS: the user made it on that platform and added it to the Bot. It belongs to that one Bot only, so each Bot is its own contact there.
_Avoid_: Connection (that is an MCP sign-in), integration, bot token

**Linked identity**:
The user's own account on a messaging Channel, such as their Telegram account, their Slack member in one workspace or their phone number, proved by sending a link code to one of their Bots. All the user's Bots know it; a message from any other sender is dropped unanswered.
_Avoid_: Account link, alias, handle

**SendToUser**:
The one tool a Bot talks to the user with. A Message it sends is text plus at most one Rich control. The text is what every Channel can always show. A Bot can mark a Message urgent, which decides where it is delivered and lets it through Quiet hours. A Bot that sends nothing stays quiet, and its own model text is never shown.
_Avoid_: Reply, respond, notify

**Quiet hours**:
The hours, set by the user for all their Bots, when a Message from a Turn they didn't start is not emailed or pushed unless it is urgent. The Message is still in the Conversation for when they next look.
_Avoid_: Do not disturb, mute

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

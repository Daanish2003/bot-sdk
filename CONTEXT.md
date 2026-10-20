# ai-chat

A personal ChatGPT-style chat app: signed-in users talk to LLMs and keep their history, and have always-on Bots that work for them.

## Language

**Bot SDK**:
The one reusable SDK a Host embeds: Conversations at its core, and every feature (the assistant, Bots, Memory, Knowledge, the Computer, Channels) a plugin the Host turns on. It knows users only by id.
_Avoid_: Chat SDK, agent SDK, library, chat module

**Host**:
An app that embeds the Bot SDK and supplies its users, its routes and a Postgres database. The web app in this repo is one Host.
_Avoid_: Consumer, client app, integrator

**Conversation**:
One chat thread a single user owns, with either the assistant or one of their Bots. An assistant Conversation is listed in the sidebar; a user can pin it to the top of the sidebar, or archive it to take it out of the sidebar without deleting it; it is never both. An archived Conversation still shows in search, and sending it a Message unarchives it. A Bot has exactly one Conversation with the user: it only ever grows at the end, so it has no Branches, and pinning or archiving it pins or archives the Bot.
_Avoid_: Chat, thread, session, hidden (for archived)

**Project**:
A named group of a user's Conversations that share context: instructions, a default Model, Knowledge and their own Memories. A Conversation is in at most one Project; deleting the Project deletes its Conversations.
_Avoid_: Folder, workspace, collection

**Instructions**:
Text a user or Project gives the assistant to shape every reply. A user's apply to all their assistant Conversations, a Project's only to its Conversations, and both apply together. A Bot has none: it keeps preferences in its memory and turns instructions into Skills.
_Avoid_: System prompt, custom instructions, persona

**Saved prompt**:
Text a user saves under a short name and inserts into the composer with `/name`, to edit and send as a Message. Unlike Instructions, it applies only when inserted. Only this is called a prompt; a Message never is.
_Avoid_: Template, snippet, command, macro

**Message**:
One entry in a Conversation, written by the user, the assistant or a Bot. A Bot's own model text is never a Message; only what it sends is.
_Avoid_: Reply, prompt

**Rating**:
A user's thumbs up or down on one assistant Message whose Run has ended, or on a Bot's Message whose Turn has ended, which they can change or clear. It stays with that Message (regenerating leaves it on the old reply), is never sent to the Provider or shown on a Shared link, and an Admin sees only totals, never the rated Message.
_Avoid_: Feedback, vote, reaction, like

**Hidden reply**:
An assistant Message whose text the Host's moderation removed after its Run ended; everyone, on a Shared link too, sees only that it was hidden. It can't be rated, copied or exported, and it is never sent to the Model again; regenerating it makes a new reply as usual. Its Run's spend still counts against the Quota.
_Avoid_: Moderated message, flagged message, censored reply

**Run**:
The generation of one assistant Message, from the moment it's sent until it ends `complete`, `stopped`, `error` or waiting for an Approval. It goes on without a reader, and anyone can join it while it's live. A Run is the assistant's; a Bot works in Turns.
_Avoid_: Job, generation, stream, Turn

**Branch**:
One path through an assistant Conversation's tree of Messages, created when a Message is edited or regenerated.
_Avoid_: Fork, version, variant

**Active Branch**:
The one Branch of a Conversation that is currently shown and that the next Message continues. Switching to a sibling makes its newest Branch active.
_Avoid_: Current branch, selected path

**Provider**:
An LLM vendor a user can chat through, one per TanStack AI chat adapter (Anthropic, OpenAI, Gemini, OpenRouter, Ollama, …).
_Avoid_: Vendor, backend

**Model**:
One specific LLM offered by a Provider. A Conversation has a selected Model, and each assistant Message records the Model that wrote it.
_Avoid_: Engine, LLM (as a noun for one choice)

**Provider credentials**:
What one user supplies to reach one Provider: usually an API key, sometimes with an account or region, or just a host for a local Provider. For OpenAI it can instead be a linked ChatGPT plan, made by signing in to ChatGPT, which reaches only the Models the plan offers and is used only when the user has no OpenAI API key. When a user has them for a Provider, their runs on it always use them and never count against their Quota.
_Avoid_: Provider key, API key (ambiguous), token, BYOK key, ChatGPT Connection

**Host credentials**:
Provider or Tool credentials the Host supplies for all its users, with the Models it offers on them. Runs on them count against the user's Quota.
_Avoid_: Server key, free tier key, platform key

**Quota**:
How much a user may spend on Host credentials per window (a day or a month), set by the Host per user. It is measured in money, and unlimited when the Host sets none. A Bot's Turns and Helpers spend from it the same way a Run does. It is checked before a Run or Turn and before each paid tool call (a web search, a Generated image) or transcription of a voice recording, never by cutting a reply off.
_Avoid_: Limit, allowance, credits, free tier

**Admin**:
A user of the Host who runs it for everyone else: sees each user's spend, changes a user's Quota, Bans and unbans users, and turns off a user's two-factor sign-in when they have lost every way to pass it. An Admin never reads another user's Conversations.
_Avoid_: Operator (that is the person; Admin is the role), superuser, moderator

**Ban**:
An Admin shutting a user out, for good or until a set date: the user is signed out everywhere, can't sign in by any method, their running replies, Turns and Helpers stop, no Routine or Check-in of theirs fires, and their Shared links stop showing until the Ban ends.
_Avoid_: Suspension, block, disable

**Tool credential**:
A user's own API key for a non-LLM service a tool needs, such as web search. Without it, that tool is unavailable to the user.
_Avoid_: Search key, Provider credentials (those are for Providers only)

**Connection**:
A user's authorisation to use an outside service the Host offers, made by signing in to it: one of its MCP servers, or GitHub. In an assistant Conversation the user switches each MCP Connection on per Conversation. Signing in to a site in a Screen's Chrome is not a Connection. A GitHub Connection is always on and lets Synced sources read the private repositories the user chose.
_Avoid_: Integration, connector, MCP credential, Tool credential (that is an API key)

**Approval**:
A user's yes or no to one tool call before it runs, or to a new Routine. While a call waits for it, the Run has ended; approving starts a new Run that carries on from the call. A Bot asks for one only when Auto-review blocks a call, and silence counts as no.
_Avoid_: Confirmation, consent, permission

**Source**:
A web page a web search returned, or a page the `fetch_url` tool read, during an assistant Message, numbered within that Message and shown as a chip under the search or fetch and wherever the reply cites it.
_Avoid_: Citation (that is the chip in the text pointing at a Source), result, reference

**Shared link**:
A public, read-only snapshot of a Conversation's Active Branch (a Bot's whole Conversation) taken at the moment it is shared. A Conversation has at most one; sharing again moves it to the current Active Branch, or a Bot's Conversation so far, under the same link. It disappears when its Conversation is deleted, and stops showing while its owner is under a Ban.
_Avoid_: Share, public chat, permalink

**Attachment**:
A file (image, PDF or text file) a user uploads and attaches to their Message. It is never copied: editing a Message carries its Attachments over to the new Branch, where the user can remove some or add more; regenerating a reply leaves them as they were. A Shared link shows only each Attachment's file name and type.
_Avoid_: Upload, file part, document

**Generated image**:
An image the assistant made with the user's Image Model during an assistant Message, shown in the reply. It belongs to that Message: regenerating the reply makes new ones and leaves the old reply's as they were. It can be made from earlier Generated images or image Attachments on the same Branch (an edit), never by changing them. Unlike an Attachment, the user didn't upload it, and a Shared link shows it in full.
_Avoid_: Image attachment, picture, output image

**Artifact**:
A standalone piece of content the assistant creates in a Conversation and then revises (code, an HTML page, a document, a diagram), opened beside the chat with a preview. Each change makes a numbered version, which belongs to the assistant Message that wrote it, so a Branch shows only the versions on its path.
_Avoid_: Canvas, code block, file, document, revision

**Knowledge**:
The material a Project gives the assistant to look things up in while replying in its Conversations: its Knowledge files and Synced sources. The files a Bot keeps on the Computer are not Knowledge.
_Avoid_: Knowledge base, RAG, documents, library

**Knowledge file**:
A file a user adds to a Project's Knowledge, which the assistant searches by meaning. It is not an Attachment: it belongs to the Project, not to a Message.
_Avoid_: Document, upload, attachment

**Synced source**:
An outside collection of text files, such as a GitHub repository, kept in step with a Project's Knowledge and read by the assistant file by file.
_Avoid_: Connector, repo, integration, Source (that is a web page)

**Excerpt**:
A passage of Knowledge the assistant read during an assistant Message, shown as a chip wherever the reply cites it. Excerpts are numbered together with the Message's Sources. An Excerpt stays with the reply even after its Knowledge file is deleted, and a Shared link shows only its file name.
_Avoid_: Source (that is a web page), chunk, snippet, Knowledge source

**Memory**:
One fact about a user that the assistant learned in a Conversation and reuses in later ones. Memories made in a Project stay in that Project, which also uses the general ones; the rest are general. Each remembers the Message it came from and goes when that Conversation is deleted. One the user corrects is kept as outdated; one they delete or ask the assistant to forget is gone. A user can turn Memory off. A user's Bots share the facts about them, and each Bot writes its own; the Bots' Memory build step replaces these rules with the lecture's tiers.
_Avoid_: Fact, profile, saved memory, Instructions (those the user writes)

**Temporary Conversation**:
A Conversation the user makes temporary before its first Message, which it stays. It is in no Project, neither uses nor makes Memories, isn't searched by the assistant, has no title, stays out of the sidebar and search, can't be shared, and is deleted 30 days after its last Message.
_Avoid_: Incognito chat, private chat

**Background Model**:
The cheap Model a user picks for work done around their Messages rather than in them: titles and making Memories. When they pick none, the Host's default is used; with neither, titles use the Model that wrote the reply and no Memories are made.
_Avoid_: Title Model, Memory Model, utility model

**Image Model**:
The Model a user picks for Generated images, independent of the Model they chat with. When they pick none, the Host's default is used; with no default, the assistant can't make images.
_Avoid_: Image generator, image Provider

**Bot**:
An always-on agent a user has: it runs on the server, wakes on Triggers, keeps its memory and Skills, and talks to the user only through the Messages it sends. It has one Conversation with the user and can work across others, such as group chats later. A user can have many Bots; they share the facts about the user and one Computer.
_Avoid_: Agent, assistant (that answers in assistant Conversations), persona

**Turn**:
One Bot working through a batch of what woke it, until it stops. It works on one batch at a time. In a 1:1 Conversation the user skips the line: a new Message interrupts the running Turn, which ends where it is and is followed by a new Turn that takes the Message with the first one's work in view; Stop ends it with nothing following until the user's next Message. What an interrupted or stopped Turn already sent stays sent. It can send any number of Messages, or none.
Staying quiet means replying with no text; plain text the Bot writes never reaches the user, so the first time a Step ends in plain text the Turn takes one more Step with a note saying it was not delivered, unless no Step is left, when the Turn ends quiet.
_Avoid_: Run (that is the assistant's), step, session

**Step**:
One model call within a Turn and the tools it calls. A Turn is one or more Steps; it ends when a Step calls no tool, or when a Message the Bot sends says it is the last.
_Avoid_: Turn, iteration

**Checkpoint**:
The saved result of one piece of a Turn's or a background job's work. A Turn saves a Checkpoint after each Step's model call and after each tool call, so a Message it sends is sent once even across a crash; work resumed after a crash or a deploy starts after its last Checkpoint instead of from the beginning.
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
_Avoid_: Cron job, schedule, automation, Saved prompt (that the user inserts)

**Check-in**:
A single moment a Bot sets for itself to wake and check on something, with a note to its future self. It needs no Approval; anything that repeats is a Routine.
_Avoid_: Reminder, Routine (that is a prompt the user approved)

**Helper**:
An agent a Bot hands one complete task to, which works in its own fresh context, keeps going after the Turn that started it, and reports back briefly. It belongs to its Bot and is never a Bot itself. A General Helper works with the shell, files and web search; a Computer-use Helper works a Screen's browser and desktop, and a Bot has at most one of those at a time. The user's Stop ends the Turn, not its Helpers; its report wakes the Bot as a Trigger like any other.
_Avoid_: Sub-agent, worker, child agent

**Skill**:
Written instructions for one kind of task, starting with when to use them, that a Bot reads only when it needs them. A Bot can save one from watching the user do the task on its Computer.
_Avoid_: Plugin, prompt, Instructions (those apply to every reply)

**Computer**:
The one cloud machine a user's Bots share, with its files, installed tools and browser sign-ins, asleep whenever nothing needs it.
_Avoid_: Sandbox, VM, machine, desktop

**Screen**:
One display on the Computer, with its own Chrome and profile, for one active Bot. It is open only while that Bot's Computer-use Helper works on it, at most four at once per Computer; its Chrome sign-ins stay on the Computer and are lost if it is rebuilt.
_Avoid_: Display, desktop, browser

**Auto-review**:
A separate model's check of a Bot's risky tool call before it runs. A call it passes runs without asking; one it blocks waits for an Approval.
_Avoid_: Guardrail, moderation, safety check

**Channel**:
Anything that sends to a Bot or shows what it sends: the user's apps (web, desktop, mobile), Slack, email, webhooks, schedules or phone calls. Every app the user opens shows the same Conversation.
_Avoid_: App, surface, client, platform

**Summary**:
A short account of a Conversation's older Messages that a Bot works from in their place. The Bot's last few Messages to the user stay word for word.
_Avoid_: Compaction, recap, digest

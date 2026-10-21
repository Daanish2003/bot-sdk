# What the lecture says about Knowledge

Research for [Research: What the lecture says about Knowledge](https://github.com/Daanish2003/bot-sdk/issues/728) (child of map [Wayfinder: Bot step 11, Knowledge](https://github.com/Daanish2003/bot-sdk/issues/422)). Researched 2026-10-22.

## Question

What exactly does the lecture say about Knowledge: files, documents, "write down what they know", per agent or shared, who writes it, and how the agent finds it? Where is it silent, so later tickets invent nothing the lecture already settles?

## Sources

| Ref | Source                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T   | The transcript, `transcript-L1OBRtfPS34.pdf` (YouTube transcript of "How always-on agents work", Lee Robinson, Stanford CS146S; 31 pages, 0:00–45:13, no Q&A). Local to the owner's machine, not committed. Cited as `[mm:ss]`, the video offset printed in the PDF. |
| S   | The slide write-up, first comment on [Wayfinder: Always-on agent build order](https://github.com/Daanish2003/ai-chat/issues/383). Cited as "slide N". Slide text marked [obscured] there is hidden by the speaker inset; completions in brackets are inferences.     |

Every slide/transcript pair below was matched by reading the transcript in full; the transcript has no slide numbers, so the mapping is by content.

## Short answer

The lecture has **no separate "Knowledge" component**. Its word for it is a principle: _what the agent knows lives in plain files on its computer_, which the agent reads and searches with Linux shell commands. That principle covers memory, skills and routines (slides 10–11, 35). The only place "knowledge" reaches beyond the agent's own memory and skills is a **prediction** on slide 40: people and companies will write down how their processes work so agents can use them. The lecture never draws a `knowledge/` folder, never names a Knowledge tool, and never says how such documents get onto the computer.

## What the lecture says

### 1. Knowledge is kept in files (slide 10, item 5)

- Slide 10: "Keep knowledge in files: skills and memories are stored as plain files that the agent reads and updates itself."
- T [8:09]–[8:18]: "you can store all of the information in files and the reason you can do that is because it's actually very easy for the models then to recall and search this information".

Note the scope: on the slide, "knowledge" means **skills and memories**, not uploaded documents.

### 2. The file layout and why files (slide 11, "What the agent knows lives in files")

- The "Simplified example" tree has three top-level folders only: `memory/` (`profile.md`, `log/2026-10.md`), `skills/<name>/SKILL.md`, `routines/<name>`. There is **no knowledge or documents folder**.
- Bullets: "Models are extremely good at using Linux and running shell commands." "Plain text, so you and the agent can both read, search and edit it." "The agent keeps it up to date: tell it a preference once and it saves it to memory." "Skills load only when needed, so having many of them is cheap." Quote: "Everything is computer".
- T [8:53]–[9:17]: the working log is "all being put into files that the model can then decide to search or use later. If you say, 'Hey, what did I do last week?' It just can can go and look that up. And the models are very good at using Linux commands, running shell commands to go grap [grep] and search and look through these files."
- T [9:20]–[9:26], on skills: "you are essentially taking your knowledge of how to do a specific task and encoding it into a markdown file."
- T [9:34]–[9:43]: skills are also written by others: "a whole ecosystem now of companies and developers um writing these skills".
- T [10:01]: "So basically everything is computer".

### 3. How the agent finds things: shell over files, read on demand

- Grep and shell search, above (T [9:11]–[9:17]).
- T [34:14]–[34:25], at the end of the memory tiers: "And everything else can be found through files. This is the magic of files of the models being good at running commands is like they can always just go look stuff up and they're actually very good at doing that."
- Slide 35 labels the same tier differently: "Everything else (dashed): found with a memory search tool when needed." The slide says a _memory search tool_; the speaker says _files and commands_. The lecture doesn't reconcile the two, and it applies only to memory.
- T [21:16]–[21:21], on tool details loaded on demand: "I can go read the information from a file. It's kind of files and a file system all the way down for all of these things."
- Slide 32 and T [29:08]–[29:20]: long outputs go to a file and the context keeps the path; "the agents are very good at reading files ... which is just like reading a skill or reading a memory".
- Slide 25, cheapest-first ladder, step 1 "What it already knows". T [21:39]–[21:46] defines it as "what the agent or what the bot already knows based on the conversation history", not as a document store.

Nothing about knowledge is placed in the prompt. The prompt carries only the profile, the top log entries (slide 35) and "a snapshot of memory and routines" (slide 31); skills get "a one-line pointer" (slide 32).

### 4. "Knowledge written down" (slide 40)

- Slide 40, last card: "Knowledge written dow[n]: people and companies write down what they k[now] so agents can use it" (partly obscured).
- T [40:08]–[40:20]: "people and companies um are going to get much better I think about uh writing down how all of these kind of bespoke processes work so that they're legible for agents to use."
- The card just before it, T [39:53]–[40:01]: models will get good at "learning skills on the job and then encoding that into files in instructions skills".
- On memory representation, T [39:11]–[39:19]: "Plenty of different approaches in research here for the type of algorithms used or the representation of the data under the hood. Maybe it's a graph, maybe it's files, maybe something else." So the lecture presents files as its choice, but names representation as open research.

Slide 40 is framed as "What I expect in 6 to 12 months", not as part of the architecture. Its writers are **people and companies**, and what they write is **how their processes work** (closer to skills and instructions than to reference documents).

### 5. Who writes the files

- **The user and the agent both:** "you and the agent can both read, search and edit it" (slide 11).
- **The agent:** keeps memory up to date (slide 11); after each turn a pass adds and replaces facts (slide 35); learns by watching and saves the steps as a skill (slide 10, item 6; T [8:18]–[8:28]).
- **Third parties:** companies and developers publish skills; plugins bundle skills or servers (T [9:34]–[9:53]).
- **People and companies, in future:** write down their processes for agents (slide 40).

### 6. Per agent or shared

- Said for **memory only** (slide 35): "Facts about you are shared by all your agents. Each agent writes to its own file."
- The computer: "A Firecracker virtual machine · one per user" with "one more screen per active agent" (slide 15). T [13:02]–[13:13]: "if you're running five bots, 10 bots ... let them have different screens. And all of this again is kind of shared infrastructure between these bots".
- Open problem (slide 41): "Coordination: many agents sharing one computer and one memory run into classic distributed-systems problems."

So files on the computer are on a machine that all of a user's bots share, but the lecture never states whether any knowledge file is per-bot or shared.

### 7. Where the files persist

- Slide 15: "Files, installed tools, and browser logins all stay between sessions"; going to sleep, "Files sync to cloud storage."
- Slide 13: saved state is "Database and storage: conversations, memory, routines, skills". T [11:06]–[11:11]: "a database the the conversation logs the memories the routines all of that."
- Slide 18 and T [15:04]–[15:10]: "you want to save everything on the server ... so you can always kind of rebuild that virtual machine."

The saved-state lists never mention knowledge or documents, only general "files" syncing to cloud storage.

### 8. Trust

- Slide 29: "text from emails and webhooks is labelled untrusted. Memories are treated as information, not instructions." Slide 35 repeats the memory rule. Nothing is said about documents a user or company puts on the computer.

## What the lecture decides

1. Knowledge lives in **plain files** (plain text, markdown) on the agent's computer, not in a database index. (Slides 10, 11.)
2. The agent finds things with **Linux shell commands** (grep, search, read) and reads files **on demand**; nothing is preloaded beyond memory snapshots and skill pointers. (T [9:11], [34:14]; slides 31, 32.)
3. Files are **editable by both the user and the agent**. (Slide 11.)
4. The files **persist** between sessions by syncing to cloud storage; the VM can be rebuilt. (Slides 15, 18.)
5. In the lecture's own words, "knowledge" is **skills and memories**, plus a forecast that people and companies will **write down their processes** for agents. (Slides 10, 40.)

## Where the lecture is silent

- **A Knowledge component at all.** No `knowledge/` folder, no "Knowledge" tool, no Knowledge tier, no word for user-provided reference documents.
- **How documents get onto the computer:** upload, attach, drag in, sync from a service. The nearest is that the user can open a live view and control the machine (T [12:36]–[12:44]; slide 15 "File server: files, app connections, live desktop view") and that SendToUser can carry files (slide 22).
- **File formats beyond plain text and markdown:** PDFs, Word, spreadsheets, images; conversion to text.
- **Per-bot versus shared** for documents (only memory is settled: shared facts, own file per agent).
- **Teams or organizations** sharing knowledge between users; slide 40's "companies" is a forecast with no mechanism.
- **Path, naming and folder conventions** for documents.
- **Size limits, counts, quotas.**
- **Search beyond the shell:** embeddings, hybrid search, an index. The lecture never mentions them; slide 35 names a "memory search tool" without saying how it works, and representation is called open research (T [39:11]).
- **Whether the agent should cite** the file it answered from.
- **Trust labelling** of documents (only email, webhooks and memories are covered).
- **Whether a bot's own outputs** (reports, long outputs written to files, slide 32) count as knowledge for other bots.
- **Synced sources** (repositories, drives) as knowledge; connectors appear only as tools (slide 25, step 2).
- **Versioning, deletion and "forgetting"** of documents (slide 41 lists forgetting as an open problem for memory only).
- **Evals** for answering from files.

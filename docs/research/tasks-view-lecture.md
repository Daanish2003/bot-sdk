# Does the lecture cover a task list, pause or reset?

Research for [#1001](https://github.com/Daanish2003/bot-sdk/issues/1001) (child of the map [Wayfinder: Tasks view and whole-Bot pause/reset](https://github.com/Daanish2003/bot-sdk/issues/974)). Researched on 2026-10-29.

**Question.** Does the lecture describe a per-Bot list of work (in progress, scheduled, done), cancelling or editing queued work, pausing a single Turn or Helper, pausing a whole Bot, or resetting a Bot? If so, how, and does anything it says conflict with the decisions on the map?

## Sources

| Ref | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S   | The slide write-up of "How always-on agents work" (Lee Robinson, Stanford CS146S, 2026-10-08), the first comment on [#383](https://github.com/Daanish2003/ai-chat/issues/383). Cited as "slide N". Text in [brackets] was hidden by the speaker inset; the write-up marks those completions as inferences.                                                                                                                                                                    |
| T   | The YouTube transcript, `transcript-L1OBRtfPS34.pdf` (0:00–45:13, no Q&A), on the owner's machine and not committed (as in the archived [#728 research](https://github.com/Daanish2003/bot-sdk/blob/archive/research/728-lecture-knowledge/docs/research/lecture-on-knowledge.md)). Cited as `[mm:ss]`. I searched it for pause, reset, cancel, stop, edit, queue, to-do, list, schedule, routine, delete, forget, clear, interrupt and remove, and read each hit in context. |

The repo's lessons in `docs/learning/lessons/` quote the lecture but are not a primary source; I used them only to find slides.

## Short answer

| Topic                                                 | Does the lecture cover it?                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per-Bot list of work (in progress / scheduled / done) | **Partly.** Only a helper-level "to-do list" that the main agent keeps (slide 27). No user-facing list, no In progress / Scheduled / Done split.             |
| Cancelling or editing queued work                     | **Silent.** The only way to change work the lecture shows is steering: send another message, which in a 1:1 chat interrupts the running turn (slides 7, 20). |
| Pausing a single Turn or Helper                       | **Stop, not pause.** A Stop button stops the turn (slide 20); "Stop all help[ers]" (slide 27). Nothing pauses and resumes.                                   |
| Pausing a whole Bot                                   | **Silent.** Idling is automatic ("When nothing is happening, nothing runs", slide 13), not a user control.                                                   |
| Resetting a Bot                                       | **Silent.** The lecture assumes the opposite: an agent "works for months with the same memory" (slide 3).                                                    |

No map decision conflicts with the lecture. Three notes below (the 1:1 interrupt rule, Routine edits and the OK, and shared memory and computer) are things the spec should respect.

## What the lecture says

### 1. A list of work: the to-do list (slide 27)

- Slide 27, "One main agent, many helpers", bottom row: "A to-do list tracks every request"; "Check on a helper"; "Send a helper a message"; "Stop all help[ers]" (last word partly obscured).
- T [24:52]–[25:05]: "And then the main agent, it is kind of like a co-orker where it's managing a to-do list. You have a few things you can do. You can go check on it. You can send it a message, you know, you can stop the helpers, for example. Um, and so a lot of this is modeled after the ideal way you would scale, you know, a team of engineers".
- T [24:38]–[24:52]: each helper "is its own durable workflow", so a crashed helper "can restart and keep going without losing progress".

The list belongs to the **main agent** and covers helper work ("every request" handed off). The transcript's "You have a few things you can do" is ambiguous between the main agent and the user; the slide lists them as capabilities of the main-agent design. The lecture never shows this list in the app, never splits it into in progress, scheduled and done, and never puts routines, check-ins or queued messages in it.

**Scheduled work** appears only as wake sources: "A routine: schedule or webhook" and "A scheduled check-in" (slide 14), "Routine at 8:00" (slide 13), `routines/morning-brief  prompt + weekdays 8:00` (slide 11), and routines as "running some prompt basically on some kind of schedule" like cron (T [9:53]–[10:01]). No slide lists them for the user.

The queue itself is drawn, not listed: on slide 20 it runs "Back of the line" to "Front of the line →" and holds "Helper finished", "Slack reply", "3 quick messages → 1 turn" and "Routine: weekly report". It is an architecture diagram, not a UI.

**Done work** is not listed anywhere. Finished helpers return "a short report" to the main agent (slide 27), and "Background work finishing" is a wake source (slide 14).

One open problem bears on why a view could help: "When to speak: too many messages is noise; too few and you can't tell what it's doing" (slide 41; T [41:12]–[41:18], "the heristics around when the agent is silent or when it kind of bugs you, uh I don't think that we have it perfect"). The lecture offers no fix.

### 2. Cancelling or editing queued work: silent, steering instead

- No slide or transcript passage cancels or edits a queued message, routine run or check-in.
- What the lecture offers instead is **steering**. Slide 7, "From approving every step to steering": "Now: the agent keeps working, and you redirect it", with messages like "Actually, make it Thursday". T [4:31]–[4:53]: "instead of kind of queuing commands, you can steer the agent ... actually go do that on Thursday ... now they kind of understand ... that these two things are related."
- Slide 20, "Rules for handling new messages": **you, in a 1:1 chat**, "Skips the line" and "interrupts or stops the turn"; **everyone else** (group chats, Slack threads, routines, helpers) joins the back of the line, and "3 quick messages → 1 turn". T [17:36]–[18:06]: "if I say oh actually you know change the date for this event, we actually want that agent loop to stop and my message is going to have priority over everything else ... for everybody else, you're kind of putting things into the queue in the back of the line ... it's able to kind of batch those together. So, it's just one turn. You can kind of figure out whatever heristic you want there."
- Routines are created from chat ("Created Sales Outbound routine", slide 8) and "New routines need your OK" (slide 29). Nothing about pausing, editing or deleting one.

### 3. Pausing a single Turn or Helper: stop only

- Turn: slide 20 shows a black "■ Stop" button next to the user's message, with the arrow labelled "interrupts or stops the turn". T [17:39]–[17:45]: "we actually want that agent loop to stop".
- Helper: "Stop all help[ers]" (slide 27) and "you can stop the helpers" (T [25:03]). The lecture shows no per-helper stop, though "Check on a helper" and "Send a helper a message" are per-helper.
- The word "pause" never appears in the transcript. Nothing in the lecture suspends a turn or helper and resumes it later. The closest is a computer-use helper that, at "logins, verification codes, captchas or payments, it stops, explains where it is, and hand[s] you the screen" (slide 26), which is a hand-off, not a pause.

### 4. Pausing a whole Bot: silent

- The lecture's only idle states are automatic. "Agent process, runs a turn, then stops", "stops after 2 idle minutes"; "Agent's computer, sleeps when idle" (slide 13). "Going to sleep: a few minutes after the last activity, never mid-turn" (slide 15). "When nothing is happening, nothing runs. Everything that matters is saved, so any trigger can bring it back" (slide 13).
- No user control turns a bot off or stops triggers from waking it. Bans, blocks or disabling a bot are never mentioned.

### 5. Resetting a Bot: silent

- No slide or passage resets, wipes or starts a bot over. "reset", "wipe" and "start over" never appear in the transcript.
- The lecture's premise points the other way: an always-on agent "works for months with the same memory, across many conversations" (slide 3), and "Save everything on the server. The virtual machine can then always be rebuilt" (slide 18).
- Related facts the reset ticket should know:
  - Memory is split by owner: "Facts about you are shared by all your agents. Each agent writes to its own file" (slide 35).
  - The post-turn memory pass "can only remove facts it was shown" (slide 35).
  - "Correct memory: replacing outdated facts, forgetting when asked, and never making things up" is listed as an **open problem** (slide 41), not a solved feature.
  - The computer is "A Firecracker virtual machine · one per user" with "one more screen per active agent" (slide 15); T [13:02]–[13:13]: "if you're running five bots, 10 bots ... all of this again is kind of shared infrastructure between these bots".

## Against the map's decisions

| Map decision (#974)                                                                                                                                               | Lecture                                                                                                 | Verdict                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No Task entity; the Tasks view is a view over existing things                                                                                                     | The to-do list is the main agent's, over helper requests (slide 27). No user task list, no task object. | No conflict. The lecture's to-do list is a tracking idea, not a stored entity.                                                                                                                                                                                                                                           |
| In progress = running Turn + running or waiting Helpers; Scheduled = Conversation queue, Routines, pending Check-ins; Done = finished Helpers and fired Check-ins | Silent on any such split.                                                                               | No conflict; beyond the lecture.                                                                                                                                                                                                                                                                                         |
| Stop for Turn and Helper                                                                                                                                          | Stop for a turn (slide 20); "Stop all help[ers]" (slide 27).                                            | Matches. A per-Helper Stop goes slightly beyond "stop all", but nothing forbids it.                                                                                                                                                                                                                                      |
| Cancel and Edit for queued user Messages                                                                                                                          | Silent. Steering by a new message is the lecture's way to change course (slides 7, 20).                 | No conflict. **Note:** under slide 20 a user's message in their own 1:1 chat skips the line and interrupts the running turn, so it never waits behind a turn; only a quick burst being batched ("3 quick messages → 1 turn") is briefly queued. Cancel and Edit must not change that rule.                               |
| Pause, Resume, Delete and Edit for Routines                                                                                                                       | Silent on all four; "New routines need your OK" (slide 29).                                             | No conflict. **Note:** the lecture asks for the OK only on _new_ routines; whether a user's own Edit needs the OK again is beyond it.                                                                                                                                                                                    |
| Cancel and Edit for Check-ins                                                                                                                                     | Check-ins appear only as a wake source (slide 14).                                                      | No conflict; beyond the lecture.                                                                                                                                                                                                                                                                                         |
| Whole-Bot pause works like a per-Bot Ban                                                                                                                          | Silent; idle is automatic (slides 13, 15).                                                              | No conflict; beyond the lecture.                                                                                                                                                                                                                                                                                         |
| Reset's data deletion is the owner's call                                                                                                                         | Silent.                                                                                                 | No conflict. **Note** for that ticket: facts about the user are shared by all their agents while each agent writes its own file (slide 35), and the computer is one per user shared by all their bots (slide 15). A per-Bot reset that wipes the shared profile or the whole computer would touch the user's other Bots. |
| UI: the Tasks view replaces the To-do popover and the Routines · Check-ins popover                                                                                | The lecture shows no app UI for either.                                                                 | No conflict. The main agent's own to-do list (what the Bot sees about its Helpers) is separate from the user's view and should survive.                                                                                                                                                                                  |

## Where the lecture is silent

A user-facing task list or its grouping; showing done work; cancelling or editing any queued item; pausing and resuming a turn or helper; stopping one helper; pausing, resuming, editing or deleting a routine; cancelling or editing a check-in; pausing, disabling or banning a whole bot; resetting a bot or deleting its data; and evals for any of these.

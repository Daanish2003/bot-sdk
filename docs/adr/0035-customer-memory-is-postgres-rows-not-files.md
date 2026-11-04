---
Status: accepted
---

# Customer memory is Postgres rows, not files

Decided in [Customer memory: fields, expiry and deletion](https://github.com/Daanish2003/bot-sdk/issues/1158), and approved in [spec #1170](https://github.com/Daanish2003/bot-sdk/issues/1170).

A Representative's memory of a Customer lives in Postgres rows in the Representative feature. A Representative has no Computer to keep files on. Customer memory has to be read only for the Customer a Turn serves, corrected by the owner and really deleted, and rows with a known owner and Customer can do that. ADR 0022 stays as it is: it's about a Bot's memory, which is files on its Computer.

- **Three layers.** A typed profile, summaries that expire and link to transcripts, and live reads that are never copied.
- **One writer.** Only a pass writes it, as a job after a Customer thread closes. It sees numbered lines and returns what to write, and code stores it, following ADR 0022's Memory pass. A Representative has no memory tool, so an injected instruction in a Turn can't rewrite a Customer's memory.
- **A summary per closed thread.** A thread closes by going idle or through a Customer merge, and both come to one seam that queues the pass. The row is unique per thread, so a retry can't write a second one and a Bot's result arriving after close can't rewrite it. A thread the owner held when a merge closed it gets none, because undoing the merge reopens it held. Nor does a thread closed by undoing a merge for holding two people's words, which would put one person's words in the other's memory. A summary finds its Customer through its thread, so it follows a merge.
- **Through a Customer merge.** A merge moves no profile value. The survivor reads its own and the absorbed Customer's as a union, `confirmed` beating `claimed`, then the newest, so undoing it gives each Customer its own values with nothing to restore. The owner corrects only the survivor's own: clearing a value there keeps an empty row, which hides what the merge brought and reads as nothing, so what was cleared doesn't show through and stays cleared after an undo. A pass writes each value where undoing would leave it: to the Customer the cited line's sender came from, otherwise the one the thread came from, not the survivor. No pass beats a confirmed value of the owner's that the survivor reads, and a claim can't overwrite what the owner cleared on a survivor. A summary stays with its thread, so a thread both people spoke on during a merge keeps its summary on the thread's Customer after an undo, for the owner to read, and a Turn leaves it out for holding an address that isn't that Customer's.
- **The pass's Model.** It runs on the Release's Model, with no Bot, and its spend is recorded under its own usage kind, `customer_memory`. If the Release names no Model, no Model is called, and the skip is recorded as a row with no text, as it is when the Model can't run or every try fails. It holds no transaction across its Model call.

## Considered Options

- **Files, as a Bot's memory is.** A Representative has no Computer, and a file can't guarantee that a delete reached every copy.
- **A Representative writing memory during a Turn.** Anything a Customer says could then instruct it to write.

## Consequences

- **A limit on deletion.** The pass's Model reply is saved in its job's Checkpoint so that a retry doesn't call the Model again, and Model calls recorded in job Checkpoints last 7 days after success and 30 after failure. Deleting a Customer doesn't reach them. That's accepted because the lab is never deployed, and a real deployment would have to revisit it. The pass's own Checkpoints hold only its reply, not the lines it was shown, though a reply can repeat what they said.
- The pass costs one Model call per closed thread, against the owner's Quota when it's on Host credentials.
- A closed thread with a Release that names no Model has no summary, even though the Release's Turns run on the Host's default Model.

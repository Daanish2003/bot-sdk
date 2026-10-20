# TanStack `needsApproval` and `resume` inside the durable Turn and Helper loops

Research for issue #681 (child of the map #420, Bot step 9, Safety). Researched on 2026-10-21.

How to read the sources:

- **Core.** `@tanstack/ai` 0.66.0, the installed copy at `node_modules/.pnpm/@tanstack+ai@0.66.0_zod@4.6.5/node_modules/@tanstack/ai/src/`, marked `AI/` below. Its bundled skill `skills/ai-core/tool-calling/SKILL.md` (sourced from `TanStack/ai:docs/tools/tool-approval.md`) is marked `AI-skill`.
- **Repo.** Paths under `packages/bot-sdk/plugins/` are marked `P/`.
- **Spike #154.** The assistant's resume spike (TanStack AI 0.66.0, fake adapter), whose finding is posted on #91. It is the only part that was run.
- **Lecture.** Slide 29 in #383's first comment: "If it blocks one, you get an approval request. No answer in 15 seconds means blocked."
- **Unverified.** Nothing new was run for this ticket. Anything marked **Inference** comes from reading code, not from running it.

---

## Answer

1. **TanStack never pauses in place.** A call to a `needsApproval` tool ends the `chat()` stream with `RUN_FINISHED` and `outcome.type: "interrupt"`. Nothing waits inside the process. A "resume" is a **new** `chat()` call with the history, `threadId`, `parentRunId` and a `resume` entry. So "pause and continue" and "end the loop and resume from the saved transcript" are the same mechanism. The only question is whether the second `chat()` call runs in the same runner job or in a new one.
2. **Rebuilding history on the server works.** With no persistence middleware, `chat()` rebuilds the pending calls from `messages`: an assistant tool call with no tool result. It checks the `resume` batch against them, so the client sends nothing back. Spike #154 ran this, and the assistant ships it (ADR 0008, `P/assistant/server/chat/run.ts`, `approval.ts`). The Bot can reuse it, and it beats the `ask_user` pattern for approvals: on approval TanStack **runs the tool itself**, so the tool's activity runs in the resumed loop. `answeredTranscript` can only patch in a result.
3. **The Bot's loop drops the pending call today.** `runLoop` treats the end of the stream as finished. Its `answeredCalls` removes every tool call with no result, so the transcript it returns has lost the interrupted call, and a later resume would fail with `unknown-interrupt`. Either path needs `runLoop` to detect the interrupt and keep that call.
4. **`needsApproval` is a fixed boolean per tool.** It can't decide call by call. The lecture's flow (a reviewer model first, the user only on a block) fits as: mark risky tools `needsApproval: true`, run the review as an activity once the interrupt comes back, then resume with `approved: true` or ask the user. **Inference.**
5. **Two runner shapes work, and neither needs a new engine primitive (Inference):**
   - **A. Wait inside the job (fits 15 s).** One activity waits up to 15 s for the user's decision. Its deadline comes from a recorded `ctx.now()`, and it returns `{ approved: false }` at the deadline. The decision is that activity's Checkpoint, so a replay returns the same answer. The next `chat({ resume })` runs in the same job.
   - **B. End the job (ADR 0008 / `ask_user` style).** Save the transcript, the run ids and a `waiting` status. A decision, or a timeout job queued with `runAfter` = asked + 15 s, queues a new job that resumes from the saved transcript. The runner already has `runAfter`, idempotency keys and `cancelIn`.
   - With a 15-second limit that defaults to blocked, A is enough and much smaller. B suits waits with no limit, such as the Helper's `ask_user`. A `ctx.condition`/signal primitive in the engine would make A tidier, but A works without one.

---

## 1. What `needsApproval` does in 0.66

- **The flag.** `needsApproval?: boolean`: "If true, tool execution requires user approval before running" (`AI/types.ts:946`). The type-level `ApprovalConfig` lets `approvalSchema` be set only when `needsApproval` is `true` (`AI/activities/chat/tools/tool-definition.ts:36-42`). The repo's MCP tools pass `needsApproval: (tool) => …` to `@tanstack/ai-mcp`, which decides once per tool, not per call (`P/assistant/server/mcp/tools.ts:76`). Host tools switch it off for allowed tools by copying the tool with `needsApproval: false` (`P/assistant/server/chat/host-tools.ts:23`).
- **A server tool that needs approval and has no decision yet** goes into `needsApproval` with `approvalId: "approval_<toolCallId>"`. It does not run (`AI/activities/chat/tools/tool-calls.ts:1191-1204`).
- **Batch gating.** If any call in the Step still waits for a decision, every other server call in that batch is skipped as well, "so side effects don't happen before the user decides" (`tool-calls.ts:982-1023`). Those calls run in the resumed `chat()`. In the Bot's sequential loop their activities therefore come after the decision.
- **The pause ends the run.** After the tool phase, any approval, client tool, MCP input or subagent interrupt makes `pauseForDecision` true. `chat()` emits the results it already has, then the interrupt boundary, and the tool phase becomes `wait` or `stop` (`AI/activities/chat/index.ts:2276-2305`). The terminal chunk is `RUN_FINISHED` with `outcome: { type: "interrupt", interrupts }` (`index.ts:5709`). Spike #154 saw `interrupts[0].id === "approval_<toolCallId>"` and the executor not running. `approvalOf` in `P/assistant/server/chat/run.ts:298-310` reads it the same way.
- **What the decision may carry.** `ToolApprovalResolution` is either a `boolean` or `{ approved: true, editedArgs?, payload? } | { approved: false, payload? }` (`AI/interrupts.ts:126`). The resume validator accepts a boolean or a decision envelope. It checks `editedArgs` against the tool's `inputSchema`, and the `payload` against the matching `approvalSchema` branch, which is required when that branch exists (`AI/interrupt-resume.ts:599-669`; normalisation in `AI/activities/chat/tools/approval-schema.ts`). A denial's result for the Model is `payload` when given, else `{ error: "User declined tool execution" }` (`tool-calls.ts:557-561`). So a timeout can tell the Model why it was blocked, through a `reject` payload such as `{ reason: "no answer in 15 seconds" }`. **Inference:** the payload shape is ours to define.
- **One batch, answered whole.** "Resume entries must resolve or cancel the complete interrupt batch". A resume that misses a pending interrupt fails `incomplete-batch` (`interrupt-resume.ts:672-706`). A Step with two risky calls needs both decisions before it resumes.
- **No expiry for approvals.** Only _generic_ interrupts (`defineInterrupt`, raised from middleware `onInterruptBoundary`) carry `expiresAt`. It is checked only when a resume arrives, against `Date.now()`, and rejects a late resume as `expired` (`interrupt-resume.ts:374-393`). Nothing fires at expiry. Approval interrupts carry no `expiresAt`: it appears only in the generic branch at `index.ts:3001-3030`. **So TanStack gives no 15-second timeout. We have to build the timer.**

## 2. What `resume` needs, with history rebuilt on the server

- **Inputs.** `chat({ messages, threadId, parentRunId, resume: [{ interruptId, status: "resolved", payload }] })`. `resume` entries are `{ interruptId, status: "resolved", payload } | { interruptId, status: "cancelled" }` (`AI/activities/chat/middleware/types.ts:375-376`).
- **No persistence middleware is needed.** At start, `run()` calls `applyEphemeralInterruptResume` after the `init` `onConfig` and before `onStart` (`index.ts:1273-1281`). It:
  - throws `InterruptResumeValidationError` (`stale`) without `parentRunId` (`index.ts:4466-4481`);
  - rebuilds the pending calls from `messages`: every assistant `toolCalls` entry with no `tool` message for its id, minus provider-executed calls (`index.ts:3598-3645`, `3670-3698`);
  - rebuilds the approval requests from the **tools passed to this `chat()`**, for each pending call whose tool has `needsApproval` (`index.ts:4500-4530`);
  - binds them to `interruptedRunId = parentRunId` and validates the batch (`index.ts:4545-4605`). **Inference:** since the binding takes its run id from `parentRunId` itself, any stable value passes, as long as the same one is used throughout. Spike #154 used the interrupted run's own `runId`.
- **Spike #154 (run, on #91).** The minimum stored history is the user message plus the assistant message with its tool call (id, name, JSON arguments) and **no** tool-result row. With approval the tool runs and the Model sees its result. With denial the Model gets `{"error":"User declined tool execution"}`. Without the tool call: RUN_ERROR `unknown-interrupt`. Without `parentRunId`: `InterruptResumeValidationError`. The descriptor and response schema need not be stored.
- **Consequence for the Bot (Inference).** The resumed `chat()` must get **the same tool set, with the same `needsApproval` flags**, that asked. A policy change between ask and resume, such as an allowance flipping `needsApproval` to `false`, makes the call no longer pending as an approval, and the resume entry fails `unknown-interrupt`. ADR 0008 hit the same issue and kept the approval on the call that asked (`P/assistant/server/chat/approval.ts:89-92`). In the Bot, the flags must also be deterministic across replays: read the policy in an activity, such as the loop's `setup`, so a replay sees the recorded value.

## 3. How the Bot's loops fit today

- **The engine** (`P/runner/server/workflow/engine.ts`) records `activity`, `now`, `random` and `patched`, nothing else. There is no sleep, timer, signal or condition (`engine.ts:9`, `39-66`). Calls run one at a time, and call order is identity (`engine.ts:145-172`).
- **`runLoop`** (`P/bot/server/loop.ts:176-585`) wraps `chat()`: every model call is a `model` activity plus a `bill` activity (`loop.ts:237-308`), and every tool call is one or more activities. It uses `toolExecution: "sequential"` (`loop.ts:504`). The loop ends when the stream ends: `finished = true` (`loop.ts:550-567`). It has **no interrupt branch**. The transcript passes through `answeredCalls`, which drops tool calls with no result (`loop.ts:581`, `644-656`). So an interrupted Step's pending call would be lost. Its assistant message would keep only the text, or vanish.
- **The Helper's `ask_user`** (`P/bot/server/hand-off.ts`, `helper.ts:376-446`) ends the loop. The tool returns a placeholder result (`waitingResult`), `ended()` stops further model calls, and `handOff` saves the transcript, sets status `waiting` and writes the card in a Checkpoint transaction. Done (`helperDone`) cancels the old job by key and queues a new `bot.helper` job with `waitedSince`. That job replaces the placeholder with the answer (`answeredTranscript`) and calls `runLoop` again with the saved transcript as input and the Step limit reduced by `stepsIn` (`helper.ts:385-400`). This works for `ask_user` because the tool has no effect to run after the decision. For an approval, the approved tool must actually run after the decision, which TanStack's resume does and `answeredTranscript` does not.
- **A Turn has no resume from a saved transcript.** Its input is rebuilt from the Conversation: user messages, Trigger texts and earlier Turns' transcripts, all before `turn.startedAt` (`P/bot/server/turn.ts:757-800`). A Turn that ends while it waits would need a new `waiting` state and resume path, like the Helper's. **Inference.**
- **What the runner already offers for shape B.** `EnqueueOptions.runAfter` ("the earliest time the job may run"), `idempotencyKey` (`P/runner/server/jobs/runner.ts:3-8`), `enqueueIn`/`cancelIn` inside a transaction (`P/runner/server/plugin.ts:17-32`; used by `helperDone`, `hand-off.ts:183-189`).
- **Job timing for shape A.** A heartbeat every 10 s, a 60 s lease (`P/runner/server/jobs/define.ts:119-121`), and a heartbeat on an interval while the job runs (`jobs/store.ts:266`). So an activity that waits 15 s keeps its lease. The in-process runner defaults to `concurrency = 2` for non-Helper jobs (`jobs/in-process.ts:90`), so a waiting Turn holds one of those two slots for up to 15 s.

## 4. The two shapes in detail (Inference throughout)

Both need, in `runLoop`:

- Detect `RUN_FINISHED` with an `interrupt` outcome whose ids start with `approval_`, and record the pending `{ toolCallId, toolName, args }`. Compare `approvalOf` in the assistant's `run.ts`.
- Keep the pending call: don't let `answeredCalls` drop a call that waits for approval.
- Pass explicit, deterministic `threadId` and `runId` to `chat()`, for example derived from the Turn or Helper id and a counter, so a replay produces the same `parentRunId`. Without an explicit `runId`, the engine uses `this.runIdOverride ?? this.requestId` (`index.ts:1034`, `1047`, `3701-3712`; `requestId` is `createId("chat")`), which differs on every attempt.
- Keep the tool set and the `needsApproval` flags the same between ask and resume, and on replay (§2).

**A. Wait inside the job (recommended for "15 s, then blocked").**

1. The interrupt arrives, and `runLoop` stays in its `for (;;)`.
2. `review` activity: the reviewer model, billed like any model call. On approval, go to step 4 with `approved: true` and no user prompt (slide 7, "Auto-approved").
3. `ask` activity: write the approval card/request row in the Checkpoint transaction, with `deadline = recorded now + 15 s`. Then a `decision` activity: wait until the row is decided or the deadline passes, polling or using Postgres `LISTEN/NOTIFY`. Return `{ approved }`, or `{ approved: false, payload: { reason: "timeout" } }` at the deadline. Because the deadline comes from the `ask` Checkpoint, a crash and retry never widens the window. A retry after the deadline returns "blocked" at once. A replay returns the recorded decision without waiting.
4. Call `chat()` again on the same messages, with `threadId`, `parentRunId` and `resume`. The approved tool's activities, and the batch-gated sibling calls, run as normal activities after the decision.
5. The user's decision RPC writes only the decision, under the same row lock as `ask`: first writer wins, against the timeout.

Costs: a runner slot held for up to 15 s, and the wait counts against the Turn's 5-minute and the Helper's 30-minute limit. A deploy's `stop()` takes effect only at the next Checkpoint, so a drain can wait up to 15 s. No engine change. A `ctx.condition(predicate, timeoutMs)` primitive would only move steps 3–4 into the engine.

**B. End the job and resume in a new one.**

1. On the interrupt, `runLoop` ends. One Checkpoint transaction saves the transcript (pending call kept), `threadId`/`runId`, the pending interrupt ids and a `waiting` status, writes the card, and queues a timeout job with `runAfter = now + 15 s` and an idempotency key.
2. The decision RPC or the timeout job, whichever claims the `waiting` row first, sets the decision, cancels the other with `cancelIn`, and queues the resumed job.
3. The resumed job calls `runLoop` on the saved transcript with `resume`. The Helper has all the machinery for this (`helperDone`, `stepsIn`, `waitedSince` time-shift). A Turn would need it built: a `waiting` Turn status, and a resume input that is the saved transcript rather than `modelInput`.

Costs: a schema change (a waiting status plus stored run ids and pending ids, a decision owner question), two extra jobs per approval, and a resume path for Turns. It holds nothing while it waits, so it also fits long waits. ADR 0008 chose this for the assistant because waits there have no limit.

## 5. Open points for the owner

- Shape A or B for the Bot's approval: A is enough for the lecture's 15-second rule. B would only be needed if an approval could wait longer.
- Whether the user's decision may carry `editedArgs`. TanStack supports it, validated against the tool's `inputSchema`.
- What the Model sees on a block: the default `{ error: "User declined tool execution" }`, or a `reject` payload that says reviewer-blocked or timed out.

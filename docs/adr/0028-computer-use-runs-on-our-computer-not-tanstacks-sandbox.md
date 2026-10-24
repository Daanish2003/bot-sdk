---
Status: accepted
---

# Computer use runs on our Computer, not TanStack's sandbox

A Computer-use Helper's desktop actions use `@tanstack/ai-computer-use` (`createComputerUse`), which swaps in each provider's native computer tool. We give it **our own `ComputerDriver`**, which runs xdotool and scrot on the Helper's Screen (display `:N`) through the Computer plugin's `run`. Each machine TanStack thinks it has is a Screen on the user's one Computer (ADR 0019, 0020). The driver never closes it (`idleTimeout: false`, no-op `close()`).

Every action still goes through Auto-review inside a wrapped `execute`, as recorded activities (ADR 0011, 0024). When OpenAI attaches pending safety checks to a call, the call skips Auto-review's pass and always waits for the user's Approval. A yes acknowledges the checks and a no refuses the call. TanStack's interrupt and resume are not used. Screenshots become our blob refs, and our own pruning keeps the last three.

Only models whose adapter swaps in a native tool can run a Computer-use Helper: direct Anthropic, and direct OpenAI on the Responses API. Bedrock, gateways and every other provider can't, even when the model underneath is Claude. The old provider-agnostic `desktop` tool is deleted rather than kept as a fallback, so there is one desktop path to maintain and evaluate.

## Considered Options

- **TanStack's `sandboxComputer` with `ai-sandbox-e2b`**: it makes a new sandbox per thread on display `:0`. That breaks one Computer per user with up to four Screens, and it would move files out of `/home/user` (ADR 0022, 0025).
- **TanStack's interrupt for safety checks**: this is the interrupt-and-resume model ADR 0024 rejects, and its approval state lives in process memory, which a job replay would lose.
- **The `./harness` subpath, for its screenshot pruning**: it pulls in `@tanstack/ai-harness`, which overlaps our runner and plugins (ADR 0011, 0020).
- **Keep `desktop` as a fallback for other vision models**: two desktop paths, each with its own evals.

## Consequences

- A Bot on an unsupported model can't start a Computer-use Helper; `start_helper` says so.
- Not adopted from TanStack AI 1.0 because they contradict accepted ADRs: `ai-harness`, subagents, interrupts, `ai-persistence` and its durability middleware, `ai-memory`, `ai-sandbox` in place of the ComputerProvider, and `chat({ mcp })` merging tools.

import { createHash } from "node:crypto";

import type { ModelMessage, SystemPrompt } from "@tanstack/ai";

import type { PromptHash } from "../../chat/hooks";
import type { PromptStartTool } from "../../storage";

/** The name of a Prompt start's first message among its sections. */
export const firstMessageSection = "first_message";

/** The Prompt start a loop sends on every model call (slide 31), and what it needs to hash it. */
export type LoopPromptStart = {
  id: string;
  /** The tool definitions every call sends, in place of the live tools' own. */
  tools: PromptStartTool[];
  /** The system blocks, in order, by section name. */
  system: { name: string; text: string }[];
  /** The first message, sent before the loop's input. */
  firstMessage: string;
  /** The last model call before the loop's, with the Prompt start it sent, or `undefined`. */
  previousCall: () => Promise<PreviousCall | undefined>;
};

/** What a model call recorded of its prompt, for the next call to compare against. */
export type PreviousCall = { promptStartId: string | null; hashes: PromptHash[] };

/** The sha256 of `text`, in hex. */
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `value` as JSON with every object's keys sorted, so equal values have equal bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}

/** A section's hash, with its size estimated at 4 characters a token. */
const hashed = (name: string, text: string): PromptHash => ({
  name,
  hash: sha256(text),
  tokens: Math.ceil(text.length / 4),
});

/** What one model call sends of a Prompt start and history. */
type SentPrompt = {
  tools: unknown[];
  systemPrompts: SystemPrompt[];
  messages: ModelMessage[];
};

/**
 * The hash of each section a model call sends (slide 32): `tools` as canonical JSON, each system
 * block, the first message, then `history`, the messages after it. The first section that differs
 * from `previous` is flagged: `expected` when `previous` sent another Prompt start, else `bug`. On
 * `history`, it is the messages `previous` sent that differ, so only the newest may be new.
 */
export function promptHashesOf(
  start: Pick<LoopPromptStart, "id" | "system">,
  sent: SentPrompt,
  previous: PreviousCall | undefined,
): PromptHash[] {
  const [first, ...history] = sent.messages;
  const sections: PromptHash[] = [
    hashed("tools", canonicalJson(sent.tools)),
    ...sent.systemPrompts.map((prompt, index) =>
      hashed(
        start.system[index]?.name ?? `system_${index}`,
        typeof prompt === "string" ? prompt : prompt.content,
      ),
    ),
    hashed(
      firstMessageSection,
      typeof first?.content === "string" ? first.content : canonicalJson(first),
    ),
  ];
  const sentHistory: PromptHash = {
    ...hashed("history", canonicalJson(history)),
    messages: history.length,
  };
  if (!previous) return [...sections, sentHistory];
  const changed = previous.promptStartId === start.id ? "bug" : "expected";
  const differs = sections.findIndex((section, index) => {
    const before = previous.hashes[index];
    return before?.name !== section.name || before.hash !== section.hash;
  });
  if (differs >= 0) {
    sections[differs] = { ...sections[differs]!, changed };
    return [...sections, sentHistory];
  }
  const before = previous.hashes.find((entry) => entry.name === "history");
  const kept =
    before?.messages !== undefined &&
    before.messages <= history.length &&
    sha256(canonicalJson(history.slice(0, before.messages))) === before.hash;
  return [...sections, kept ? sentHistory : { ...sentHistory, changed }];
}

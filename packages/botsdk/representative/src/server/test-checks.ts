import { createHash } from "node:crypto";

import type { ModelMessage } from "@tanstack/ai";

import type { Draft, Expectation, TestCheck, TranscriptEntry } from "../shared/contract";

/*
 * What code makes of a test conversation (ticket #1192): the transcript the owner reads, the
 * checks of each expectation, and the hash that ties results to the draft they ran on. There is no
 * model judge: every check looks at what the Representative's tools were called with and answered.
 */

const textOf = (content: ModelMessage["content"]) =>
  typeof content === "string"
    ? content
    : (content ?? []).map((part) => (part.type === "text" ? part.content : "")).join("");

/** `value` with every object's keys in order, so equal drafts print equal whatever order Postgres kept. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, each]) => [key, canonical(each)]),
    );
  }
  return value;
}

/** Identifies a draft's content: a result counts only while the draft hashes as it did when it ran. */
export const draftHash = (draft: Draft) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(draft)))
    .digest("hex");

function argumentsOf(call: { function: { arguments: string } }): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** What reached the Customer, in order: the text of each `reply` call. */
function sentTexts(messages: ModelMessage[]) {
  return messages.flatMap((message) =>
    (message.toolCalls ?? [])
      .filter((call) => call.function.name === "reply")
      .map((call) => String(argumentsOf(call).text ?? "")),
  );
}

/** Whether a `hand_to_bot` call was answered as handed off: a refusal does not count. */
function handedOff(messages: ModelMessage[]) {
  const calls = new Set(
    messages.flatMap((message) =>
      (message.toolCalls ?? [])
        .filter((call) => call.function.name === "hand_to_bot")
        .map((call) => call.id),
    ),
  );
  return messages.some((message) => {
    if (message.role !== "tool" || !calls.has(message.toolCallId ?? "")) return false;
    try {
      return (JSON.parse(textOf(message.content)) as { handedOff?: unknown }).handedOff === true;
    } catch {
      return false;
    }
  });
}

export function checkExpectations(
  expectations: Expectation[],
  messages: ModelMessage[],
): TestCheck[] {
  const sent = sentTexts(messages);
  const handed = handedOff(messages);
  const lowered = sent.map((text) => text.toLowerCase());
  return expectations.map((expectation): TestCheck => {
    switch (expectation.kind) {
      case "replied":
        return {
          expectation,
          passed: sent.length > 0,
          detail: sent.length > 0 ? "It replied to the Customer." : "It sent the Customer nothing.",
        };
      case "handed_off":
        return {
          expectation,
          passed: handed,
          detail: handed ? "It handed off to the Bot." : "It did not hand off to the Bot.",
        };
      case "not_handed_off":
        return {
          expectation,
          passed: !handed,
          detail: handed ? "It handed off to the Bot." : "It did not hand off to the Bot.",
        };
      case "said": {
        const found = lowered.some((text) => text.includes(expectation.text.toLowerCase()));
        return {
          expectation,
          passed: found,
          detail: found
            ? `It said "${expectation.text}".`
            : `It never said "${expectation.text}" to the Customer.`,
        };
      }
      case "not_said": {
        const found = lowered.some((text) => text.includes(expectation.text.toLowerCase()));
        return {
          expectation,
          passed: !found,
          detail: found
            ? `It said "${expectation.text}" to the Customer.`
            : `It never said "${expectation.text}" to the Customer.`,
        };
      }
    }
  });
}

/**
 * The transcript for the owner: the Customer's message as written, what the Representative sent,
 * its other calls and what they answered. Plain text is shown as not delivered, as the Customer
 * would never see it.
 */
export function transcriptOf(customerMessage: string, messages: ModelMessage[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [{ role: "customer", text: customerMessage }];
  const replyCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") {
      entries.push({ role: "system", text: textOf(message.content) });
    } else if (message.role === "assistant") {
      const text = textOf(message.content);
      if (text.trim() !== "")
        entries.push({ role: "system", text: `Not sent to the Customer: ${text}` });
      for (const call of message.toolCalls ?? []) {
        if (call.function.name === "reply") {
          replyCalls.add(call.id);
          entries.push({ role: "representative", text: String(argumentsOf(call).text ?? "") });
        } else {
          entries.push({ role: "tool", text: `${call.function.name} ${call.function.arguments}` });
        }
      }
    } else if (!replyCalls.has(message.toolCallId ?? "")) {
      entries.push({ role: "tool", text: textOf(message.content) });
    }
  }
  return entries;
}

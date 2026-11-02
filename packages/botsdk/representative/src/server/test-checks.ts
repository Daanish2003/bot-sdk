import { createHash } from "node:crypto";

import type { ModelMessage } from "@tanstack/ai";

import {
  canonicalJson,
  type Draft,
  type Expectation,
  type TestCheck,
  type TranscriptEntry,
} from "../shared/contract";

/*
 * What code makes of a test conversation (ticket #1192): the transcript the owner reads, the
 * checks of each expectation, and the hash that ties results to the draft they ran on. There is no
 * model judge: every check looks at what the Representative's tools were called with and answered.
 */

const textOf = (content: ModelMessage["content"]) =>
  typeof content === "string"
    ? content
    : (content ?? []).map((part) => (part.type === "text" ? part.content : "")).join("");

/** Identifies a draft's content: a result counts only while the draft hashes as it did when it ran. */
export const draftHash = (draft: Draft) =>
  createHash("sha256").update(canonicalJson(draft)).digest("hex");

function argumentsOf(call: { function: { arguments: string } }): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** What `call`'s tool answered, as an object; null when it answered nothing or no object. */
function answerTo(messages: ModelMessage[], callId: string): Record<string, unknown> | null {
  const answer = messages.find(
    (message) => message.role === "tool" && message.toolCallId === callId,
  );
  if (!answer) return null;
  try {
    const parsed: unknown = JSON.parse(textOf(answer.content));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** What reached the Customer, in order: the text of each `reply` call the tool answered as sent. */
function sentTexts(messages: ModelMessage[]) {
  return messages.flatMap((message) =>
    (message.toolCalls ?? [])
      .filter(
        (call) => call.function.name === "reply" && answerTo(messages, call.id)?.sent === true,
      )
      .map((call) => String(argumentsOf(call).text ?? "")),
  );
}

/** Whether a `hand_to_bot` call was answered as handed off: a refusal does not count. */
function handedOff(messages: ModelMessage[]) {
  return messages.some((message) =>
    (message.toolCalls ?? []).some(
      (call) =>
        call.function.name === "hand_to_bot" && answerTo(messages, call.id)?.handedOff === true,
    ),
  );
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
 * its other calls and what they answered. A reply the tool didn't answer as sent is one of those
 * calls, as `sentTexts` reads it. Plain text is shown as not delivered, as the Customer would never
 * see it.
 */
export function transcriptOf(customerMessage: string, messages: ModelMessage[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [{ role: "customer", text: customerMessage }];
  const sentCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") {
      entries.push({ role: "system", text: textOf(message.content) });
    } else if (message.role === "assistant") {
      const text = textOf(message.content);
      if (text.trim() !== "")
        entries.push({ role: "system", text: `Not sent to the Customer: ${text}` });
      for (const call of message.toolCalls ?? []) {
        if (call.function.name === "reply" && answerTo(messages, call.id)?.sent === true) {
          sentCalls.add(call.id);
          entries.push({ role: "representative", text: String(argumentsOf(call).text ?? "") });
        } else {
          entries.push({ role: "tool", text: `${call.function.name} ${call.function.arguments}` });
        }
      }
    } else if (!sentCalls.has(message.toolCallId ?? "")) {
      entries.push({ role: "tool", text: textOf(message.content) });
    }
  }
  return entries;
}

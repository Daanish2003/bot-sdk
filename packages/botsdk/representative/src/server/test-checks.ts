import { createHash } from "node:crypto";

import type { ModelMessage } from "@tanstack/ai";

import {
  canonicalJson,
  defaultEmergencyText,
  type Draft,
  type Expectation,
  type TestCheck,
  type TranscriptEntry,
} from "../shared/contract";
import { codeHandOffKind, type ReplyProof, replyKinds, type ReplySource } from "../shared/replies";
import { handOffMessage, insertValues, type ReplyEvidence } from "./replies";

/*
 * What code makes of a test conversation (ticket #1192): the transcript the owner reads, the
 * checks of each expectation, and the hash that ties results to the draft they ran on. There is no
 * model judge: every check looks at what the Representative's tools were called with and answered.
 */

const textOf = (content: ModelMessage["content"]) =>
  typeof content === "string"
    ? content
    : (content ?? []).map((part) => (part.type === "text" ? part.content : "")).join("");

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Identifies a draft's content: a result counts only while the draft hashes as it did when it ran.
 * Documents count by name and text, so the same file uploaded again changes nothing, and a draft with
 * none hashes as one written before documents did. So does one on the default emergency script.
 */
export const draftHash = ({ documents, emergencyText, emergencyKeywords, ...fields }: Draft) =>
  sha256(
    canonicalJson({
      ...fields,
      ...(documents.length > 0 && { documents: documents.map(({ name, hash }) => [name, hash]) }),
      ...(emergencyText !== defaultEmergencyText && { emergencyText }),
      ...(emergencyKeywords.length > 0 && { emergencyKeywords }),
    }),
  );

/**
 * What a Bot wrote of a draft: all of it but the documents, which are the owner's choice. A choice of
 * theirs is no edit that could be lost to a Bot's next draft, which keeps it.
 */
export const botFieldsHash = (draft: Draft) => draftHash({ ...draft, documents: [] });

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

/** What the tools kept of a test conversation beside what they answered the Model. */
export type TestRun = {
  /** The Turn ended on a refusal nothing made good, so code handed off after its messages. */
  handedOffAtEnd: boolean;
  evidence: Map<string, ReplyEvidence>;
};

const noRun: TestRun = { handedOffAtEnd: false, evidence: new Map() };

type ReplyCall = { id: string; function: { arguments: string } };

/** The kind and sources of a sent `reply` call; a test has no Assignment, so no Bot's result. */
function sentReply(run: TestRun, call: ReplyCall): ReplyProof {
  const written = argumentsOf(call).kind;
  return {
    kind: replyKinds.find((kind) => kind === written) ?? null,
    sources: run.evidence.get(call.id)?.sources ?? [],
  };
}

/** The text `call`, a `reply` its tool answered as sent, went with: the Model's, with the facts' values in. */
function sentText(run: TestRun, call: ReplyCall) {
  return insertValues(
    String(argumentsOf(call).text ?? ""),
    run.evidence.get(call.id)?.inserted ?? {},
  );
}

/**
 * What reached the Customer, in order: the text of each `reply` call the tool answered as sent, and
 * for one refused for the last time, code's fixed message in place of its text.
 */
function sentTexts(messages: ModelMessage[], run: TestRun) {
  return messages.flatMap((message) =>
    (message.toolCalls ?? [])
      .filter((call) => call.function.name === "reply")
      .flatMap((call) => {
        const answer = answerTo(messages, call.id);
        if (answer?.sent === true) return [sentText(run, call)];
        return answer?.handedOff === true ? [handOffMessage] : [];
      }),
  );
}

/** The sources of every reply the tool answered as sent: a refused reply cites nothing. */
function citedSources(messages: ModelMessage[], run: TestRun): ReplySource[] {
  return messages.flatMap((message) =>
    (message.toolCalls ?? [])
      .filter(
        (call) => call.function.name === "reply" && answerTo(messages, call.id)?.sent === true,
      )
      .flatMap((call) => sentReply(run, call).sources),
  );
}

const describeSource = (
  source: ReplySource | NonNullable<Extract<Expectation, { kind: "cited" }>["source"]>,
) =>
  source.type === "fact"
    ? `the fact ${source.key}`
    : source.type === "document"
      ? `the document ${source.name}`
      : source.type === "memory"
        ? "the Customer's memory"
        : "a Bot's result";

/**
 * Whether the Turn handed off: a `hand_to_bot` call answered so, a refusal not counting, or a `reply`
 * refused for the last time, whose hand-off is code's.
 */
function handedOff(messages: ModelMessage[]) {
  return messages.some((message) =>
    (message.toolCalls ?? []).some(
      (call) =>
        (call.function.name === "hand_to_bot" || call.function.name === "reply") &&
        answerTo(messages, call.id)?.handedOff === true,
    ),
  );
}

export function checkExpectations(
  expectations: Expectation[],
  messages: ModelMessage[],
  run: TestRun = noRun,
): TestCheck[] {
  const sent = [...sentTexts(messages, run), ...(run.handedOffAtEnd ? [handOffMessage] : [])];
  const handed = run.handedOffAtEnd || handedOff(messages);
  const sources = citedSources(messages, run);
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
          detail: handed ? "It handed off." : "It did not hand off.",
        };
      case "not_handed_off":
        return {
          expectation,
          passed: !handed,
          detail: handed ? "It handed off." : "It did not hand off.",
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
      case "cited": {
        const named = expectation.source;
        const wanted = named ? describeSource(named) : "a source";
        const passed = named
          ? sources.some((source) =>
              named.type === "fact"
                ? source.type === "fact" && source.key === named.key
                : source.type === "document" && source.name === named.name,
            )
          : sources.length > 0;
        const cited = [...new Set(sources.map(describeSource))].join(", ");
        return {
          expectation,
          passed,
          detail: passed
            ? `It cited ${wanted}.`
            : sources.length === 0
              ? "It cited no source."
              : `It never cited ${wanted}. It cited ${cited}.`,
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
export function transcriptOf(
  customerMessage: string,
  messages: ModelMessage[],
  run: TestRun = noRun,
): TranscriptEntry[] {
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
          entries.push({
            role: "representative",
            text: sentText(run, call),
            reply: sentReply(run, call),
          });
        } else {
          entries.push({ role: "tool", text: `${call.function.name} ${call.function.arguments}` });
          if (call.function.name === "reply" && answerTo(messages, call.id)?.handedOff === true) {
            entries.push({
              role: "representative",
              text: handOffMessage,
              reply: { kind: codeHandOffKind, sources: [] },
            });
          }
        }
      }
    } else if (!sentCalls.has(message.toolCallId ?? "")) {
      entries.push({ role: "tool", text: textOf(message.content) });
    }
  }
  if (run.handedOffAtEnd) {
    entries.push({
      role: "representative",
      text: handOffMessage,
      reply: { kind: codeHandOffKind, sources: [] },
    });
  }
  return entries;
}

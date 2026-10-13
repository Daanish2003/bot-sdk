import type { UIMessage } from "@tanstack/ai-react";

import { messageInfo } from "../../core/client/chat";
import {
  artifactKinds,
  type ArtifactKind,
  createArtifactToolName,
  updateArtifactToolName,
} from "../../core/shared/chat/artifact";
import { toolCallOf, type ToolCallView } from "../../core/shared/chat/tool-call";
import { type ArtifactRef, artifactRefOf } from "./artifact-card";

/**
 * The Artifact side of a reply as it streams (spec #304): which calls are Artifact calls, when the
 * panel should follow one, and what the panel shows for a call that has not saved its version yet.
 */

/** An Artifact call in a reply, and the Message holding it. `streaming` while that reply is live. */
export type ArtifactCallOn = { messageId: string; call: ToolCallView; streaming: boolean };

/** What the panel follows: an Artifact version, or an Artifact call still streaming (by its id). */
export type PanelTarget = { kind: "saved"; ref: ArtifactRef } | { kind: "live"; callId: string };

/** What the panel shows: a saved version, or the live call (with the Message holding it). */
export type PanelOn =
  | { kind: "saved"; ref: ArtifactRef }
  | { kind: "live"; call: ToolCallView; messageId: string };

const artifactToolNames: readonly string[] = [createArtifactToolName, updateArtifactToolName];

/** Every Artifact call among the Messages, in order. */
export function artifactCallsIn(messages: ReadonlyArray<UIMessage>): ArtifactCallOn[] {
  const calls: ArtifactCallOn[] = [];
  for (const message of messages) {
    const streaming = messageInfo(message).status === "streaming";
    for (const part of message.parts) {
      const call = toolCallOf(part);
      if (call && artifactToolNames.includes(call.name)) {
        calls.push({ messageId: message.id, call, streaming });
      }
    }
  }
  return calls;
}

/**
 * The streaming Artifact calls the panel has not followed yet. Each is returned once, and marked in
 * `seen`, so the panel opens on the first delta of a call and not again. A call that arrives
 * already complete (a Provider that sends a call in one chunk) still counts.
 */
export function startedArtifactCalls(
  messages: ReadonlyArray<UIMessage>,
  seen: Set<string>,
): ArtifactCallOn[] {
  const started = artifactCallsIn(messages).filter(
    ({ call, streaming }) => streaming && !seen.has(call.id),
  );
  for (const { call } of started) seen.add(call.id);
  return started;
}

/**
 * What the panel shows for its target: the saved version once the call is done with its version,
 * else the live call. `null` when no such call is among the Messages (the panel closes).
 */
export function panelTargetOf(
  messages: ReadonlyArray<UIMessage>,
  target: PanelTarget,
): PanelOn | null {
  if (target.kind === "saved") return { kind: "saved", ref: target.ref };
  const found = artifactCallsIn(messages).find(({ call }) => call.id === target.callId);
  if (!found) return null;
  const ref = found.call.status === "done" ? artifactRefOf(found.call.result) : undefined;
  if (ref) return { kind: "saved", ref: { ...ref, messageId: found.messageId } };
  return { kind: "live", call: found.call, messageId: found.messageId };
}

/** A call's source and state as the live panel shows them, from the arguments streamed so far. */
export type LiveArtifact = {
  /** `writing` (a create), `updating` (an update running), or `not-saved` (the call ended unsaved). */
  state: "writing" | "updating" | "not-saved";
  kind: ArtifactKind;
  title: string;
  language: string | null;
  /**
   * The source written so far. `undefined` for an edits update, which shows the previous version
   * instead, since its edits are applied only once the call ends.
   */
  content: string | undefined;
  /** Whether the call is an update by edits, or by `restoreVersion`, rather than a full content. */
  edits: boolean;
  /** The line under the panel's header, for a call that ended unsaved. */
  notice?: string;
};

/**
 * The live view of a call that has no version to show yet. The arguments may be partial: a
 * streaming call's JSON is parsed as it arrives (`toolCallOf`). An update's kind and title come from
 * its Artifact's latest version, which the panel loads; the defaults here are only placeholders.
 */
export function liveArtifactOf(call: ToolCallView): LiveArtifact {
  const input = (call.args ?? {}) as {
    kind?: unknown;
    title?: unknown;
    language?: unknown;
    content?: unknown;
  };
  const kind = artifactKinds.find((known) => known === input.kind) ?? "code";
  const edits = call.name === updateArtifactToolName && typeof input.content !== "string";
  const state =
    call.status !== "running"
      ? "not-saved"
      : call.name === updateArtifactToolName
        ? "updating"
        : "writing";
  return {
    state,
    kind,
    title: typeof input.title === "string" ? input.title : "Artifact",
    language: typeof input.language === "string" ? input.language : null,
    content: edits ? undefined : typeof input.content === "string" ? input.content : "",
    edits,
    ...(state === "not-saved" && { notice: "This Artifact wasn't saved" }),
  };
}

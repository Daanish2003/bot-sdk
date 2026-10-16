import type { UIMessage } from "@tanstack/ai-react";

import { messageInfo } from "../../client/chat";
import {
  artifactKinds,
  type ArtifactKind,
  createArtifactToolName,
  updateArtifactToolName,
} from "../../shared/chat/artifact";
import type { I18n } from "../../../../core/shared/i18n";
import { toolCallOf, type ToolCallView } from "../../shared/chat/tool-call";
import { type ArtifactRef, artifactRefOf } from "./artifact-card";

/**
 * The Artifact side of a reply as it streams (spec #304): which calls are Artifact calls, when the
 * panel should follow one, and what the panel shows for a call that has not saved its version yet.
 */

/** An Artifact call in a reply, and the Message holding it. `streaming` while that reply is live. */
export type ArtifactCallOn = { messageId: string; call: ToolCallView; streaming: boolean };

/** A saved version, by its Artifact and number. Its Message is looked up once the reply is stored. */
type SavedVersion = Pick<ArtifactRef, "artifactId" | "version">;

/**
 * What the panel follows: an Artifact version, or an Artifact call still streaming (by its id). A
 * live call keeps the version it saved (`saved`): the stored reply holds that version under another
 * id, so the call's id stops matching once the reply is stored.
 */
export type PanelTarget =
  | { kind: "saved"; ref: SavedVersion }
  | { kind: "live"; callId: string; saved?: SavedVersion };

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
 * What the panel shows for its target. A saved version is shown only once its Message is stored,
 * since the version is loaded by that Message's server id; a call still streaming (even one that
 * is done with its version) shows the live call. `null` when the target is no longer on screen.
 */
export function panelTargetOf(
  messages: ReadonlyArray<UIMessage>,
  target: PanelTarget,
): PanelOn | null {
  if (target.kind === "saved") return storedPanelOn(messages, target.ref);
  const found = artifactCallsIn(messages).find(({ call }) => call.id === target.callId);
  if (!found) return target.saved ? storedPanelOn(messages, target.saved) : null;
  const saved = found.call.status === "done" ? artifactRefOf(found.call.result) : undefined;
  if (saved && !found.streaming) return storedPanelOn(messages, saved);
  return { kind: "live", call: found.call, messageId: found.messageId };
}

/** The saved version as the stored Message holding it shows it; `null` until that Message is stored. */
function storedPanelOn(messages: ReadonlyArray<UIMessage>, version: SavedVersion): PanelOn | null {
  for (const { messageId, call, streaming } of artifactCallsIn(messages)) {
    const saved = artifactRefOf(call.result);
    if (
      streaming ||
      saved?.artifactId !== version.artifactId ||
      saved.version !== version.version
    ) {
      continue;
    }
    return { kind: "saved", ref: { ...saved, messageId } };
  }
  return null;
}

/**
 * The live target with the version its call saved, once the call is done with one. The stored
 * Message replaces the call with its saved version, so the target keeps that version from then on.
 */
export function rememberSaved(
  target: PanelTarget,
  messages: ReadonlyArray<UIMessage>,
): PanelTarget {
  if (target.kind !== "live" || target.saved) return target;
  const found = artifactCallsIn(messages).find(({ call }) => call.id === target.callId);
  const saved = found?.call.status === "done" ? artifactRefOf(found.call.result) : undefined;
  return saved
    ? { ...target, saved: { artifactId: saved.artifactId, version: saved.version } }
    : target;
}

/** A call's source and state as the live panel shows them, from the arguments streamed so far. */
export type LiveArtifact = {
  /**
   * `writing` (a create), `updating` (an update running), `saving` (the call is done with its
   * version, and its reply still streams), or `not-saved` (the call ended unsaved).
   */
  state: "writing" | "updating" | "saving" | "not-saved";
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
export function liveArtifactOf({ t }: I18n, call: ToolCallView): LiveArtifact {
  const input = (call.args ?? {}) as {
    kind?: unknown;
    title?: unknown;
    language?: unknown;
    content?: unknown;
  };
  const kind = artifactKinds.find((known) => known === input.kind) ?? "code";
  const edits = call.name === updateArtifactToolName && typeof input.content !== "string";
  const state =
    call.status === "done" && artifactRefOf(call.result)
      ? "saving"
      : call.status !== "running"
        ? "not-saved"
        : call.name === updateArtifactToolName
          ? "updating"
          : "writing";
  return {
    state,
    kind,
    title: typeof input.title === "string" ? input.title : t("chat.artifactTitleFallback"),
    language: typeof input.language === "string" ? input.language : null,
    content: edits ? undefined : typeof input.content === "string" ? input.content : "",
    edits,
    ...(state === "not-saved" && { notice: t("chat.artifactNotSavedNotice") }),
  };
}

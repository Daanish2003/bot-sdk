import {
  artifactKindLabels,
  type ArtifactKind,
  artifactKinds,
} from "../../core/shared/chat/artifact";
import type { ToolCallView } from "../../core/shared/chat/tool-call";
import { cn } from "@/lib/utils";
import { FileCodeIcon, Loader2Icon } from "lucide-react";

/** An Artifact version a reply shows: the version's number and the Message whose Branch holds it. */
export type ArtifactRef = { artifactId: string; version: number; messageId: string };

/**
 * The card an Artifact call shows in its reply (spec #304): an icon, the title and what happened.
 * Clicking it opens the panel on the version the call saved. A call still running reads "Writing…",
 * one that failed or was cut off reads "Not saved" (no version was made), and a later version reads
 * "Updated to vN".
 */
export function ArtifactCard({
  call,
  messageId,
  onOpen,
}: {
  call: ToolCallView;
  /** The Message holding the call, which places the version on its Branch. */
  messageId: string;
  /** Opens the panel on this version; without it the card is not a button. */
  onOpen?: (ref: ArtifactRef) => void;
}) {
  const { title, kind } = artifactInputOf(call.args);
  const ref = artifactRefOf(call.result);
  // A version exists only for a call that ended `done` with its result (ADR 0016).
  const saved = call.status === "done" && ref ? { ...ref, messageId } : undefined;
  const status = saved
    ? saved.version > 1
      ? `Updated to v${saved.version}`
      : `Created v${saved.version} · ${artifactKindLabels[kind]}`
    : call.status === "running"
      ? "Writing…"
      : "Not saved";
  const body = (
    <>
      <FileCodeIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        <span className="text-xs text-muted-foreground" role="status">
          {status}
        </span>
      </span>
      {call.status === "running" && (
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" aria-hidden />
      )}
    </>
  );

  if (!saved || !onOpen) {
    // Not a button: nothing to open yet, or the card has no panel to open it in.
    return (
      <div
        className="flex w-full max-w-sm items-center gap-3 rounded-lg border px-3 py-2"
        data-artifact-card
      >
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-artifact-card
      onClick={() => onOpen(saved)}
      className={cn(
        "flex w-full max-w-sm items-center gap-3 rounded-lg border px-3 py-2 text-left hover:bg-muted",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
      )}
    >
      {body}
    </button>
  );
}

/**
 * The title and kind an Artifact call was made with. An `update_artifact` call carries only its
 * artifactId (and a new title), so its card title falls back to the Artifact's name.
 */
function artifactInputOf(args: unknown): { title: string; kind: ArtifactKind } {
  const input = (args ?? {}) as { title?: unknown; kind?: unknown };
  const kind = artifactKinds.find((known) => known === input.kind) ?? "code";
  return { title: typeof input.title === "string" ? input.title : "Artifact", kind };
}

/** The version a call saved, from its result; `undefined` when the call saved none. */
export function artifactRefOf(
  result: unknown,
): { artifactId: string; version: number } | undefined {
  const output = (result ?? {}) as { artifactId?: unknown; version?: unknown };
  if (typeof output.artifactId !== "string" || typeof output.version !== "number") return undefined;
  return { artifactId: output.artifactId, version: output.version };
}

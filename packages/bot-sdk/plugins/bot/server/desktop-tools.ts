import { type ContentPart, type ModelMessage, toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import type { BlobStore } from "../../../core/server/blob/store";
import type { ComputerHandle } from "../../computer/server/plugin";
import type { FileToolOptions } from "./computer-tools";
import type { LoopKit } from "./loop";
import { botFileRef, sentFileBlobKey } from "./files";
import { screenshotBlobKey } from "./screenshots";

/** What the Desktop tool returns on a model that can't take images. */
export const noVisionError =
  "This model can't see screenshots; use the Browser tools or ask the user.";

/** What an older screenshot becomes in the model's input. */
export const removedScreenshot = "[older screenshot removed]";

/** How many of the newest screenshots stay in the model's input. */
export const keptScreenshots = 3;

/** What a screenshot whose bytes are gone from the blob store becomes in the model's input. */
export const missingScreenshot = "[screenshot missing]";

/** The Screen is 1280x800 and its coordinates are never scaled. */
const screenWidth = 1280;
const screenHeight = 800;

/** How long the screen gets to settle after an action, before it is photographed. */
const settleSeconds = 0.5;

/** The longest `wait` a call may ask for. */
const maxWaitSeconds = 30;

const actions = [
  "screenshot",
  "left_click",
  "right_click",
  "double_click",
  "mouse_move",
  "left_click_drag",
  "type",
  "key",
  "scroll",
  "wait",
] as const;

/**
 * [x, y]. An array of two, not a tuple: a tuple becomes `items: [...]`, which is not JSON Schema
 * draft 2020-12, and Anthropic's API rejects the whole tool. The y bound is checked at run time.
 */
const point = z
  .array(
    z
      .number()
      .int()
      .min(0)
      .max(screenWidth - 1),
  )
  .length(2)
  .refine(([, y]) => y! < screenHeight, `y must be under ${screenHeight}`)
  .meta({ description: `[x, y] on the ${screenWidth}x${screenHeight} screen.` });

const desktopDefinition = toolDefinition({
  name: "desktop",
  description:
    "Use your Screen's whole desktop by sight: take a screenshot, move the mouse, click, drag, " +
    "type, press keys, scroll or wait. Every action returns a screenshot of the desktop after " +
    `it. Coordinates are pixels on a ${screenWidth}x${screenHeight} screen.`,
  inputSchema: z.object({
    action: z.enum(actions),
    coordinate: point
      .optional()
      .meta({ description: "Where to click or move; where a drag ends; where to scroll." }),
    startCoordinate: point.optional().meta({ description: "Where a left_click_drag starts." }),
    text: z.string().optional().meta({
      description: "For type: the text. For key: a key or combination, such as Return or ctrl+a.",
    }),
    scrollDirection: z.enum(["up", "down", "left", "right"]).optional(),
    scrollAmount: z.number().int().min(1).max(50).optional().meta({
      description: "How many scroll steps (5 by default).",
    }),
    seconds: z
      .number()
      .positive()
      .max(maxWaitSeconds)
      .optional()
      .meta({ description: "For wait: how long (1 by default)." }),
  }),
});

type Input = z.infer<typeof desktopDefinition.inputSchema>;

/** A shell word for `value`, safe inside single quotes. */
const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The `xdotool` arguments of an action, or what the call lacks. `undefined` takes no input. */
function xdotoolArguments(input: Input): { args?: string; missing?: string } {
  const at = (name: string, value: readonly number[] | undefined) =>
    value ? { xy: `${value[0]} ${value[1]}` } : { missing: `${input.action} needs ${name}` };
  switch (input.action) {
    case "screenshot":
      return {};
    case "wait":
      return {};
    case "left_click":
    case "right_click":
    case "double_click": {
      const where = at("coordinate", input.coordinate);
      if (where.missing) return where;
      const click =
        input.action === "left_click"
          ? "click 1"
          : input.action === "right_click"
            ? "click 3"
            : "click --repeat 2 --delay 100 1";
      return { args: `mousemove ${where.xy} ${click}` };
    }
    case "mouse_move": {
      const where = at("coordinate", input.coordinate);
      return where.missing ? where : { args: `mousemove ${where.xy}` };
    }
    case "left_click_drag": {
      const from = at("startCoordinate", input.startCoordinate);
      if (from.missing) return from;
      const to = at("coordinate", input.coordinate);
      if (to.missing) return to;
      return {
        args: `mousemove ${from.xy} mousedown 1 mousemove ${to.xy} mouseup 1`,
      };
    }
    case "type":
      if (input.text === undefined) return { missing: "type needs text" };
      return { args: `type --delay 12 -- ${quoted(input.text)}` };
    case "key":
      if (!input.text) return { missing: "key needs text" };
      return { args: `key -- ${quoted(input.text)}` };
    case "scroll": {
      if (!input.scrollDirection) return { missing: "scroll needs scrollDirection" };
      const button = { up: 4, down: 5, left: 6, right: 7 }[input.scrollDirection];
      const move = input.coordinate
        ? `mousemove ${input.coordinate[0]} ${input.coordinate[1]} `
        : "";
      return { args: `${move}click --repeat ${input.scrollAmount ?? 5} ${button}` };
    }
  }
}

/** What one Desktop action returns inside its Checkpoint: the id of its stored screenshot. */
type DesktopResult = { result: string; screenshotId: string };

/** Stores a screenshot's PNG once and returns its id. */
type KeepScreenshot = (png: Uint8Array) => Promise<string>;

/** One action on Screen `slot`, then a screenshot of the desktop, stored by `keep`. */
async function act(
  computer: ComputerHandle,
  slot: number,
  input: Input,
  live: FileToolOptions,
  keep: KeepScreenshot,
): Promise<DesktopResult | { error: string }> {
  const display = `DISPLAY=:${slot}`;
  const { args, missing } = xdotoolArguments(input);
  if (missing) return { error: missing };
  if (args) {
    const done = await computer.run(`${display} xdotool ${args}`, live);
    if ("timedOut" in done) return { error: "The action timed out." };
    if (done.exitCode !== 0) {
      return { error: done.stderr.trim().split("\n")[0] || `xdotool exited ${done.exitCode}` };
    }
  }
  const waited = input.action === "wait" ? (input.seconds ?? 1) : 0;
  const path = `/tmp/screens/${slot}/desktop.png`;
  const shot = await computer.run(
    `sleep ${waited + settleSeconds} && ${display} scrot -o ${path}`,
    live,
  );
  if ("timedOut" in shot) return { error: "The screenshot timed out." };
  const bytes = shot.exitCode === 0 ? await computer.readFile(path, live) : null;
  if (!bytes) {
    return { error: shot.stderr.trim().split("\n")[0] || "The screenshot could not be taken." };
  }
  return { result: input.action, screenshotId: await keep(bytes) };
}

/**
 * The Desktop tool of a Computer-use Helper (#570): `xdotool` on its Screen's display, and a
 * screenshot after each action as an image part. On a model that can't see images (`canSee`
 * false) it is still there, and says so. Each call is one Computer call of the loop. Each
 * screenshot is stored once by `keep` (#608); the image part holds its ref, which the loop
 * resolves to the PNG only when it calls the Model (`resolveImageRefs`).
 */
export function desktopTools(
  slot: number,
  computerCall: LoopKit["computerCall"],
  canSee: () => Promise<boolean>,
  keep: KeepScreenshot,
) {
  return [
    desktopDefinition.server(async (input, context) => {
      // Every action gets Auto-review first (spec #691), once the Model is known to see: an action
      // that can't run is never reviewed. Asked only live, in its own Checkpoint, so a replay reads
      // the answer it recorded.
      const done = await computerCall(
        "desktop",
        context?.toolCallId,
        (computer, live) => act(computer, slot, input as Input, live, keep),
        true,
        input,
        async () => ((await canSee()) ? null : { error: noVisionError }),
      );
      // A result over the long-output limit comes back as its cut text, a string.
      if (typeof done === "string" || "error" in done) return done;
      const { result, screenshotId, ...rest } = done as DesktopResult & { note?: string };
      const parts: ContentPart[] = [
        { type: "text", content: JSON.stringify({ result, ...rest }) },
        {
          type: "image",
          source: { type: "url", value: `${screenshotRef}${screenshotId}`, mimeType: "image/png" },
        },
      ];
      return parts;
    }),
  ];
}

/** Whether a content part is a screenshot the Desktop tool returned. */
const isImage = (part: ContentPart) => part.type === "image";

/**
 * The input of a model call with only the newest `keptScreenshots` screenshots in it: each older
 * one becomes `removedScreenshot`. The messages themselves are not changed.
 */
export function pruneScreenshots(messages: readonly ModelMessage[]): ModelMessage[] {
  let kept = 0;
  const pruned = [...messages];
  for (let i = pruned.length - 1; i >= 0; i -= 1) {
    const entry = pruned[i]!;
    if (entry.role !== "tool" || !Array.isArray(entry.content)) continue;
    const content = entry.content as ContentPart[];
    if (!content.some(isImage)) continue;
    kept += 1;
    if (kept <= keptScreenshots) continue;
    pruned[i] = {
      ...entry,
      content: content.map((part) =>
        isImage(part) ? { type: "text" as const, content: removedScreenshot } : part,
      ),
    };
  }
  return pruned;
}

/** How a stored screenshot's image part names it: `screenshot:<id>`, never a real URL. */
const screenshotRef = "screenshot:";

/** What a user's image whose bytes are gone from the blob store becomes in the model's input. */
export const missingUserImage = "[the user's image is no longer stored]";

/** What a user's image the model call leaves out becomes: the line beside it names the file. */
export const userImageLeftOut = "[the user's image, left out: open the file named above]";

/** The most bytes of the user's images one model call sends; history is resent on every call. */
export const maxHistoryImageBytes = 20 * 1024 * 1024;

/**
 * A model call's input with each image ref resolved to its bytes from the blob store: a Helper's
 * screenshot (run after `pruneScreenshots`, so only the kept ones are read), and an image the user
 * sent with a Message (spec #801). The user's images go only to a Model that `seesImages`, newest
 * first up to `maxHistoryImageBytes`; the rest become `userImageLeftOut`, unread. One whose bytes
 * are gone becomes `missingScreenshot` or `missingUserImage`. The messages themselves are not
 * changed.
 */
export async function resolveImageRefs(
  blobStore: Pick<BlobStore, "get">,
  messages: readonly ModelMessage[],
  { seesImages }: { seesImages: boolean },
): Promise<ModelMessage[]> {
  // The user's images, newest first, each read while the budget lasts.
  const userImages = new Map<string, Uint8Array | null | "left out">();
  let budget = seesImages ? maxHistoryImageBytes : 0;
  for (const entry of [...messages].reverse()) {
    if (!Array.isArray(entry.content)) continue;
    for (const part of [...(entry.content as ContentPart[])].reverse()) {
      if (!isRef(part) || !part.source.value.startsWith(botFileRef)) continue;
      const ref = part.source.value;
      if (userImages.has(ref)) continue;
      const bytes =
        budget > 0 ? await blobStore.get(sentFileBlobKey(ref.slice(botFileRef.length))) : null;
      if (budget <= 0 || (bytes && bytes.length > budget)) {
        userImages.set(ref, "left out");
        budget = 0;
        continue;
      }
      userImages.set(ref, bytes);
      if (bytes) budget -= bytes.length;
    }
  }
  return Promise.all(
    messages.map(async (entry) => {
      if (!Array.isArray(entry.content)) return entry;
      const content = entry.content as ContentPart[];
      if (!content.some(isRef)) return entry;
      return {
        ...entry,
        content: await Promise.all(
          content.map(async (part): Promise<ContentPart> => {
            if (!isRef(part)) return part;
            const ref = part.source.value;
            const screenshot = ref.startsWith(screenshotRef);
            const bytes = screenshot
              ? await blobStore.get(screenshotBlobKey(ref.slice(screenshotRef.length)))
              : userImages.get(ref);
            if (bytes === "left out") return { type: "text", content: userImageLeftOut };
            if (!bytes) {
              return { type: "text", content: screenshot ? missingScreenshot : missingUserImage };
            }
            const value = Buffer.from(bytes).toString("base64");
            const mimeType = screenshot ? "image/png" : (part.source.mimeType ?? "image/png");
            return { type: "image", source: { type: "data", value, mimeType } };
          }),
        ),
      };
    }),
  );
}

/** Whether a content part is a stored screenshot's ref or a user's image's. */
function isRef(part: ContentPart): part is ContentPart & {
  type: "image";
  source: { type: "url"; value: string; mimeType?: string };
} {
  return (
    part.type === "image" &&
    part.source.type === "url" &&
    (part.source.value.startsWith(screenshotRef) || part.source.value.startsWith(botFileRef))
  );
}

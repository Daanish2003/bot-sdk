import type { AnyServerTool } from "@tanstack/ai";
import {
  type ComputerDriver,
  type ComputerDriverFactory,
  createComputerUse,
  type MouseButton,
} from "@tanstack/ai-computer-use";

import {
  type ComputerHandle,
  ComputerOperationError,
  ComputerUnavailableError,
} from "../../computer/server/plugin";
import type { FileToolOptions } from "./computer-tools";
import { screenshotPart } from "./image-refs";
import type { LoopKit } from "./loop";

/** The computer tool's name, as each direct Provider's native computer tool calls it. */
export const computerToolName = "computer";

/** The activity of a computer call's screenshot, recorded after its action's. */
export const computerScreenshotActivity = `${computerToolName}:screenshot`;

/** What the computer tool returns on a model that can't take images. */
export const noVisionError =
  "This model can't see screenshots; use the Browser tools or ask the user.";

/** The Screen is 1280x800 and its coordinates are never scaled. */
const display = { width: 1280, height: 800 };

/** How long the screen gets to settle after an action, before it is photographed. */
const settleSeconds = 0.5;

/** How many pixels of a scroll one wheel click is, as TanStack counts a scroll step. */
const scrollStepPixels = 100;

/** The xdotool button of each mouse button. */
const buttons: Record<MouseButton, number> = { left: 1, middle: 2, right: 3, back: 8, forward: 9 };

/** The X keysym of each `KeyboardEvent.key` name that xdotool spells another way. */
const keysyms: Record<string, string> = {
  Control: "ctrl",
  Shift: "shift",
  Alt: "alt",
  Meta: "super",
  Enter: "Return",
  " ": "space",
  Backspace: "BackSpace",
  PageUp: "Prior",
  PageDown: "Next",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  CapsLock: "Caps_Lock",
  "+": "plus",
  "-": "minus",
};

const keysym = (key: string) => keysyms[key] ?? key;

/** A shell word for `value`, safe inside single quotes. */
const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The Computer call a Screen's commands run in: its handle and the live call's limits. */
type ScreenCall = { computer: ComputerHandle; live: FileToolOptions };

/**
 * Our driver of Screen `slot` (ADR 0028): each action is `xdotool` on the Screen's display,
 * through the Computer plugin's `run`, in the Computer call `call` returns. A failed command throws
 * its first line of stderr. Its `screenshot` is empty: the screenshot is an activity of its own,
 * after the action's (`takeScreenshot`). Its `close` does nothing: the Computer's own sleep and
 * the Screen's lifecycle stay in charge.
 */
function screenDriver(slot: number, call: () => ScreenCall): ComputerDriver {
  const xdotool = async (args: string) => {
    const { computer, live } = call();
    const done = await computer.run(`DISPLAY=:${slot} xdotool ${args}`, live);
    if ("timedOut" in done) throw new Error("The action timed out.");
    if (done.exitCode !== 0) {
      throw new Error(done.stderr.trim().split("\n")[0] || `xdotool exited ${done.exitCode}`);
    }
  };
  const at = (x: number, y: number) => `mousemove ${Math.round(x)} ${Math.round(y)}`;
  /** `steps` wheel clicks of `button`, or nothing. */
  const wheel = (pixels: number, back: number, forward: number) =>
    pixels === 0
      ? ""
      : ` click --repeat ${Math.max(1, Math.round(Math.abs(pixels) / scrollStepPixels))} ${
          pixels < 0 ? back : forward
        }`;
  return {
    display,
    environment: "linux",
    screenshot: async () => new Uint8Array(),
    click: (x, y, { button, count }) =>
      xdotool(
        `${at(x, y)} ${count > 1 ? `click --repeat ${count} --delay 100` : "click"} ${buttons[button]}`,
      ),
    move: (x, y) => xdotool(at(x, y)),
    mouseDown: (button) => xdotool(`mousedown ${buttons[button]}`),
    mouseUp: (button) => xdotool(`mouseup ${buttons[button]}`),
    scroll: (x, y, deltaX, deltaY) =>
      xdotool(`${at(x, y)}${wheel(deltaY, 4, 5)}${wheel(deltaX, 6, 7)}`),
    keyDown: (key) => xdotool(`keydown -- ${quoted(keysym(key))}`),
    keyUp: (key) => xdotool(`keyup -- ${quoted(keysym(key))}`),
    press: (keys) => xdotool(`key -- ${quoted(keys.map(keysym).join("+"))}`),
    type: (text) => xdotool(`type --delay 12 -- ${quoted(text)}`),
    close: async () => {},
  };
}

/** A screenshot of Screen `slot` once it has settled, with `scrot`: its PNG, or what failed. */
async function takeScreenshot(
  computer: ComputerHandle,
  slot: number,
  live: FileToolOptions,
): Promise<Uint8Array | { error: string }> {
  const path = `/tmp/screens/${slot}/desktop.png`;
  const shot = await computer.run(
    `sleep ${settleSeconds} && DISPLAY=:${slot} scrot -o ${path}`,
    live,
  );
  if ("timedOut" in shot) return { error: "The screenshot timed out." };
  const bytes = shot.exitCode === 0 ? await computer.readFile(path, live) : null;
  return (
    bytes ?? { error: shot.stderr.trim().split("\n")[0] || "The screenshot could not be taken." }
  );
}

/** Anthropic's actions that only look (or wait), and OpenAI's. */
const lookingActions = new Set(["screenshot", "zoom", "cursor_position", "wait"]);

/** The action of a call: Anthropic's name, or each of OpenAI's actions. */
function actionsOf(input: Record<string, unknown>): unknown[] {
  const { action, actions } = input;
  return Array.isArray(actions) ? actions : [action];
}

/** Whether a computer call only looks at the Screen, so it needs no Auto-review. */
const onlyLooks = (input: Record<string, unknown>) =>
  actionsOf(input).every((item) =>
    lookingActions.has(
      typeof item === "string" ? item : String((item as { type?: unknown } | null)?.type),
    ),
  );

/** What a computer call did, as its result names it: Anthropic's action, or OpenAI's types. */
const actionOf = (input: Record<string, unknown>) =>
  actionsOf(input)
    .map((item) =>
      typeof item === "string" ? item : String((item as { type?: unknown } | null)?.type),
    )
    .join(", ");

/** The error a failed computer call throws, so its adapter sends a failed call: with its rebuilt note. */
const failed = ({ error, note }: { error: string; note?: string }) =>
  new Error(note ? `${error} ${note}` : error);

/** Stores a screenshot's PNG once and returns its id. */
type KeepScreenshot = (png: Uint8Array) => Promise<string>;

/**
 * The computer tool of Computer-use Helper `helperId`, on Screen `slot` (ADR 0028):
 * `@tanstack/ai-computer-use`'s portable tool, which each direct Provider's adapter swaps for its
 * native computer tool, on our own driver. The `threadId` it runs under is the Helper's id (the
 * loop's). Its `execute` is wrapped, so each call is recorded activities of the loop:
 *
 * 1. whether the Model can see (`canSee`), asked before the review;
 * 2. Auto-review, for a call that does more than look;
 * 3. the action;
 * 4. the screenshot, stored once by `keep` and returned as its ref.
 *
 * A replay reads each recorded result, so it never runs an action or asks for an Approval again,
 * and a retry after the action recorded only takes the screenshot. A call that fails throws its
 * error, so each adapter sends it back as a failed call.
 */
export function computerUseTool(
  helperId: string,
  slot: number,
  computerCall: LoopKit["computerCall"],
  canSee: () => Promise<boolean>,
  keep: KeepScreenshot,
): AnyServerTool {
  /** The Computer call of the action running now: only one runs at a time, in call order. */
  let current: ScreenCall | undefined;
  const computerUse = createComputerUse({
    driver: {
      display,
      environment: "linux",
      capabilities: { zoom: false, cursorPosition: false, navigate: false },
      create: async ({ threadId }) => {
        if (threadId !== helperId) throw new Error(`No Screen for thread ${threadId}`);
        return screenDriver(slot, () => {
          if (!current) throw new Error("A Screen command ran outside a computer call.");
          return current;
        });
      },
    } satisfies ComputerDriverFactory,
    // The screenshot is its own activity, which waits for the screen to settle.
    screenshotDelay: 0,
    // The Computer's own sleep is in charge: TanStack never closes a Screen.
    idleTimeout: false,
  });
  const [portable] = computerUse.tools;
  const run = portable.execute!;
  return {
    ...portable,
    execute: async (input: Record<string, unknown>, context?: Parameters<typeof run>[1]) => {
      const toolCallId = context?.toolCallId;
      // #848: a call with OpenAI's pending safety checks skips Auto-review and always waits for
      // the user's Approval, here, before the action. Until then TanStack's `run` refuses it.
      const acted = await computerCall(
        computerToolName,
        toolCallId,
        async (computer, live): Promise<{ result: string } | { error: string }> => {
          current = { computer, live };
          try {
            await run(input, context);
            return { result: actionOf(input) };
          } catch (caught) {
            // TanStack refuses the rest of a model turn after a failed action; each call here is
            // reviewed and recorded on its own, so the thread starts afresh.
            await computerUse.close(helperId);
            if (caught instanceof ComputerUnavailableError) throw caught;
            if (caught instanceof ComputerOperationError) throw caught;
            if (live.signal?.aborted) throw caught;
            return { error: caught instanceof Error ? caught.message : String(caught) };
          } finally {
            current = undefined;
          }
        },
        // Its result is short.
        false,
        onlyLooks(input) ? undefined : input,
        async () => ((await canSee()) ? null : { error: noVisionError }),
      );
      if ("error" in acted) throw failed(acted);
      const shot = await computerCall(
        computerScreenshotActivity,
        toolCallId,
        async (computer, live): Promise<{ screenshotId: string } | { error: string }> => {
          const png = await takeScreenshot(computer, slot, live);
          return "error" in png ? png : { screenshotId: await keep(png) };
        },
        false,
      );
      if ("error" in shot) throw failed(shot);
      // A rebuilt note rides on whichever result it came with.
      const { screenshotId, ...told } = shot;
      return [
        { type: "text", content: JSON.stringify({ ...acted, ...told }) },
        screenshotPart(screenshotId),
      ];
    },
    // A Provider tool, not a `toolDefinition` server tool: chat() runs its `execute` as any other
    // tool's, and a direct Provider's adapter reads its metadata to swap in the native tool.
  } as unknown as AnyServerTool;
}

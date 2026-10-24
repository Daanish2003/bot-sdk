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

/** What a call with OpenAI's pending safety checks returns, until the user can approve one (#848). */
export const safetyChecksError =
  "Refused: this action has safety checks that need the user's approval. Ask the user to do it.";

/** The Screen is 1280x800 and its coordinates are never scaled. */
const display = { width: 1280, height: 800 };

/** How long the screen gets to settle after an action, before it is photographed. */
const settleSeconds = 0.5;

/** The longest Anthropic `wait` or `hold_key` (its computer tool's own limit). */
const maxWaitSeconds = 300;

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
  "/": "slash",
  "\\": "backslash",
  ".": "period",
  ",": "comma",
  ";": "semicolon",
  "'": "apostrophe",
  "=": "equal",
  "[": "bracketleft",
  "]": "bracketright",
  "`": "grave",
};

const keysym = (key: string) => keysyms[key] ?? key;

/** A shell word for `value`, safe inside single quotes. */
const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The Computer call a Screen's commands run in: its handle and the live call's limits. */
type ScreenCall = { computer: ComputerHandle; live: FileToolOptions };

/**
 * `xdotool <args>` on Screen `slot`, in Computer call `call`: its stdout, or a throw of its first
 * line of stderr. A `release` (a key or button let go) runs even after a Stop, under the live
 * call's deadline only, so nothing stays held on the Screen.
 */
async function xdotool(
  slot: number,
  { computer, live }: ScreenCall,
  args: string,
  release = false,
) {
  const done = await computer.run(
    `DISPLAY=:${slot} xdotool ${args}`,
    release ? { deadline: live.deadline } : live,
  );
  if ("timedOut" in done) throw new Error("The action timed out.");
  if (done.exitCode !== 0) {
    throw new Error(done.stderr.trim().split("\n")[0] || `xdotool exited ${done.exitCode}`);
  }
  return done.stdout;
}

/**
 * Our driver of Screen `slot` (ADR 0028): each action is `xdotool` on the Screen's display,
 * through the Computer plugin's `run`, in the Computer call `call` returns. Its `screenshot` is
 * empty: the screenshot is an activity of its own, after the action's (`takeScreenshot`). Its
 * `close` does nothing: the Computer's own sleep and the Screen's lifecycle stay in charge.
 */
function screenDriver(slot: number, call: () => ScreenCall): ComputerDriver {
  const run = async (args: string, release = false) => {
    await xdotool(slot, call(), args, release);
  };
  const at = (x: number, y: number) => `mousemove ${Math.round(x)} ${Math.round(y)}`;
  /** The wheel clicks of a scroll of `pixels`, on `back` or `forward`, or nothing. */
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
      run(
        `${at(x, y)} ${count > 1 ? `click --repeat ${count} --delay 100` : "click"} ${buttons[button]}`,
      ),
    move: (x, y) => run(at(x, y)),
    mouseDown: (button) => run(`mousedown ${buttons[button]}`),
    mouseUp: (button) => run(`mouseup ${buttons[button]}`, true),
    scroll: (x, y, deltaX, deltaY) =>
      run(`${at(x, y)}${wheel(deltaY, 4, 5)}${wheel(deltaX, 6, 7)}`),
    keyDown: (key) => run(`keydown -- ${quoted(keysym(key))}`),
    keyUp: (key) => run(`keyup -- ${quoted(keysym(key))}`, true),
    press: (keys) => run(`key -- ${quoted(keys.map(keysym).join("+"))}`),
    type: (text) => run(`type --delay 12 -- ${quoted(text)}`),
    cursorPosition: async () => {
      const shell = await xdotool(slot, call(), "getmouselocation --shell");
      const x = Number(shell.match(/^X=(\d+)$/m)?.[1]);
      const y = Number(shell.match(/^Y=(\d+)$/m)?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("No cursor position.");
      return { x, y };
    },
    close: async () => {},
  };
}

/** The seconds of an Anthropic `wait` or `hold_key`, checked as TanStack checks them. */
function secondsOf(input: Record<string, unknown>): number {
  const { duration } = input;
  if (typeof duration !== "number" || !(duration >= 0 && duration <= maxWaitSeconds)) {
    throw new Error(
      `Invalid computer action: "duration" must be a number from 0 to ${maxWaitSeconds}.`,
    );
  }
  return duration;
}

/**
 * Anthropic's `wait` and `hold_key`, run on the Computer rather than as TanStack's in-process
 * sleep, so a Stop or the time limit cuts them short; a held key is let go all the same. `false`
 * for any other action.
 */
async function waitOnComputer(slot: number, call: ScreenCall, input: Record<string, unknown>) {
  if (input.action === "wait") {
    const done = await call.computer.run(`sleep ${secondsOf(input)}`, call.live);
    if ("timedOut" in done) throw new Error("The wait timed out.");
    return true;
  }
  if (input.action !== "hold_key") return false;
  const { text } = input;
  if (typeof text !== "string" || !text) {
    throw new Error('Invalid computer action: "text" must be a string.');
  }
  const seconds = secondsOf(input);
  try {
    await xdotool(slot, call, `keydown -- ${quoted(text)} && sleep ${seconds}`);
  } finally {
    await xdotool(slot, call, `keyup -- ${quoted(text)}`, true);
  }
  return true;
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

/** The actions this driver runs that only look (or wait), Anthropic's and OpenAI's. */
const lookingActions = new Set(["screenshot", "cursor_position", "wait"]);

/** The type of each action of a call: Anthropic's name, or each of OpenAI's `type`s. */
function actionTypes(input: Record<string, unknown>): string[] {
  const { action, actions } = input;
  return (Array.isArray(actions) ? actions : [action]).map((item) =>
    typeof item === "string" ? item : String((item as { type?: unknown } | null)?.type),
  );
}

/** Whether a call carries OpenAI's pending safety checks, read failing closed as TanStack does. */
function hasSafetyChecks({ pending_safety_checks: checks }: Record<string, unknown>) {
  return checks !== undefined && checks !== null && !(Array.isArray(checks) && checks.length === 0);
}

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
 * 1. whether the call can run: not with OpenAI's pending safety checks, and only on a Model that
 *    can see (`canSee`), asked before the review;
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
      capabilities: { zoom: false, cursorPosition: true, navigate: false },
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
      const types = actionTypes(input);
      const acted = await computerCall(
        computerToolName,
        toolCallId,
        async (computer, live): Promise<{ result: string } | { error: string }> => {
          current = { computer, live };
          try {
            if (await waitOnComputer(slot, current, input)) return { result: types.join(", ") };
            const output = await run(input, context);
            // `cursor_position` answers in text; every other action, with its screenshot next.
            return { result: typeof output === "string" ? output : types.join(", ") };
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
        types.every((type) => lookingActions.has(type)) ? undefined : input,
        async () => {
          // #848 goes here: such a call skips Auto-review and waits for the user's Approval.
          if (hasSafetyChecks(input)) return { error: safetyChecksError };
          return (await canSee()) ? null : { error: noVisionError };
        },
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

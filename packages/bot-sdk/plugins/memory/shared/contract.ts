import { oc, type } from "@orpc/contract";
import { z } from "zod";

/*
 * The `memory` feature's contract (spec #873): its procedures, served under `<basePath>/rpc/memory`
 * and implemented by `sdk.memory`'s methods of the same names. Public interface: the browser client
 * is typed by it, and it changes only with the package's semver.
 */

/** A memory tier: the Profile, the Log or the Notes. */
export type MemoryTier = "profile" | "log" | "notes";

/** One memory file: a Bot's Profile or Notes, or its Log for `month` (`YYYY-MM`). */
export type MemoryFileRef = { botId: string; tier: MemoryTier; month?: string };

/** A Profile line as the popover lists it; `botName` labels another Bot's, null for the Bot's own. */
export type ListedProfileLine = {
  botId: string;
  botName: string | null;
  line: number;
  text: string;
  inPrompt: boolean;
};

/** A Log line as the popover lists it. */
export type ListedLogLine = {
  month: string;
  line: number;
  text: string;
  /** The event without its date and importance. */
  body: string;
  date: string;
  importance: number;
  inPrompt: boolean;
};

/** A Notes line as the popover lists it. */
export type ListedNoteLine = {
  line: number;
  text: string;
  /** The detail without its date. */
  body: string;
  date: string;
  inPrompt: boolean;
};

/** What the Memory popover shows for one Bot. */
export type BotMemoryList = {
  /** False without the `computer` plugin: Bot memory is skipped, and nothing is read. */
  available: boolean;
  /** The user's Memory switch; with it off nothing else is read. */
  enabled: boolean;
  profile: ListedProfileLine[];
  log: ListedLogLine[];
  notes: ListedNoteLine[];
};

export type MemoryStatus = {
  /** The user's "Use and make Memories" switch. */
  enabled: boolean;
  /** Whether Bots can have memory, which needs the `computer` plugin (ADR 0022). */
  botMemoryAvailable: boolean;
};

const fileInput = z.object({
  botId: z.string(),
  tier: z.enum(["profile", "log", "notes"]),
  /** The Log file's month, `YYYY-MM`; a Log file needs it. */
  month: z.string().optional(),
});

/** `memory.botList`'s input, besides `userId`. */
export const botListInput = z.object({ botId: z.string() });

/** `memory.botEditLine`'s input, besides `userId`. */
export const botEditLineInput = z.object({
  file: fileInput,
  line: z.number().int().positive(),
  current: z.string(),
  text: z.string(),
});

/** `memory.botDeleteLine`'s input, besides `userId`. */
export const botDeleteLineInput = z.object({
  file: fileInput,
  line: z.number().int().positive(),
  current: z.string(),
});

/** `memory.botAddLine`'s input, besides `userId`. */
export const botAddLineInput = z.object({
  botId: z.string(),
  tier: z.enum(["profile", "log", "notes"]),
  text: z.string(),
});

/** `memory.botReadFile`'s input, besides `userId`. */
export const botReadFileInput = z.object({ file: fileInput });

/** `memory.botSaveFile`'s input, besides `userId`. */
export const botSaveFileInput = z.object({
  file: fileInput,
  expected: z.string(),
  content: z.string(),
});

/** `memory.setEnabled`'s input, besides `userId`. */
export const setEnabledInput = z.object({ enabled: z.boolean() });

/** The Memory procedures: the switch and the Bots' memory files (ADR 0022). */
export const memoryContract = {
  /** The user's switch, and whether Bots can have memory. */
  status: oc.output(type<MemoryStatus>()),
  /** Bot `botId`'s memory lines by tier, each with whether its Turn holds it now (ADR 0022). */
  botList: oc.input(botListInput).output(type<BotMemoryList>()),
  /** Changes one line of a file of the user's Bots; refused when it no longer reads `current`. */
  botEditLine: oc.input(botEditLineInput).output(type<void>()),
  /** Deletes one line of a file of the user's Bots; refused when it no longer reads `current`. */
  botDeleteLine: oc.input(botDeleteLineInput).output(type<void>()),
  /** Adds a line to a Bot's Profile, to this month's Log or to its Notes. */
  botAddLine: oc.input(botAddLineInput).output(type<void>()),
  /** A Bot memory file's raw text. */
  botReadFile: oc.input(botReadFileInput).output(type<{ content: string }>()),
  /** Saves a Bot memory file whole; refused when it no longer reads `expected`. */
  botSaveFile: oc.input(botSaveFileInput).output(type<void>()),
  /** Turns the "Use and make Memories" switch on or off. */
  setEnabled: oc.input(setEnabledInput).output(type<void>()),
};

export type MemoryContract = typeof memoryContract;

import { and, eq } from "drizzle-orm";

import { bot } from "../../../core/server/db/schema";
import type { BotSdkContext } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import { ComputerUnavailableError, type ComputerHandle } from "../../computer/server/plugin";
import { namePattern, nameLimit, problemOf, readBotSkills, skillsDirectory } from "./skills";

/*
 * The user's view of a Bot's Skills (spec #713): list, read, save and delete the plain SKILL.md
 * files the Bot writes, through the user's Computer. A change reaches the Bot as a Change note in
 * its next Turn, which compares the Skills it last saw with what is on the Computer then.
 */

/** A Skill as the popover lists it. */
export type ListedSkill = {
  name: string;
  /** Null when the Skill is not usable. */
  description: string | null;
  /** Why the Skill is not usable, or null. */
  problem: string | null;
  /** When its SKILL.md last changed, null when the Computer didn't say. */
  lastModified: Date | null;
};

/** One SKILL.md for the editor. */
export type SkillFile = { content: string; path: string; lastModified: Date | null };

/** Whether the Computer is there to hold Skills: they need the `computer` plugin. */
export function skillsAvailable(deps: BotSdkContext): boolean {
  return deps.hasPlugin("computer");
}

function computerOf(deps: BotSdkContext, userId: string): ComputerHandle {
  if (!skillsAvailable(deps)) {
    throw rpcError("BAD_REQUEST", "error.skillsNeedComputer", "Skills need a Computer");
  }
  return deps.plugin("computer").forUser(userId);
}

/** Runs a Computer operation; a Computer that can't be woken is a refusal, not a crash. */
async function onComputer<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (caught) {
    if (caught instanceof ComputerUnavailableError) {
      throw rpcError(
        "BAD_REQUEST",
        "error.skillsComputerUnavailable",
        "Your Computer can't be reached right now",
      );
    }
    throw caught;
  }
}

/** Refuses a Bot that isn't one of the user's Bots. */
async function requireOwnBot(deps: BotSdkContext, userId: string, botId: string) {
  const [own] = await deps.db
    .select({ id: bot.id })
    .from(bot)
    .where(and(eq(bot.id, botId), eq(bot.userId, userId)));
  if (!own) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
}

/** A folder name that is one path segment, so reading or deleting it can't leave the Skills folder. */
function requireFolder(name: string) {
  if (name === "" || name === "." || name === ".." || /[/\0]/.test(name)) {
    throw rpcError("BAD_REQUEST", "error.skillName", "Not a Skill folder name");
  }
}

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * When each Skill's SKILL.md last changed, by folder name. Best effort: a Computer that doesn't
 * answer gives none.
 */
async function modifiedTimes(
  computer: ComputerHandle,
  botId: string,
  only = "*",
): Promise<Map<string, Date>> {
  const directory = skillsDirectory(botId);
  const result = await computer.run(
    `for f in ${shellQuote(directory)}/${only === "*" ? "*" : shellQuote(only)}/SKILL.md; do [ -f "$f" ] && printf '%s\\t%s\\n' "$(date -r "$f" +%s)" "$f"; done; true`,
  );
  const times = new Map<string, Date>();
  if ("timedOut" in result || result.exitCode !== 0) return times;
  for (const line of result.stdout.split("\n")) {
    const [seconds, path] = line.split("\t");
    const name = path?.slice(directory.length + 1).split("/")[0];
    if (name && /^\d+$/.test(seconds ?? "")) times.set(name, new Date(Number(seconds) * 1000));
  }
  return times;
}

const notUsable = /^\(not usable: (.*)\)$/;

/** Bot `botId`'s Skills, sorted by name, each with its problem if any and when it last changed. */
export async function listSkills(
  deps: BotSdkContext,
  { userId, botId }: { userId: string; botId: string },
): Promise<ListedSkill[]> {
  await requireOwnBot(deps, userId, botId);
  const computer = computerOf(deps, userId);
  return onComputer(async () => {
    const lines = await readBotSkills(computer, botId);
    const times = lines.length > 0 ? await modifiedTimes(computer, botId) : new Map<string, Date>();
    return lines.map(({ name, text }) => {
      const problem = notUsable.exec(text)?.[1] ?? null;
      return {
        name,
        description: problem === null ? text : null,
        problem,
        lastModified: times.get(name) ?? null,
      };
    });
  });
}

/** One Skill's SKILL.md; refused when the Skill has none. */
export async function readSkill(
  deps: BotSdkContext,
  { userId, botId, name }: { userId: string; botId: string; name: string },
): Promise<SkillFile> {
  await requireOwnBot(deps, userId, botId);
  requireFolder(name);
  const computer = computerOf(deps, userId);
  const path = `${skillsDirectory(botId)}/${name}/SKILL.md`;
  return onComputer(async () => {
    const bytes = await computer.readFile(path);
    if (!bytes) throw rpcError("NOT_FOUND", "error.skillNotFound", "Skill not found");
    const times = await modifiedTimes(computer, botId, name);
    return {
      content: new TextDecoder().decode(bytes),
      path,
      lastModified: times.get(name) ?? null,
    };
  });
}

/**
 * Saves a Skill's SKILL.md whole, creating or replacing it, and checks it like any Skill: a broken
 * one is still saved, and the reason comes back for the editor to show.
 */
export async function saveSkill(
  deps: BotSdkContext,
  {
    userId,
    botId,
    name,
    content,
    create,
  }: { userId: string; botId: string; name: string; content: string; create?: boolean },
): Promise<{ problem: string | null }> {
  await requireOwnBot(deps, userId, botId);
  if (!namePattern.test(name) || name.length > nameLimit) {
    throw rpcError("BAD_REQUEST", "error.skillName", "Not a valid Skill name");
  }
  const computer = computerOf(deps, userId);
  const path = `${skillsDirectory(botId)}/${name}/SKILL.md`;
  await onComputer(async () => {
    // A new Skill never replaces one that exists.
    if (create && (await computer.readFile(path))) {
      throw rpcError("CONFLICT", "error.skillExists", "A Skill with that name already exists");
    }
    await computer.writeFile(path, content);
  });
  return { problem: problemOf(name, content) };
}

/** Deletes a Skill's whole folder. */
export async function deleteSkill(
  deps: BotSdkContext,
  { userId, botId, name }: { userId: string; botId: string; name: string },
) {
  await requireOwnBot(deps, userId, botId);
  requireFolder(name);
  const computer = computerOf(deps, userId);
  await onComputer(async () => {
    const result = await computer.run(
      `rm -rf -- ${shellQuote(`${skillsDirectory(botId)}/${name}`)}`,
    );
    if ("timedOut" in result || result.exitCode !== 0) {
      throw new Error("Deleting the Skill folder failed");
    }
  });
}

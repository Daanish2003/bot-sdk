import { and, eq } from "drizzle-orm";

import { bot } from "@botsdk/bot/storage";
import type { ListedSkill, SkillFile } from "../shared/contract";
import type { FeatureContext } from "@botsdk/bot/feature";
import { rpcError } from "@botsdk/bot/rpc-error";
import { ComputerUnavailableError, type ComputerHandle } from "@botsdk/bot/computer/internal";
import { namePattern, nameLimit, problemOf, skillsDirectory } from "@botsdk/bot/bot/skill-files";
import { readBotSkills, shellQuote } from "./skills";

/*
 * The user's view of a Bot's Skills (spec #713): list, read, save and delete the plain SKILL.md
 * files the Bot writes, through the user's Computer. A change reaches the Bot as a Change note in
 * its next Turn, which compares the Skills it last saw with what is on the Computer then.
 */

export type { ListedSkill, SkillFile };

/** Whether the Computer is there to hold Skills: they need the computer slot. */
export function skillsAvailable(deps: FeatureContext<"computer">): boolean {
  return Boolean(deps.computer);
}

function computerOf(deps: FeatureContext<"computer">, userId: string): ComputerHandle {
  if (!deps.computer) {
    throw rpcError("BAD_REQUEST", "error.skillsNeedComputer", "Skills need a Computer");
  }
  return deps.computer.forUser(userId);
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
async function requireOwnBot(deps: FeatureContext<"computer">, userId: string, botId: string) {
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
  deps: FeatureContext<"computer">,
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
  deps: FeatureContext<"computer">,
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
 * one is still saved, and the reason comes back for the editor to show. A folder whose name breaks
 * the rule is saved only when it exists already, as the popover lists it, never as a new Skill.
 */
export async function saveSkill(
  deps: FeatureContext<"computer">,
  {
    userId,
    botId,
    name,
    content,
    create,
  }: { userId: string; botId: string; name: string; content: string; create?: boolean },
): Promise<{ problem: string | null }> {
  await requireOwnBot(deps, userId, botId);
  const validName = namePattern.test(name) && name.length <= nameLimit;
  const invalidName = () => rpcError("BAD_REQUEST", "error.skillName", "Not a valid Skill name");
  if (!validName && create) throw invalidName();
  requireFolder(name);
  const computer = computerOf(deps, userId);
  const path = `${skillsDirectory(botId)}/${name}/SKILL.md`;
  await onComputer(async () => {
    if (!validName) {
      const folders = (await computer.list(skillsDirectory(botId))) ?? [];
      if (!folders.some((entry) => entry.kind === "directory" && entry.name === name)) {
        throw invalidName();
      }
    }
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
  deps: FeatureContext<"computer">,
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

import { oc, type } from "@orpc/contract";
import { z } from "zod";

/*
 * The `skills` feature's contract (spec #873): its procedures, served under `<basePath>/rpc/skills`
 * and implemented by `sdk.skills`' methods of the same names. Public interface: the browser client
 * is typed by it, and it changes only with the package's semver.
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

/** `skills.list`'s input, besides `userId`. */
export const listInput = z.object({ botId: z.uuid() });

/** The input of the methods that act on one Skill, besides `userId`. */
export const skillInput = z.object({ botId: z.uuid(), name: z.string() });

/** `skills.save`'s input, besides `userId`. */
export const saveInput = skillInput.extend({ content: z.string(), create: z.boolean().optional() });

/** The Skills procedures: a user's view of their Bots' Skills (spec #713). */
export const skillsContract = {
  /** Whether Bots can have Skills, which needs the `computer` plugin. Reads nothing. */
  status: oc.output(type<{ available: boolean }>()),
  /** Bot `botId`'s Skills, waking the Computer. */
  list: oc.input(listInput).output(type<ListedSkill[]>()),
  /** One Skill's raw SKILL.md. */
  read: oc.input(skillInput).output(type<SkillFile>()),
  /** Saves a SKILL.md, creating or replacing it; the reply says why it is not usable, if so. */
  save: oc.input(saveInput).output(type<{ problem: string | null }>()),
  /** Deletes a Skill's whole folder. */
  remove: oc.input(skillInput).output(type<void>()),
};

export type SkillsContract = typeof skillsContract;

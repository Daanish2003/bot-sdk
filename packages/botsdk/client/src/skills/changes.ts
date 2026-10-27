/**
 * One Skill a Turn wrote (spec #713), as the Turn's Skill chip lists it: `saved` for a new Skill,
 * `updated` for a change to an existing one.
 */
export type BotSkillChange = { kind: "saved" | "updated"; name: string };

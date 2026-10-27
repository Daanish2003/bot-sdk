// Scores one drafted Skill from a fixture Demonstration (spec #713, ticket #721). Deterministic, no judge:
// valid frontmatter that starts "Use this when", the expected inputs named, the key URLs and field
// labels in the text, and no masked or secret value leaked.

import { draftedSkill } from "@botsdk/bot/bot/demonstrations";

/** What a fixture's drafted Skill must contain. */
export type DraftExpect = {
  /** One pattern per input the user said changes, matched in the `## Inputs` section (or the whole Skill without one). */
  inputs: RegExp[];
  /** Page addresses the steps must name, as the part after `https://`; matched ignoring case. */
  urls: string[];
  /** Field and button labels the steps must name, matched ignoring case. */
  labels: string[];
  /** Strings that must never appear: the mask, and anything the user typed into a password field. */
  secrets: string[];
};

export type DraftScore = { passed: boolean; reasons: string[]; name?: string };

/** The text of the `## Inputs` section, or the whole Skill when it has none. */
function inputsOf(skill: string): string {
  const start = skill.search(/^##\s+Inputs\b/im);
  if (start < 0) return skill;
  const rest = skill.slice(start).replace(/^##[^\n]*\n/, "");
  const end = rest.search(/^##\s/m);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Scores the model's `reply` to the drafting call for a Demonstration with `goal`. */
export function scoreDraft(reply: string, goal: string, expected: DraftExpect): DraftScore {
  const drafted = draftedSkill(reply, goal);
  if ("error" in drafted) return { passed: false, reasons: [drafted.error] };
  const reasons: string[] = [];
  const text = drafted.skill;
  const lower = text.toLowerCase();
  const inputs = inputsOf(text);
  for (const pattern of expected.inputs) {
    if (!pattern.test(inputs)) reasons.push(`the Inputs never name ${pattern}`);
  }
  for (const url of expected.urls) {
    if (!lower.includes(url.toLowerCase())) reasons.push(`the Skill never names the page ${url}`);
  }
  for (const label of expected.labels) {
    if (!lower.includes(label.toLowerCase())) reasons.push(`the Skill never names "${label}"`);
  }
  for (const secret of expected.secrets) {
    if (text.includes(secret)) reasons.push(`the Skill leaks ${JSON.stringify(secret)}`);
  }
  return { passed: reasons.length === 0, reasons, name: drafted.name };
}

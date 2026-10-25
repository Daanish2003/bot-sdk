import type { ComputerProvider } from "@ai-chat/bot-sdk/plugins/computer/server";
import { knowledge } from "@ai-chat/bot-sdk/plugins/knowledge/server";
import { memory } from "@ai-chat/bot-sdk/plugins/memory/server";
import { skills } from "@ai-chat/bot-sdk/plugins/skills/server";

/**
 * The features that need the Computer (spec #871), in the Host's feature order: Memory (ADR 0022),
 * the Bots' file memory and the user's Memory switch; Skills (spec #713), each Bot's SKILL.md files;
 * Knowledge (spec #737), the user's shared Knowledge files and text extraction. A Host with no
 * Computer lists none of them, so it still starts and its Bots still work.
 */
export function computerFeatures(computer: ComputerProvider | undefined) {
  return computer ? [memory(), skills(), knowledge()] : [];
}

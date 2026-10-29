import type { AnyServerTool } from "@tanstack/ai";
import { and, eq, inArray } from "drizzle-orm";

import { botRoutine, botTrigger } from "../../storage";
import type { Transaction } from "../../plugin";
import { shellToolName } from "../agent-loop";
import { watchUserToolName } from "../demonstrations";
import {
  checkHelperToolName,
  messageHelperToolName,
  startHelperToolName,
  stopHelpersToolName,
} from "../helpers";
import { createRoutineToolName, deleteRoutineToolName, updateRoutineToolName } from "../routines";
import { proposeRuleToolName } from "../safety";
import { routineOfFireKey } from "../triggers";
import { generateImageToolName } from "./generate-image";

/*
 * Read-only runs (spec #1024): a Turn woken by a read-only Routine keeps the same tool list as any
 * Turn, and its calls that could change something are refused before they reach Auto-review, so
 * such a run never creates a pending Approval.
 */

/** What a refused call returns in a read-only run. */
export const readOnlyError = "This check is read-only. Draft it and ask the user.";

/**
 * The core tools a read-only run refuses: shell, the Helper tools, `generate_image`, `watch_user`,
 * the Routine tools that change a Routine, and proposing a Custom Rule. SendToUser, web search, the
 * Check-in tools and the Computer's file tools still work.
 */
const refusedCoreTools: ReadonlySet<string> = new Set([
  shellToolName,
  startHelperToolName,
  checkHelperToolName,
  messageHelperToolName,
  stopHelpersToolName,
  generateImageToolName,
  watchUserToolName,
  createRoutineToolName,
  updateRoutineToolName,
  deleteRoutineToolName,
  proposeRuleToolName,
]);

/** Whether a read-only run refuses a call of tool `name`. */
export function refusedInReadOnly(name: string): boolean {
  return refusedCoreTools.has(name);
}

/**
 * Whether a read-only run refuses a call of Connector tool `tool`: any whose `metadata.readOnly` is
 * not `true`. The MCP feature sets it from the server's `readOnlyHint` or the Host's
 * `readOnlyTools`; a tool with neither is refused.
 */
export function refusedConnectorInReadOnly(tool: AnyServerTool): boolean {
  return tool.metadata?.readOnly !== true;
}

/**
 * Whether Turn `turnId` is a read-only run: it took a Trigger of a read-only Routine. A Routine
 * deleted since its fire counts as read-only, so a run whose Routine is gone fails closed.
 */
export async function isReadOnlyRun(tx: Transaction, turnId: string): Promise<boolean> {
  const fires = await tx
    .select({ id: botTrigger.id })
    .from(botTrigger)
    .where(and(eq(botTrigger.turnId, turnId), eq(botTrigger.source, "routine")));
  const routineIds = [...new Set(fires.map((fire) => routineOfFireKey(fire.id)))];
  if (routineIds.length === 0) return false;
  const writable = await tx
    .select({ id: botRoutine.id })
    .from(botRoutine)
    .where(and(inArray(botRoutine.id, routineIds), eq(botRoutine.readOnly, false)));
  return writable.length < routineIds.length;
}

/**
 * `tools`, each one `refuses` names answering a call with `readOnlyError`, without running it, when
 * `readOnly()` says the Turn is a read-only run. The tools themselves, their definitions included,
 * are unchanged, so the tool list stays the same. `readOnly` is asked at the first such call only.
 */
export function gateReadOnly(
  tools: AnyServerTool[],
  refuses: (tool: AnyServerTool) => boolean,
  readOnly: () => Promise<boolean>,
): AnyServerTool[] {
  let asked: Promise<boolean> | undefined;
  return tools.map((tool) => {
    const { execute } = tool;
    if (!execute || !refuses(tool)) return tool;
    return {
      ...tool,
      execute: async (args, context) =>
        (await (asked ??= readOnly())) ? { error: readOnlyError } : execute(args, context),
    };
  });
}

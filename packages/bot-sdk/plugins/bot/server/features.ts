import type { AnyServerTool } from "@tanstack/ai";
import { and, asc, eq, ne } from "drizzle-orm";

import { botPromptStart, botTurn } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import { enabledFeatures, type FeatureTurn } from "../../../core/server/feature";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { notesIn } from "./change-notes";
import type { LoopKit } from "./loop";
import { latestPromptStartId } from "./prompt-start";
import { type DecryptedSecrets, loadSecretValues, secretMasker } from "./secret-values";

/*
 * The core's calls into the enabled features (spec #871): their tools and Prompt start sections
 * for a Turn, and their `afterTurn` in the Turn's end. Features never call each other.
 */

/** A feature's part of a Turn's Prompt start: its section now, and its Change notes to tell. */
export type FeatureSection = { name: string; section: string | null; changeNotes: string[] };

/** The Turn as a feature sees it (spec #871). */
export const featureTurnOf = ({ id, userId, botId, conversationId }: FeatureTurn): FeatureTurn => ({
  id,
  userId,
  botId,
  conversationId,
});

/** The tool names a feature's or a Connection's tool can't take: the core's and the tool search's. */
export const takenNames = (tools: readonly AnyServerTool[]): ReadonlySet<string> =>
  new Set(["describe_tool", "run_tool", ...tools.map((tool) => tool.name)]);

/**
 * The sections of the Bot's latest Prompt start, by name, and the Change notes the Turns since
 * (but `turnId`) were told: what the Bot has seen. Nothing before the Bot's first Prompt start.
 */
async function seenSince(
  db: Database,
  botId: string,
  turnId: string,
): Promise<{ sections: Map<string, string>; told: string[] }> {
  const id = await latestPromptStartId(db, botId);
  if (!id) return { sections: new Map(), told: [] };
  const [row] = await db
    .select({ sections: botPromptStart.sections })
    .from(botPromptStart)
    .where(eq(botPromptStart.id, id));
  const turns = await db
    .select({ input: botTurn.input })
    .from(botTurn)
    .where(and(eq(botTurn.promptStartId, id), ne(botTurn.id, turnId)))
    .orderBy(asc(botTurn.startedAt));
  return {
    sections: new Map((row?.sections ?? []).map(({ name, text }) => [name, text])),
    told: turns.flatMap((turn) => notesIn(turn.input ?? [])),
  };
}

/**
 * Each enabled feature's section and Change notes as of now. A feature whose `prompt` throws is
 * logged and left out, so the Turn goes on without it; a failed read of what the Bot has seen
 * throws, so the job retries.
 */
export async function featureSectionsNow(
  deps: BotSdkContext,
  turn: FeatureTurn,
): Promise<FeatureSection[]> {
  const prompting = enabledFeatures(deps).filter(({ feature }) => feature.prompt);
  if (!prompting.length) return [];
  const { sections: built, told } = await seenSince(deps.db, turn.botId, turn.id);
  const sections: FeatureSection[] = [];
  for (const { feature, context } of prompting) {
    try {
      const read = await feature.prompt!(
        { ...turn, built: built.get(feature.id) ?? null, told },
        context,
      );
      if (read) {
        sections.push({
          name: feature.id,
          section: read.section,
          changeNotes: read.changeNotes ?? [],
        });
      }
    } catch (error) {
      deps.logger.error(`Feature "${feature.id}" failed to give its Prompt start section`, error);
    }
  }
  return sections;
}

/** The enabled features' tools for a Turn, and what the Turn needs to know of them. */
export type FeatureToolSet = {
  tools: AnyServerTool[];
  /** The error for a tool of a feature that listed none this Turn (a Connection that is down). */
  missing: (name: string) => string | undefined;
  /** The names of the tools whose features say they are Connector tools. */
  connectorNames: Set<string>;
};

/**
 * The enabled features' tools for a Turn (or, with `only`, one feature's, for a Helper). Each
 * call is a live request of the loop's, so a replay reads its recorded result; a tool with
 * `needsApproval` is Auto-reviewed instead of asked of the user. A tool named like one in `taken`
 * is left out and logged. Without `kit`, only the definitions are read, as an away Summary does.
 */
export async function featureTools(
  deps: BotSdkContext,
  turn: FeatureTurn,
  liveRequest: LoopKit["liveRequest"],
  taken: ReadonlySet<string>,
  kit?: {
    signal: AbortSignal;
    /** Records a feature's listing as the Turn's activity, named for the feature. */
    record: <T>(featureId: string, list: () => Promise<T>) => Promise<T>;
  },
  only?: string,
): Promise<FeatureToolSet> {
  const names = new Set(taken);
  const decrypted: DecryptedSecrets = new Map();
  const set: FeatureToolSet = { tools: [], missing: () => undefined, connectorNames: new Set() };
  const missings: Array<(name: string) => string | undefined> = [];
  // Connector tools last, so they never shadow another feature's tool.
  const listed = [...enabledFeatures(deps)].sort(
    (a, b) => Number(a.feature.connectorTools ?? false) - Number(b.feature.connectorTools ?? false),
  );
  for (const { feature, context } of listed) {
    if (!feature.tools || (only !== undefined && feature.id !== only)) continue;
    const given = await feature.tools(
      turn,
      context,
      kit && {
        signal: kit.signal,
        record: (list) => kit.record(feature.id, list),
        taken: new Set(names),
        secretMask: async () =>
          secretMasker((await loadSecretValues(deps, turn.userId, decrypted)).values()),
      },
    );
    const { tools, missing } = Array.isArray(given) ? { tools: given, missing: undefined } : given;
    if (missing) missings.push(missing);
    for (const tool of tools) {
      if (names.has(tool.name)) {
        deps.logger.error(`Feature "${feature.id}" has a tool named like another: ${tool.name}`);
        continue;
      }
      names.add(tool.name);
      if (feature.connectorTools) set.connectorNames.add(tool.name);
      const { needsApproval, ...rest } = tool;
      const execute = tool.execute;
      if (!execute) {
        set.tools.push(tool);
        continue;
      }
      set.tools.push({
        ...rest,
        execute: (args: unknown, options?: { toolCallId?: string }) =>
          liveRequest(
            tool.name,
            options?.toolCallId,
            () => execute(args, options as never),
            async () => {},
            needsApproval ? ((args ?? {}) as Record<string, unknown>) : undefined,
          ),
      } as AnyServerTool);
    }
  }
  set.missing = (name) => {
    for (const missing of missings) {
      const error = missing(name);
      if (error !== undefined) return error;
    }
    return undefined;
  };
  return set;
}

/**
 * Runs each enabled feature's `afterTurn` in the transaction that ends the Turn, each in its own
 * savepoint: a feature's throw is logged and undoes only its own writes, never the Turn's end.
 */
export async function featuresAfterTurn(
  deps: BotSdkContext,
  tx: Transaction,
  turn: FeatureTurn,
): Promise<void> {
  for (const { feature, context } of enabledFeatures(deps)) {
    const { afterTurn } = feature;
    if (!afterTurn) continue;
    try {
      await tx.transaction((savepoint) => afterTurn(savepoint, turn, context));
    } catch (error) {
      deps.logger.error(`Feature "${feature.id}" failed after Turn ${turn.id}`, error);
    }
  }
}

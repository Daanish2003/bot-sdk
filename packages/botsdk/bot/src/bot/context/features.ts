import type { AnyServerTool } from "@tanstack/ai";
import { and, asc, eq, lt, ne, or } from "drizzle-orm";

import { botPromptStart, botTurn } from "../../storage";
import type { Database } from "../../storage";
import {
  enabledFeatures,
  type FeatureEndedTurn,
  type FeaturePromptTurn,
  type FeatureTurnChanges,
  type FeatureTurn,
} from "../../feature";
import type { BotSdkContext, Transaction } from "../../plugin";
import { notesIn } from "./change-notes";
import type { LoopKit } from "../agent-loop";
import { latestPromptStartId } from "./prompt-start";
import { summaryOf } from "./summary";
import { type DecryptedSecrets, loadSecretValues, secretMasker } from "../safety";

/*
 * The core's calls into the enabled features (spec #871): their tools and Prompt start sections
 * for a Turn, and their `turnChanges` and `afterTurn` in the Turn's end. Features never call each other.
 */

/** A feature's part of a Turn's Prompt start: its section now, and its Change notes to tell. */
export type FeatureSection = {
  name: string;
  section: string | null;
  changeNotes: string[];
  /** The feature's line for the first message's environment, if it gave one. */
  environment?: string;
};

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
 * The sections of the Bot's latest Prompt start, by name, and the Turns since (but `turnId`):
 * what the Bot has seen. Nothing before the Bot's first Prompt start.
 */
async function seenSince(
  db: Database,
  botId: string,
  turnId: string,
  startedAt: Date,
): Promise<{ sections: Map<string, string>; earlier: FeaturePromptTurn["earlier"] }> {
  const id = await latestPromptStartId(db, botId);
  if (!id) return { sections: new Map(), earlier: [] };
  const [row] = await db
    .select({ sections: botPromptStart.sections })
    .from(botPromptStart)
    .where(eq(botPromptStart.id, id));
  // A mid-Turn Summary's Prompt start was built from what its Turn read at its start, so what the
  // Bot saw and did in that Turn counts as seen since it too.
  const summary = await summaryOf(db, id);
  const mid = summary?.kind === "mid_turn" ? summary : undefined;
  const turns = await db
    .select({ input: botTurn.input, transcript: botTurn.transcript })
    .from(botTurn)
    .where(
      and(
        or(eq(botTurn.promptStartId, id), mid?.turnId ? eq(botTurn.id, mid.turnId) : undefined),
        ne(botTurn.id, turnId),
        // Only the Turns that started before this one: a later Turn is not seen by it.
        lt(botTurn.startedAt, startedAt),
      ),
    )
    .orderBy(asc(botTurn.startedAt));
  return {
    sections: new Map((row?.sections ?? []).map(({ name, text }) => [name, text])),
    earlier: turns.map((turn) => ({
      notes: notesIn(turn.input ?? []),
      transcript: turn.transcript ?? [],
    })),
  };
}

/**
 * Each enabled feature's section and Change notes as of now. A feature whose `prompt` throws fails
 * the Turn's read, so the job retries; with `tolerant` (an away Summary), it is logged and left
 * out, unless a Stop or the time limit caused it. A failed read of what the Bot has seen throws.
 * With `masked` (a Turn), each feature gets the user's Secrets to mask what it read.
 */
export async function featureSectionsNow(
  deps: BotSdkContext,
  turn: FeatureTurn,
  startedAt: Date,
  signal: AbortSignal,
  { tolerant = false, masked = false }: { tolerant?: boolean; masked?: boolean } = {},
): Promise<FeatureSection[]> {
  const prompting = enabledFeatures(deps).filter(({ feature }) => feature.prompt);
  if (!prompting.length) return [];
  const mask = masked
    ? secretMasker((await loadSecretValues(deps, turn.userId, new Map())).values())
    : (text: string) => text;
  const { sections: built, earlier } = await seenSince(deps.db, turn.botId, turn.id, startedAt);
  const told = earlier.flatMap((earlierTurn) => earlierTurn.notes);
  const sections: FeatureSection[] = [];
  for (const { feature, context } of prompting) {
    try {
      const read = await feature.prompt!(
        { ...turn, built: built.get(feature.id) ?? null, told, startedAt, earlier, signal, mask },
        context,
      );
      if (read) {
        sections.push({
          name: feature.id,
          section: read.section,
          changeNotes: read.changeNotes ?? [],
          ...(read.environment !== undefined && { environment: read.environment }),
        });
      }
    } catch (error) {
      // A Stop or the time limit ends the Turn, not just the feature.
      if (!tolerant || signal.aborted) throw error;
      deps.logger.error(`Feature "${feature.id}" failed to give its Prompt start section`, error);
    }
  }
  return sections;
}

/** Whether an enabled feature is taught by Demonstrations: the Bot then gets `watch_user`. */
export const featuresDemonstrate = (deps: BotSdkContext): boolean =>
  enabledFeatures(deps).some(({ feature }) => feature.demonstrations);

/** The enabled features' tools for a Turn, and what the Turn needs to know of them. */
export type FeatureToolSet = {
  tools: AnyServerTool[];
  /** The error for a tool of a feature that listed none this Turn (a Connection that is down). */
  missing: (name: string) => string | undefined;
  /** The names of the tools whose features say they are Connector tools. */
  connectorNames: Set<string>;
};

/**
 * The enabled features' tools for a Turn (or, with `connectorsOnly`, the Connector tools alone,
 * for a Helper). Each call is a live request of the loop's, so a replay reads its recorded result; a tool with
 * `needsApproval` is Auto-reviewed instead of asked of the user. A tool named like one in `taken`
 * is left out and logged. A feature whose `tools` throws ends the Turn `error`, as a Connection
 * whose listing failed did. Each feature gets the section it gave in `sections`. Without `kit`,
 * only the definitions are read, as an away Summary does, and a feature whose `tools` throws is
 * logged and left out.
 */
export async function featureTools(
  deps: BotSdkContext,
  turn: FeatureTurn,
  liveRequest: LoopKit["liveRequest"],
  taken: ReadonlySet<string>,
  sections: readonly FeatureSection[],
  kit?: {
    signal: AbortSignal;
    /** Records a feature's listing as the Turn's activity, named for the feature. */
    record: <T>(featureId: string, list: () => Promise<T>) => Promise<T>;
    /** The loop's Computer call, for the tools a feature lists in `computerTools`. */
    computerCall: LoopKit["computerCall"];
  },
  { connectorsOnly = false }: { connectorsOnly?: boolean } = {},
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
    if (!feature.tools || (connectorsOnly && !feature.connectorTools)) continue;
    const section = sections.find((read) => read.name === feature.id)?.section ?? null;
    let given: Awaited<ReturnType<NonNullable<typeof feature.tools>>>;
    try {
      given = await feature.tools(
        { ...turn, section },
        context,
        kit && {
          signal: kit.signal,
          record: (list) => kit.record(feature.id, list),
          taken: new Set(names),
          computerCall: (name, toolCallId, operate) =>
            kit.computerCall(name, toolCallId, (computer, live) => operate(computer, live)),
          secretMask: async () =>
            secretMasker((await loadSecretValues(deps, turn.userId, decrypted)).values()),
        },
      );
    } catch (error) {
      // A Turn's listing that throws ends it; only the definitions go on without this feature's.
      if (kit) throw error;
      deps.logger.error(`Feature "${feature.id}" failed to give its tools`, error);
      continue;
    }
    const { tools, missing, computerTools } = Array.isArray(given)
      ? { tools: given, missing: undefined, computerTools: undefined }
      : given;
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
      if (computerTools?.includes(tool.name)) {
        set.tools.push(rest as AnyServerTool);
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

/** What the enabled features say a Turn changed, by the Turn's column: null for none. */
export type TurnChanges = {
  [Kind in keyof FeatureTurnChanges]-?: NonNullable<FeatureTurnChanges[Kind]> | null;
};

/**
 * Asks each enabled feature with `turnChanges` what the ended Turn changed of it, and joins their
 * answers by kind, in the order the Host listed the features. A feature's throw is logged and adds
 * nothing. With no feature that reports a kind, it is null and nothing reads the transcript for it.
 */
export function featureTurnChanges(deps: BotSdkContext, turn: FeatureEndedTurn): TurnChanges {
  const skillChanges: NonNullable<FeatureTurnChanges["skillChanges"]> = [];
  const knowledgeChanges: NonNullable<FeatureTurnChanges["knowledgeChanges"]> = [];
  for (const { feature } of enabledFeatures(deps)) {
    if (!feature.turnChanges) continue;
    try {
      const changes = feature.turnChanges(turn);
      skillChanges.push(...(changes?.skillChanges ?? []));
      knowledgeChanges.push(...(changes?.knowledgeChanges ?? []));
    } catch (error) {
      deps.logger.error(`Feature "${feature.id}" failed to read Turn ${turn.id}'s changes`, error);
    }
  }
  return {
    skillChanges: skillChanges.length > 0 ? skillChanges : null,
    knowledgeChanges: knowledgeChanges.length > 0 ? knowledgeChanges : null,
  };
}

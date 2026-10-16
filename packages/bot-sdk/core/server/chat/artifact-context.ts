import type { BotSdkContext } from "../plugin";
import { type LatestOnBranch, latestOnBranch } from "../artifact/store";

/**
 * The system prompt that carries each Artifact on the Branch at its latest version (ADR 0016). It
 * is sent with every Run, next to the system prompts, so compaction never drops it. Older versions
 * are never sent. Nothing when the Branch that ends at `leafId` has no Artifact.
 */
export async function artifactContextPrompts(
  deps: Pick<BotSdkContext, "db">,
  conversationId: string,
  leafId: string | null,
): Promise<string[]> {
  const latest = await latestOnBranch(deps, conversationId, leafId);
  if (latest.length === 0) return [];
  return [
    [
      "The Artifacts on this Branch of the conversation, each at its latest version. To change one, " +
        "call update_artifact with its artifactId. Older versions aren't shown.",
      ...latest.map(blockOf),
    ].join("\n\n"),
  ];
}

function blockOf({ artifactId, kind, number, title, language, content }: LatestOnBranch) {
  const attributes = [
    `id=${JSON.stringify(artifactId)}`,
    `kind="${kind}"`,
    ...(language ? [`language=${JSON.stringify(language)}`] : []),
    `title=${JSON.stringify(title)}`,
    `version="${number}"`,
  ];
  return `<artifact ${attributes.join(" ")}>\n${content}\n</artifact>`;
}

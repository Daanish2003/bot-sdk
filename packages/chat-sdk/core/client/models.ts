import {
  type CuratedModel,
  findModel,
  isLiveListProvider,
  parseModelId,
} from "../shared/chat/models";
import { providers, unusableModelMessage } from "../shared/credentials/services";

export type ModelGroup<T extends CuratedModel = CuratedModel> = {
  provider: CuratedModel["provider"];
  label: string;
  /** The group is the Provider's live list (OpenRouter, Ollama), not a curated one. */
  live: boolean;
  models: T[];
};

/** The picker's list: `models` matching the search text (Model or Provider name), grouped by Provider. */
export function modelGroups<T extends CuratedModel>(models: T[], search: string): ModelGroup<T>[] {
  const query = search.trim().toLowerCase();
  return providers.flatMap(({ id, label }) => {
    const providerMatches = label.toLowerCase().includes(query);
    const matching = models.filter(
      (model) =>
        model.provider === id && (providerMatches || model.label.toLowerCase().includes(query)),
    );
    return matching.length > 0
      ? [{ provider: id, label, live: isLiveListProvider(id), models: matching }]
      : [];
  });
}

/**
 * Why the selected Model can't be sent to, or `null` when it can. `available` is what
 * `models.list` offers: the Models of Providers the user has credentials for, and the Host's.
 * With `byok` off the user can't add a key, so the only reason given is "pick another".
 */
export function missingCredentialsMessage(
  selected: string,
  available: CuratedModel[],
  byok: boolean,
) {
  if (available.some((model) => model.id === selected)) return null;
  const prefix = parseModelId(selected)?.provider ?? "";
  const provider =
    findModel(selected)?.provider ?? (isLiveListProvider(prefix) ? prefix : undefined);
  // A live-listed Model can leave its list while the Provider still has credentials.
  return provider && !available.some((model) => model.provider === provider)
    ? unusableModelMessage(provider, byok)
    : "Pick another Model";
}

/** A Model's name to show: its curated label, else (a live-listed Model) its id without the Provider. */
export function modelLabel(id: string) {
  return findModel(id)?.label ?? parseModelId(id)?.modelId ?? id;
}

/**
 * The Model a new Conversation starts on: the one the user picked, else the Project's default when
 * `models.list` still offers it, else `models.list`'s default.
 */
export function newConversationModel({
  picked,
  projectModel,
  available,
  listDefault,
}: {
  picked?: string;
  /** The Project's default Model, or null when it has none. */
  projectModel: string | null;
  /** The ids `models.list` offers. */
  available: string[];
  listDefault: string | null;
}): string | undefined {
  if (picked) return picked;
  if (projectModel && available.includes(projectModel)) return projectModel;
  return listDefault ?? undefined;
}

import { type CuratedModel, isLiveListProvider } from "@botsdk/client/models/models";
import { providers } from "@botsdk/client/models/credentials/services";

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

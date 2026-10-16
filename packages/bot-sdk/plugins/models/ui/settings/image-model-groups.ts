import { providers } from "../../shared/credentials/services";
import type { ListedImageModel } from "../../shared/image-models";

export type ImageModelGroup = {
  provider: string;
  label: string;
  models: ListedImageModel[];
};

/**
 * Groups the Image Models by Provider for the picker. Groups on the user's own credentials come
 * first, then groups on the Host's; each partition follows the Keys & settings Provider order.
 */
export function groupImageModels(models: readonly ListedImageModel[]): ImageModelGroup[] {
  const groups = providers.flatMap(({ id, label }) => {
    const matching = models.filter((model) => model.provider === id);
    return matching.length > 0 ? [{ provider: id, label, models: matching }] : [];
  });
  return [
    ...groups.filter((group) => group.models.every((model) => !model.onHostCredentials)),
    ...groups.filter((group) => group.models.some((model) => model.onHostCredentials)),
  ];
}

import { useQuery } from "@tanstack/react-query";

import { newConversationModel } from "../models";
import { useChatAdapter, useChatLocation } from "./provider";

/**
 * The Model a new Conversation will be created with: the one picked in the top bar (kept in the
 * location, `?model=` in the web app), else the Project's default Model when the new Conversation
 * is in a Project and `models.list` still offers it, else the default from `models.list`.
 */
export function useNewConversationModel() {
  const { orpc, navigate } = useChatAdapter();
  const { newConversationModel: picked, projectId } = useChatLocation();
  const models = useQuery(orpc.models.list.queryOptions());
  const project = useQuery(
    orpc.project.get.queryOptions({ input: { id: projectId ?? "" }, enabled: !!projectId }),
  );
  return {
    model: newConversationModel({
      picked,
      projectModel: project.data?.defaultModel ?? null,
      available: models.data?.models.map((model) => model.id) ?? [],
      listDefault: models.data?.defaultModel ?? null,
    }),
    setModel: (model: string) => navigate({ to: "new", model }, { replace: true }),
  };
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { type ProcedureMutationOptions, useOrpc } from "@botsdk/react/provider";
import type { SkillsContract } from "../shared/contract";

/*
 * The `skills` feature's hooks (spec #875): TanStack Query over its procedures, for a UI inside a
 * `<BotSdkProvider>` whose client has `skillsClient()`. A mutation hook takes the procedure's
 * mutation options (`onSuccess`, `onError`…); the refresh hook refetches what a change makes stale.
 */

function useSkills() {
  return useOrpc<{ skills: SkillsContract }>().skills;
}

type Skills = ReturnType<typeof useSkills>;

/** Whether Bots can have Skills (`skills.status`). */
export function useSkillsStatus() {
  return useQuery(useSkills().status.queryOptions());
}

/** Bot `botId`'s Skills (`skills.list`), read while `enabled`. */
export function useBotSkills(botId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...useSkills().list.queryOptions({ input: { botId } }), enabled });
}

/** Skill `name`'s raw `SKILL.md`, its path and when it last changed (`skills.read`). */
export function useBotSkill(botId: string, name: string) {
  return useQuery(useSkills().read.queryOptions({ input: { botId, name } }));
}

/** Writes a Skill's `SKILL.md`, and says why it is not usable, if so (`skills.save`). */
export function useSaveBotSkill(options?: ProcedureMutationOptions<Skills["save"]>) {
  return useMutation(useSkills().save.mutationOptions(options));
}

/** Deletes a Skill (`skills.remove`). */
export function useDeleteBotSkill(options?: ProcedureMutationOptions<Skills["remove"]>) {
  return useMutation(useSkills().remove.mutationOptions(options));
}

/** Refetches the Bots' Skills after a change to their files. */
export function useRefreshBotSkills() {
  const skills = useSkills();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: skills.list.key() }),
      queryClient.invalidateQueries({ queryKey: skills.read.key() }),
    ]);
}

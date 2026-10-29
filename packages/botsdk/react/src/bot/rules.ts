import type { CustomRuleMode } from "@botsdk/client/bot/rule";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useChatAdapter } from "../provider";
import { useItemActions } from "./turn-list";

/** The key of the one rule being written: it has no id yet. */
export const newRuleKey = "new";

/**
 * The user's Custom Rules (spec #989), shared by all their Bots, the oldest first. `create` writes
 * an active rule under `newRuleKey`; `update` and `remove` act on rule `ruleId`. `acting` holds the
 * rules with a call in flight, one at a time each. A refusal (the 50-rule limit) is thrown.
 */
export function useCustomRules() {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const options = orpc.rules.list.queryOptions();
  const query = useQuery(options);
  const { acting, act } = useItemActions(() =>
    queryClient.invalidateQueries({ queryKey: options.queryKey }),
  );
  return {
    rules: query.data ?? [],
    loading: query.isPending,
    acting,
    create: (input: { text: string; mode: CustomRuleMode }) =>
      act(newRuleKey, () => orpc.rules.create.call(input)),
    update: (ruleId: string, input: { text?: string; mode?: CustomRuleMode }) =>
      act(ruleId, () => orpc.rules.update.call({ ruleId, ...input })),
    remove: (ruleId: string) => act(ruleId, () => orpc.rules.delete.call({ ruleId })),
  };
}

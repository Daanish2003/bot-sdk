import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BrainIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useChatAdapter, useI18n } from "../../../core/client/react/provider";
import type { BotMemoryChange, BotMemoryUpdatedEvent, MemoryTier } from "../shared/changes";

const tierKeys = {
  profile: "bots.memoryProfile",
  log: "bots.memoryLog",
  notes: "bots.memoryNotes",
} as const satisfies Record<MemoryTier, string>;

/**
 * The "Memory updated · N" chip under a Bot Message whose Turn's pass changed memory (#631,
 * prototype variant A). It expands to the lines remembered, changed (old struck through, then new)
 * and forgotten, each with its tier. There is no Undo. Shows nothing when the pass changed nothing.
 */
export function BotMemoryChip({ changes }: { changes: BotMemoryChange[] | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!changes || changes.length === 0) return null;
  return (
    <div className="self-start text-xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
        onClick={() => setOpen(!open)}
      >
        <BrainIcon className="size-3" />
        {t("bots.memoryUpdated", { count: changes.length })}
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-0.5 rounded-lg border p-2">
          {changes.map((change, index) => {
            const tier = t(tierKeys[change.tier]);
            return (
              <li key={index}>
                {change.kind === "remembered" &&
                  t("bots.memoryRemembered", { text: change.text, tier })}
                {change.kind === "changed" && (
                  <>
                    {t("bots.memoryChangedPrefix")} <s>{change.from}</s> → {change.text} ({tier})
                  </>
                )}
                {change.kind === "forgot" && t("bots.memoryForgot", { text: change.text, tier })}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Keeps a Bot's Conversation fresh when its post-turn memory pass announces changes, so the chip
 * shows without a reload. Renders nothing; place it in the Bot header beside the Memory popover.
 * Without EventSource, the chip shows on reload.
 */
export function BotMemoryLive({ botId }: { botId: string }) {
  const { orpc, eventsUrl } = useChatAdapter();
  const queryClient = useQueryClient();
  const conversationId = useQuery(orpc.bot.get.queryOptions({ input: { botId } })).data
    ?.conversationId;
  useEffect(() => {
    if (!conversationId || typeof EventSource === "undefined") return;
    const source = new EventSource(`${eventsUrl}?conversationId=${conversationId}`);
    source.onmessage = (event: MessageEvent<string>) => {
      let update: Partial<BotMemoryUpdatedEvent>;
      try {
        update = JSON.parse(event.data);
      } catch {
        return;
      }
      if (update.type === "bot_memory_updated") {
        const { queryKey } = orpc.bot.get.queryOptions({ input: { botId } });
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    return () => source.close();
  }, [botId, conversationId, eventsUrl, orpc, queryClient]);
  return null;
}

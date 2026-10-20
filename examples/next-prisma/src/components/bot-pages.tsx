"use client";

import {
  BotCacheChip,
  BotConversation,
  BotsApp,
  BotsHomePage,
} from "@ai-chat/bot-sdk/plugins/bot/ui";
import { BotMemoryChip, BotMemoryLive, BotMemoryPopover } from "@ai-chat/bot-sdk/plugins/memory/ui";
import type { ReactNode } from "react";

/** The full-screen Bots app, outside the assistant's shell (as in apps/web). */
export function BotsFrame({ children }: { children: ReactNode }) {
  return <BotsApp>{children}</BotsApp>;
}

export function BotsHome() {
  return <BotsHomePage />;
}

/** One Bot's Conversation, with the Memory live indicator, popover and per-Turn chips (as in apps/web). */
export function BotRoute({ botId }: { botId: string }) {
  return (
    <BotConversation
      botId={botId}
      headerEnd={
        <>
          <BotMemoryLive botId={botId} />
          <BotMemoryPopover botId={botId} />
        </>
      }
      afterTurn={(turn) => (
        <>
          <BotMemoryChip changes={turn.memoryChanges} />
          <BotCacheChip steps={turn.steps} />
        </>
      )}
    />
  );
}

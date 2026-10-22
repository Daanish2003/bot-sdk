"use client";

import {
  BotCacheChip,
  BotConversation,
  BotsApp,
  BotsHomePage,
} from "@ai-chat/bot-sdk/plugins/bot/ui";
import { KnowledgeChip, KnowledgePopover } from "@ai-chat/bot-sdk/plugins/knowledge/ui";
import { BotMemoryChip, BotMemoryPopover } from "@ai-chat/bot-sdk/plugins/memory/ui";
import { BotSkillChip, BotSkillsPopover } from "@ai-chat/bot-sdk/plugins/skills/ui";
import type { ReactNode } from "react";

/** The full-screen Bots app, outside the assistant's shell (as in apps/web). */
export function BotsFrame({ children }: { children: ReactNode }) {
  return <BotsApp>{children}</BotsApp>;
}

export function BotsHome() {
  return <BotsHomePage />;
}

/** One Bot's Conversation, with the Memory live indicator, Memory, Skills and Knowledge popovers and per-Turn chips (as in apps/web). */
export function BotRoute({ botId }: { botId: string }) {
  return (
    <BotConversation
      botId={botId}
      headerEnd={
        <>
          <BotMemoryPopover botId={botId} />
          <BotSkillsPopover botId={botId} />
          <KnowledgePopover />
        </>
      }
      afterTurn={(turn) => (
        <>
          <BotMemoryChip changes={turn.memoryChanges} />
          <BotSkillChip botId={botId} changes={turn.skillChanges} />
          <KnowledgeChip botId={botId} changes={turn.knowledgeChanges} />
          <BotCacheChip steps={turn.steps} />
        </>
      )}
    />
  );
}

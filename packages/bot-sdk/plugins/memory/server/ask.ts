import { chat, type ModelMessage } from "@tanstack/ai";
import type { z } from "zod";

import { promptCharactersOf, reportedUsageOf } from "../../models/server/run-usage";
import type { BotSdkContext } from "../../../core/server/plugin";
import type { ModelCall } from "../../models/server/credentials/resolve";

/**
 * One call on a Bot's Model for its post-turn pass, recorded against the Quota when it is on Host
 * credentials (ADR 0007).
 */
export async function askBackground(
  deps: BotSdkContext,
  {
    botId,
    plan,
    system,
    user,
  }: { botId: string; plan: { model: string; call: ModelCall }; system: string; user: string },
): Promise<string> {
  const messages: ModelMessage[] = [{ role: "user", content: user }];
  const result = await chat({
    adapter: deps.models.adapterForCall(plan.model, plan.call),
    threadId: botId,
    systemPrompts: [system],
    messages,
    stream: false,
  });
  const reported = reportedUsageOf(result.chunks);
  await plan.call.meter.record({
    kind: "memory",
    usage: deps.models.messageUsage(reported.usage, {
      promptCharacters: promptCharactersOf(messages),
      parts: [{ type: "text", text: result.text }],
    }),
    reportedCost: reported.cost,
  });
  return result.text;
}

/** Parses a Model reply as JSON and validates it with Zod, after stripping code fences. */
export function parseReply<T extends z.ZodType>(schema: T, reply: string): z.infer<T> {
  const json = reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return schema.parse(JSON.parse(json));
}

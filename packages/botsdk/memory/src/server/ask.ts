import { chat, type ModelMessage } from "@tanstack/ai";

import { promptCharactersOf, reportedUsageOf } from "@botsdk/bot/models/internal";
import type { FeatureContext } from "@botsdk/bot/feature";
import type { ModelCall } from "@botsdk/bot/models/internal";

/**
 * One call on a Bot's Model for its post-turn pass, recorded against the Quota when it is on Host
 * credentials (ADR 0007).
 */
export async function askBackground(
  deps: Pick<FeatureContext<"models">, "models">,
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

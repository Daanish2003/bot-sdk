import { describe, expect, it } from "vitest";

import { roomsCases, type Scripts } from "../../src/rooms/cases";
import { type MemberObserved, type Observed, scoreRooms } from "../../src/rooms/score";

/** What a Room run would leave if each Bot played its script as one Message per Turn. */
function observe(members: string[], scripts: Scripts): Observed {
  const observed: MemberObserved[] = members.map((name) => ({
    name,
    turns: (scripts[name] ?? []).length,
    allComplete: true,
    messages: (scripts[name] ?? []).map((step) => String(step.input.text)),
  }));
  const lastBot = observed.filter((m) => m.messages.length > 0).at(-1);
  const mentions = observed.flatMap((m) =>
    m.messages.flatMap((text) => members.filter((n) => n !== m.name && text.includes(`@${n}`))),
  );
  return {
    members: observed,
    agentTriggers: mentions.length,
    maxHops: mentions.length,
    hopLimitSkips: Math.max(0, mentions.length - 3),
    last: lastBot ? { name: lastBot.name, text: lastBot.messages.at(-1)! } : undefined,
  };
}

describe("the Rooms eval's cases", () => {
  it("has unique ids", () => {
    expect(new Set(roomsCases.map((c) => c.id)).size).toBe(roomsCases.length);
  });

  it("passes every case with its good scripts and fails it with its broken ones", () => {
    for (const evalCase of roomsCases) {
      const good = scoreRooms(evalCase.expect, observe(evalCase.members, evalCase.good));
      expect(good.reasons, evalCase.id).toEqual([]);
      const bad = scoreRooms(evalCase.expect, observe(evalCase.members, evalCase.broken));
      expect(bad.passed, evalCase.id).toBe(false);
    }
  });

  it("ignores a Bot mentioning itself", () => {
    const observed: Observed = {
      members: [
        { name: "Forge", turns: 1, allComplete: true, messages: ["It’s done, @Forge."] },
        { name: "Ledger", turns: 0, allComplete: true, messages: [] },
      ],
      agentTriggers: 0,
      maxHops: 0,
      hopLimitSkips: 0,
    };
    expect(scoreRooms({ kind: "answer-alone", bot: "Forge" }, observed).passed).toBe(true);
  });
});

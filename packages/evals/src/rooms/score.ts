// Scores the Rooms eval (spec #1055, ticket #1063) from what a Room's Turns left behind: each
// member's Messages, the Triggers that woke Bots, and how the chain ended. Everything here is
// deterministic; no judge. A Message hands work to a member when it @mentions them (the SDK's own
// `mentionedMembers`). Text is normalised first (curly quotes and dashes made plain).

import { hopLimit, mentionedMembers } from "@botsdk/client/bot/mentions";

import { type Call, sentTexts } from "../channels/score";

export { type Call, sentTexts };

/** What one member did in the Room over the whole run. */
export type MemberObserved = {
  name: string;
  /** Turns the member ran in the Room. */
  turns: number;
  /** Every Turn it ran ended `complete`. */
  allComplete: boolean;
  /** The text of each Message it sent, in order, normalised. */
  messages: string[];
};

/** What a Room's run left behind. */
export type Observed = {
  members: MemberObserved[];
  /** Triggers that carry a handoff (`agent`), whether they ran or were skipped. */
  agentTriggers: number;
  /** The highest hop among them. */
  maxHops: number;
  /** Handoffs kept as skipped because they passed the hop limit. */
  hopLimitSkips: number;
  /** The last Message sent in the Room, by whom. */
  last?: { name: string; text: string };
};

/** What a Room run is expected to do. */
export type Expect =
  /** The task goes to `to` by an @mention, and to none of `others`; `to` then runs. */
  | { kind: "handoff"; to: string; others: string[] }
  /** `bot` answers itself: it sends a Message, mentions no one, and no other member runs. */
  | { kind: "answer-alone"; bot: string }
  /** Nothing to add: the `woken` members each ran a Turn, sent no Message, and handed off to no one. */
  | { kind: "silent"; woken: string[] }
  /** The chain ends: at most `maxHandoffs` handoffs, no hop past the limit, and the last Message mentions no one. */
  | { kind: "chain-ends"; maxHandoffs: number };

export type Score = { passed: boolean; reasons: string[] };

/** The members `text` @mentions, by name as the Room spells it. */
export function mentionsIn(text: string, names: readonly string[]): string[] {
  return mentionedMembers(
    text,
    names.map((name) => ({ botId: name, name })),
  );
}

/** Scores one Room run against its expectation. */
export function scoreRooms(expect: Expect, observed: Observed): Score {
  const reasons: string[] = [];
  const names = observed.members.map((member) => member.name);
  for (const member of observed.members) {
    if (!member.allComplete) reasons.push(`${member.name}'s Turn did not end complete`);
  }
  const member = (name: string) => observed.members.find((m) => m.name === name);
  /** Each Message with the members it mentions other than its author. */
  const handoffs = observed.members.flatMap((m) =>
    m.messages.flatMap((text) =>
      mentionsIn(text, names)
        .filter((name) => name !== m.name)
        .map((to) => ({ from: m.name, to, text })),
    ),
  );

  switch (expect.kind) {
    case "handoff": {
      if (!handoffs.some((h) => h.to === expect.to)) reasons.push(`handed nothing to ${expect.to}`);
      for (const h of handoffs) {
        if (expect.others.includes(h.to)) reasons.push(`${h.from} handed work to ${h.to}`);
      }
      if ((member(expect.to)?.turns ?? 0) === 0) reasons.push(`${expect.to} never ran a Turn`);
      else if (member(expect.to)?.messages.length === 0)
        reasons.push(`${expect.to} sent no Message`);
      break;
    }
    case "answer-alone": {
      if ((member(expect.bot)?.messages.length ?? 0) === 0) {
        reasons.push(`${expect.bot} sent no Message`);
      }
      for (const h of handoffs) reasons.push(`${h.from} mentioned ${h.to}`);
      for (const other of observed.members) {
        if (other.name !== expect.bot && other.turns > 0) reasons.push(`${other.name} ran a Turn`);
      }
      break;
    }
    case "silent": {
      for (const name of expect.woken) {
        if ((member(name)?.turns ?? 0) === 0) reasons.push(`${name} never ran a Turn`);
      }
      for (const m of observed.members) {
        for (const text of m.messages)
          reasons.push(`${m.name} sent a Message: ${text.slice(0, 80)}`);
      }
      for (const h of handoffs) reasons.push(`${h.from} mentioned ${h.to}`);
      break;
    }
    case "chain-ends": {
      if (observed.hopLimitSkips > 0) {
        reasons.push(
          `the chain ran into the hop limit (${hopLimit}): ${observed.hopLimitSkips} skipped`,
        );
      }
      if (handoffs.length > expect.maxHandoffs) {
        reasons.push(`${handoffs.length} handoffs, expected at most ${expect.maxHandoffs}`);
      }
      if (!observed.last) reasons.push("no Message was sent to the user");
      else {
        const author = observed.last.name;
        const left = mentionsIn(observed.last.text, names).filter((n) => n !== author);
        if (left.length > 0) {
          reasons.push(`${author}'s last Message still hands work to ${left.join(", ")}`);
        }
      }
      break;
    }
  }
  return { passed: reasons.length === 0, reasons };
}

/** A run, for the tally. */
export type Run = { caseId: string; gating: boolean; score: Score };

/** Passed over total for the gating runs. */
export function tallyRooms(runs: readonly Run[]) {
  const gating = runs.filter((run) => run.gating);
  return {
    gating: { passed: gating.filter((run) => run.score.passed).length, total: gating.length },
  };
}

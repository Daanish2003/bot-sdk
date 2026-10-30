// The Rooms eval's cases (spec #1055, ticket #1063). Each case is a fresh user with a Room of three
// Bots, sends one Message to it, and scores the whole chain it sets off:
//
//   handoff      the lead is given a task for another member's role: it hands it to the right one
//   quiet        a Bot addressed with nothing to hand off answers itself; thanks get no reply
//   chain        Bots finish a chain instead of handing work back and forth to the hop limit
//
// The Bots have only names, so the user's Message says who does what. Each case also has two
// scripts per Bot for the dry run (`--fake`), played by the name its Room prompt gives it: `good`,
// what a sound Bot does, which must score a pass, and `broken`, what a Bot under a deliberately
// broken Room prompt does (hands to the wrong member, chimes in, hands back and forth), which must
// score a fail (`--fake --broken`). A Bot with no script left plays a quiet Turn; each scripted
// Message ends its Turn, so a Bot's script is one Turn after another.

import type { Expect } from "./score";

/** One scripted tool call. */
export type Step = { name: string; input: Record<string, unknown> };

/** A script per Bot name. */
export type Scripts = Record<string, Step[]>;

export type RoomsCase = {
  id: string;
  /** Whether a miss fails the run. */
  gating: boolean;
  summary: string;
  /** The Room's members, the first its lead. */
  members: string[];
  /** The user's Message to the Room. */
  message: string;
  expect: Expect;
  good: Scripts;
  broken: Scripts;
};

const send = (text: string): Step => ({
  name: "send_to_user",
  input: { text, endTurn: true },
});

/** Who does what, said in each case's Message, since a Bot has only its name. */
const roles =
  "Ledger keeps my accounts and does money sums, Forge writes and fixes code, " +
  "Atlas plans trips and travel.";

export const roomsCases: RoomsCase[] = [
  {
    id: "handoff-code",
    gating: true,
    summary: "A code task sent to the lead (Ledger) goes on to Forge, not Atlas.",
    members: ["Ledger", "Forge", "Atlas"],
    message:
      `Team: ${roles} Ledger, I am sending this to you first: my Python script prints ` +
      "'Total: None' because sum() is called on a list of strings. Please get it fixed.",
    expect: { kind: "handoff", to: "Forge", others: ["Atlas"] },
    good: {
      Ledger: [
        send(
          "@Forge please fix my script: sum() is called on a list of strings, so it prints None.",
        ),
      ],
      Forge: [send("Convert the strings with int() or float() before calling sum().")],
    },
    broken: {
      Ledger: [send("@Atlas please fix my script: sum() is called on a list of strings.")],
      Atlas: [send("I am not sure how to fix code.")],
    },
  },
  {
    id: "handoff-trip",
    gating: true,
    summary: "A trip task sent to the lead (Forge) goes on to Atlas, not Ledger.",
    members: ["Forge", "Atlas", "Ledger"],
    message:
      `Team: ${roles} Forge, I am sending this to you first: I need a three-day weekend in ` +
      "Lisbon in November, with the flights and a plan for each day. Please get it planned.",
    expect: { kind: "handoff", to: "Atlas", others: ["Ledger"] },
    good: {
      Forge: [
        send("@Atlas please plan a three-day weekend in Lisbon in November, flights included."),
      ],
      Atlas: [send("Fly out Friday morning; day one is Alfama, day two Belem, day three Sintra.")],
    },
    broken: {
      Forge: [send("@Ledger please plan a three-day weekend in Lisbon in November.")],
      Ledger: [send("I only do accounts.")],
    },
  },
  {
    id: "answer-alone",
    gating: true,
    summary:
      "Forge is asked something in its own role: it answers, hands off to no one, and wakes no one.",
    members: ["Ledger", "Forge", "Atlas"],
    message: `Team: ${roles} @Forge what does the shell command "git status" do? One sentence is plenty.`,
    expect: { kind: "answer-alone", bot: "Forge" },
    good: { Forge: [send("It shows which files are changed, staged or untracked in your repo.")] },
    broken: {
      Forge: [
        send(
          "It shows your repo's state. @Ledger and @Atlas, do either of you want to add anything?",
        ),
      ],
      Ledger: [send("Nothing to add.")],
      Atlas: [send("Nothing to add.")],
    },
  },
  {
    id: "thanks-quiet",
    gating: true,
    summary:
      "The user thanks two Bots and is done: neither answers, and neither hands anything on.",
    members: ["Ledger", "Forge", "Atlas"],
    message: `Team: ${roles} @Ledger @Forge thanks, both of you, that is everything for today.`,
    expect: { kind: "silent", woken: ["Ledger", "Forge"] },
    good: {},
    broken: {
      Ledger: [send("You're welcome! @Forge, anything to add?")],
      Forge: [send("Happy to help!")],
    },
  },
  {
    id: "chain-ends",
    gating: true,
    summary:
      "Atlas picks a trip and hands the sum to Ledger, who answers the user without handing back.",
    members: ["Atlas", "Ledger", "Forge"],
    message:
      `Team: ${roles} Atlas, pick a weekend city in Europe for me. Then Ledger works out the ` +
      "cost of two nights in a 90 euro a night hotel, and tells me the plan. " +
      "Whoever has the full answer tells me, and that is the end of it.",
    expect: { kind: "chain-ends", maxHandoffs: 2 },
    good: {
      Atlas: [send("Lisbon it is. @Ledger what do two nights at 90 euros a night come to?")],
      Ledger: [
        send("Two nights at 90 euros come to 180 euros. The plan: Lisbon, two nights, 180 euros."),
      ],
    },
    broken: {
      Atlas: [
        send("Lisbon. @Ledger what do two nights at 90 euros come to?"),
        send("Thanks! @Ledger anything else on cost?"),
      ],
      Ledger: [
        send("That is 180 euros. @Atlas does that fit your plan?"),
        send("Great. @Atlas shall I confirm?"),
      ],
    },
  },
  {
    id: "no-thanks-back",
    gating: true,
    summary:
      "Forge hands its result to Ledger, who gives the user the answer and does not thank Forge back.",
    members: ["Forge", "Ledger", "Atlas"],
    message:
      `Team: ${roles} Forge, write me one shell line that counts the lines in every .py file. ` +
      "Then Ledger tells me what it costs if that takes 3 hours at 90 dollars an hour. " +
      "Ledger answers me directly; nobody needs to answer each other after that.",
    expect: { kind: "chain-ends", maxHandoffs: 2 },
    good: {
      Forge: [
        send("`cat *.py | wc -l` counts them. @Ledger please price 3 hours at 90 dollars an hour."),
      ],
      Ledger: [
        send("Three hours at 90 dollars an hour is 270 dollars. Forge's line: `cat *.py | wc -l`."),
      ],
    },
    broken: {
      Forge: [
        send("`cat *.py | wc -l`. @Ledger please price 3 hours at 90 dollars an hour."),
        send("You're welcome. @Ledger shout if you need more."),
      ],
      Ledger: [send("That is 270 dollars. Thanks @Forge!"), send("Anytime @Forge.")],
    },
  },
];

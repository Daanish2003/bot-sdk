/** How an Assignment stands. `done`, `failed` and `cancelled` are its ends. */
export type AssignmentStatus = "open" | "working" | "blocked" | "done" | "failed" | "cancelled";

/** How the id of the Trigger that hands an Assignment to its Bot starts, followed by the Assignment's id. */
export const assignmentTriggerPrefix = "assignment:";

/** Whether an Assignment with `status` has ended. */
export const isEndedAssignment = (status: AssignmentStatus) =>
  status === "done" || status === "failed" || status === "cancelled";

/** What an Assignment's Bot finished it with. */
export type AssignmentResult = {
  outcome: string;
  /** Text that may be shown to a Customer. */
  forCustomer?: string;
  /** An ISO 8601 time the result names, such as when something will happen. */
  when?: string;
};

/** One row of an Assignment's log (spec #1166): a status change and who made it. It never changes. */
export type AssignmentLogEntry = {
  id: string;
  /** The status it moved to, or the one the Assignment had when a note was added. */
  status: AssignmentStatus;
  actor: "bot" | "user" | "system" | "feature";
  /** The Bot that made it, when `actor` is `bot`, `null` once it is gone; or the feature's id. */
  actorName: string | null;
  note: string | null;
  /** The Turn it happened in, when one did. */
  turnId: string | null;
  /** On a row of spend: the model calls of that Turn in a row, the status as it was. */
  calls: number | null;
  /** On a row of spend: what those calls cost, in millionths of a US dollar. */
  costMicros: number | null;
  at: Date;
};

/** Another Assignment that an Assignment is linked to, and the Bot it's handed to. */
export type AssignmentLink = {
  id: string;
  title: string;
  botName: string;
};

/**
 * The budget an Assignment draws from (#1184), its top Assignment's when it has a parent: what has
 * been spent and the limits. Money counts only where a price is known, so the user's own key spends
 * none and only the call limit holds it.
 */
export type AssignmentBudget = {
  calls: number;
  callLimit: number;
  costMicros: number;
  moneyLimitMicros: number;
  /** This Assignment is `blocked` for the owner to raise the limit or cancel it. */
  overBudget: boolean;
};

/** What an Assignment may spend unless the owner raises it: 30 model calls and $1. */
export const defaultAssignmentCallLimit = 30;
export const defaultAssignmentMoneyLimitMicros = 1_000_000;

/** Whether a budget's spend has reached either limit. */
export const isOverBudget = (budget: AssignmentBudget) =>
  budget.calls >= budget.callLimit || budget.costMicros >= budget.moneyLimitMicros;

/** Micros of a US dollar as money, to the cent. */
export const assignmentMoney = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/** An Assignment handed to a Bot, as its owner reads it. */
export type BotAssignment = {
  id: string;
  title: string;
  instructions: string;
  status: AssignmentStatus;
  result: AssignmentResult | null;
  /** The Bot that handed it over; `null` once that Bot is gone, or when a feature did. */
  assignerBotId: string | null;
  /** That Bot's name, or the id of the feature that handed it over. */
  assignerName: string | null;
  /** Whether the assigner's text is a Bot's. A feature's is untrusted, never the user's word. */
  assignerTrusted: boolean;
  /** The Assignment it was split off from. */
  parent: AssignmentLink | null;
  /** The Assignments split off from it, oldest first. */
  children: (AssignmentLink & { status: AssignmentStatus })[];
  budget: AssignmentBudget;
  overdueAt: Date | null;
  createdAt: Date;
  endedAt: Date | null;
  /** The Message its collapsed item follows; `null` when none came before it. */
  afterMessageId: string | null;
  /** Its log, oldest first. */
  log: AssignmentLogEntry[];
};

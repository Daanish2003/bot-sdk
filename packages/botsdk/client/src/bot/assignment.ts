/** How an Assignment stands. `done`, `failed` and `cancelled` are its ends. */
export type AssignmentStatus = "open" | "working" | "blocked" | "done" | "failed" | "cancelled";

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
  overdueAt: Date | null;
  createdAt: Date;
  endedAt: Date | null;
  /** The Message its collapsed item follows; `null` when none came before it. */
  afterMessageId: string | null;
};

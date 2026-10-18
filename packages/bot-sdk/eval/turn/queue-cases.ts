// The step-3 eval cases (spec #510, "Evals: batching and interrupting with a real Model"): each is a
// run of user Messages sent through the real `bot` plugin, with a structural check on the Turns and
// Triggers and a judge check on the Bot's reply.

/** One user Message of a case, and when it is sent. */
export type QueueMessage = {
  text: string;
  /** Sent this long after the previous Message was sent. */
  afterMs?: number;
  /** Sent once the previous Message's Turn has started, so it interrupts that Turn (#500). */
  afterTurnStarts?: true;
};

export type QueueCase = {
  id: "batching" | "interrupting" | "unavailable";
  messages: QueueMessage[];
  /** What the judge checks the reply of the last Turn against. */
  criterion: string;
};

export const queueCases: QueueCase[] = [
  {
    id: "batching",
    messages: [
      { text: "Plan a dinner." },
      { text: "For 4 people.", afterMs: 200 },
      { text: "Vegetarian.", afterMs: 200 },
    ],
    criterion:
      "The user sent three messages in a row: 'Plan a dinner.', 'For 4 people.' and 'Vegetarian.'. " +
      "The reply must cover all three: it plans a dinner, for 4 people, that is vegetarian.",
  },
  {
    id: "interrupting",
    messages: [
      { text: "Plan a trip to Paris" },
      { text: "Actually, make it Rome", afterTurnStarts: true },
    ],
    criterion:
      "The user first asked to plan a trip to Paris, then corrected it: 'Actually, make it Rome'. " +
      "The reply must plan a trip to Rome, and must not plan one to Paris (it may mention Paris only " +
      "to say it was changed).",
  },
  {
    // The Bot has no tool for booking: a refusal or a question must still reach the user, so it goes
    // through SendToUser, not plain text (#516).
    id: "unavailable",
    messages: [{ text: "Book the meeting for Thursday" }],
    criterion:
      "The user asked the assistant to book a meeting for Thursday, which it cannot do. The reply " +
      "must either say it cannot book meetings or ask the user for details (such as the time or " +
      "who to invite). It must not say the meeting is booked.",
  },
];

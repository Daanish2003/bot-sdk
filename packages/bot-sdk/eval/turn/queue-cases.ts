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

/** The cases of one Message the Bot cannot do or cannot understand: it must still reply (#516, #531). */
export const refusalCaseIds = ["unavailable", "no-email", "unclear", "no-live-data"] as const;
export type RefusalCaseId = (typeof refusalCaseIds)[number];

export type QueueCase = {
  id: "batching" | "interrupting" | RefusalCaseId;
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
  // The three below are #531's: a refusal or a question the Model once wrote as plain text.
  {
    id: "no-email",
    messages: [{ text: "Send this summary to my boss" }],
    criterion:
      "The user asked the assistant to send a summary to their boss, but it cannot send email. The " +
      "reply must say it cannot send email (it may offer to help write the summary, or ask what to " +
      "send), and must not claim it sent anything.",
  },
  {
    id: "unclear",
    messages: [{ text: "Fix it" }],
    criterion:
      "The user wrote only 'Fix it', with no earlier context. The reply must ask what 'it' is, or " +
      "otherwise ask what needs fixing.",
  },
  {
    id: "no-live-data",
    messages: [{ text: "What's the weather in Delhi right now?" }],
    criterion:
      "The user asked for the weather in Delhi right now, but the assistant has no live data. The " +
      "reply must say it has no live or current weather data, and must not make up a current " +
      "forecast or temperature (it may describe typical weather or point to a weather service).",
  },
];

/** How a Check-in stands: `pending` until it fires once or is cancelled. */
export type CheckInState = "pending" | "fired" | "cancelled";

/** A Check-in as the client sees it. `afterMessageId` is the Message its inline line follows. */
export type BotCheckIn = {
  id: string;
  at: Date;
  note: string;
  state: CheckInState;
  createdAt: Date;
  afterMessageId: string | null;
};

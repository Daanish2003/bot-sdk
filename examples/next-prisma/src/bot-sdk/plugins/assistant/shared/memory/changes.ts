/**
 * One change a turn made to the user's Memories, as the reply's "Memory updated" chip lists it
 * (#290). `forgot` has no id: the Memory is gone.
 */
export type TurnChange =
  | { kind: "added"; memoryId: string; text: string }
  | { kind: "updated"; memoryId: string; from: string; text: string }
  | { kind: "forgot"; text: string };

/** The event a Memory job publishes when its turn changed the user's Memories (#290). */
export type MemoryUpdatedEvent = {
  type: "memory_updated";
  /** The reply whose Run the Memories were made from. */
  messageId: string;
  changes: TurnChange[];
};

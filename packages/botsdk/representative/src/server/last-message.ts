import { type AnyColumn, ne, sql } from "drizzle-orm";

import { representativeThread, representativeThreadMessage } from "./db/schema";

/** `column` of a thread's last message, a note aside. */
export const lastMessageQuery = (column: AnyColumn) =>
  sql`select ${column} from ${representativeThreadMessage} where ${representativeThreadMessage.threadId} = ${representativeThread.id} and ${ne(representativeThreadMessage.author, "note")} order by ${representativeThreadMessage.position} desc limit 1`;

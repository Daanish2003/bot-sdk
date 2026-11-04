import { pageUrgencies } from "@botsdk/client/bot/pages";
import { index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { botsdkSchema } from "../botsdk-schema";

/** How urgent a Page is (ticket #1300). */
export const pageUrgency = botsdkSchema.enum("page_urgency", pageUrgencies);

/**
 * A Page (ticket #1300, spec #1171): a direct alert to a user outside the app, with no Conversation
 * of its own. Each records its cause and urgency, and stops sending once acknowledged.
 */
export const page = botsdkSchema.table(
  "page",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    /** The Host's user id, with no foreign key, as everywhere in the `botsdk` schema. */
    userId: text("user_id").notNull(),
    /** What raised it, in the words of whoever raised it, such as `assignment_overdue`. */
    cause: text("cause").notNull(),
    urgency: pageUrgency("urgency").notNull(),
    title: text("title").notNull(),
    text: text("text").notNull(),
    /** Where in the Host app it leads. */
    path: text("path").notNull(),
    createdAt: timestamp("created_at").notNull(),
    acknowledgedAt: timestamp("acknowledged_at"),
  },
  (table) => [index("page_user_id_created_at_idx").on(table.userId, table.createdAt)],
);

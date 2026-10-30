import { text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { botsdkSchema } from "../botsdk-schema";

/**
 * A Linked identity (spec #1044, ADR 0033): the platform account a user proved is theirs, by
 * sending a link code to one of their Bots. All the user's Bots know it. One per user and
 * platform, and one platform account belongs to one user. Deleted with the user.
 */
export const linkedIdentity = botsdkSchema.table(
  "linked_identity",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    /** The Host's user id, with no foreign key, as everywhere in the `botsdk` schema. */
    userId: text("user_id").notNull(),
    /** The messaging adapter's id, such as `telegram`. */
    platform: text("platform").notNull(),
    /** The platform's id of the account (Telegram's user id). */
    platformUserId: text("platform_user_id").notNull(),
    /** The account's display handle when it was linked, such as `@ada`. */
    handle: text("handle").notNull(),
    /** The platform's workspace or team id; null on a platform with none, such as Telegram. */
    workspaceId: text("workspace_id"),
    linkedAt: timestamp("linked_at").notNull(),
  },
  (table) => [
    unique("linked_identity_user_platform_unique").on(table.userId, table.platform),
    unique("linked_identity_platform_account_unique")
      .on(table.platform, table.workspaceId, table.platformUserId)
      .nullsNotDistinct(),
  ],
);

/**
 * A user's live link code (spec #1044): a hash of the 6-digit code and when it expires. One per
 * user, so a new code replaces the old one; spent by deleting it. Deleted with the user.
 */
export const linkCode = botsdkSchema.table("link_code", {
  /** The Host's user id, with no foreign key. */
  userId: text("user_id").primaryKey(),
  /** SHA-256 of the code, hex. Unique, so a code names one user. */
  codeHash: text("code_hash").notNull().unique("link_code_hash_unique"),
  expiresAt: timestamp("expires_at").notNull(),
});

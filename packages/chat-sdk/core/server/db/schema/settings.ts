import { text } from "drizzle-orm/pg-core";

import { chatSchema } from "./chat-schema";

/** A user's settings; a user without a row has the defaults. */
export const userSettings = chatSchema.table("user_settings", {
  /** The Host's user id, with no foreign key. */
  userId: text("user_id").primaryKey(),
  /** The `"provider:model"` that writes titles; `null` means the Model that wrote the first reply. */
  titleModel: text("title_model"),
  /** The user's Instructions, sent with every Run; `null` means none. */
  instructions: text("instructions"),
});

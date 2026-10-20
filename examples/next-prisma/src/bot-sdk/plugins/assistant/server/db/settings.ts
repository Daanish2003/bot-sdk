import { text } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";

/** A user's settings; a user without a row has the defaults. */
export const userSettings = chatSchema.table("user_settings", {
  /** The Host's user id, with no foreign key. */
  userId: text("user_id").primaryKey(),
  /** The `"provider:model"` that writes titles; `null` means the Model that wrote the first reply. */
  backgroundModel: text("background_model"),
  /** The `"provider:model"` Generated images are made with; `null` means the Host's default (spec #278). */
  imageModel: text("image_model"),
  /** The user's Instructions, sent with every Run; `null` means none. */
  instructions: text("instructions"),
});

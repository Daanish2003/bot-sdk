import { text, timestamp } from "drizzle-orm/pg-core";

import { chatSchema } from "../../../../core/server/db/chat-schema";

/** A user's Model settings; a user without a row has the defaults (spec #801). */
export const modelSettings = chatSchema.table("model_settings", {
  /** The Host's user id, with no foreign key. */
  userId: text("user_id").primaryKey(),
  /** The `"provider:model"` Generated images are made with; `null` means the Host's default (spec #278). */
  imageModel: text("image_model"),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

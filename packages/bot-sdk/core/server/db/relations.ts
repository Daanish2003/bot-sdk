import { defineRelations } from "drizzle-orm";

import * as chatSchema from "./schema";

export const relations = defineRelations(chatSchema);

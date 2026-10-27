import { defineRelations } from "drizzle-orm";

import * as botsdkSchema from "./schema";

export const relations = defineRelations(botsdkSchema);

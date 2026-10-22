import { z } from "zod";

import { textPartSchema } from "../../../core/shared/message-parts";
import { demonstrationCardSchema } from "./demonstration";
import { choiceControlSchema } from "./choice";
import { filesControlSchema } from "./files";
import { computerCardSchema } from "./helper";
import { reviewApprovalSchema } from "./review";
import { routineApprovalSchema } from "./routine";
import { secretRequestSchema } from "./secret";

/**
 * A kind reserved in the catalog and not built yet (spec #761): only its `kind` is fixed, so the
 * fields it gets later don't break the format. Nothing renders it.
 */
const reservedControlSchema = <Kind extends string>(kind: Kind) =>
  z.looseObject({ kind: z.literal(kind) });

/**
 * The Rich control catalog (spec #761, #754): every purpose-built control a Bot's Message can
 * carry, as one union on `kind`. `draft` and `payment_approval` are reserved.
 */
export const richControlSchema = z.discriminatedUnion("kind", [
  secretRequestSchema,
  computerCardSchema,
  demonstrationCardSchema,
  filesControlSchema,
  choiceControlSchema,
  routineApprovalSchema,
  reviewApprovalSchema,
  reservedControlSchema("draft"),
  reservedControlSchema("payment_approval"),
]);

export type RichControl = z.infer<typeof richControlSchema>;

export type RichControlKind = RichControl["kind"];

/**
 * Whether a control of `kind` is an Approval: the system asking the user, not a bubble the
 * Bot sent (spec #761): none shows it, and it doesn't count as the Bot sending.
 */
export const isApproval = (kind: RichControlKind | undefined) =>
  kind === "routine_approval" || kind === "review_approval";

/**
 * The catalog as JSON Schema, for a Host's own app to render it. It can't carry the Zod checks
 * that aren't shapes, such as a Secret's reserved names: `richControlSchema` is the full check.
 */
export const richControlJsonSchema = z.toJSONSchema(richControlSchema);

/** A Message's stored part that holds its Rich control. */
export const controlPartSchema = z.object({
  type: z.literal("control"),
  control: richControlSchema,
});

/**
 * A Bot Message's stored parts: its text, then at most one Rich control. Text is what every
 * Channel can show.
 */
export const botMessagePartsSchema = z.object({
  schemaVersion: z.literal(1),
  parts: z
    .array(z.union([textPartSchema, controlPartSchema]))
    .refine((parts) => parts.filter((part) => part.type === "control").length <= 1, {
      error: "A Message has at most one Rich control",
    }),
});
